const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason,
    fetchLatestBaileysVersion 
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const P = require("pino");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const qrcode = require("qrcode");
const path = require("path");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = process.env.PORT || 3000;

app.use(express.json());

const sessions = {};

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 🟢 بدء أو فحص الجلسة
app.post('/session/start', async (req, res) => {
    const { sessionId = 'default' } = req.body;
    if (sessions[sessionId] && sessions[sessionId].status === 'connected') {
        return res.status(200).json({ status: 'already_connected', user: sessions[sessionId].sock?.user });
    }
    try {
        await startWhatsAppSession(sessionId);
        res.json({ success: true, message: `Session ${sessionId} check/start initiated.` });
    } catch (error) {
        console.error(`Error starting session ${sessionId}:`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 🟢 معرفة حالة جلسة واحدة
app.get('/session/:sessionId/status', (req, res) => {
    const { sessionId } = req.params;
    if (sessions[sessionId]) {
        res.json({ status: sessions[sessionId].status, user: sessions[sessionId].sock?.user });
    } else {
        res.json({ status: 'offline' });
    }
});

// 🟢 معرفة حالة كل الجلسات
app.get('/sessions', (req, res) => {
    const sessionStatus = {};
    for (const id in sessions) {
        sessionStatus[id] = {
            status: sessions[id].status,
            user: sessions[id].sock?.user
        };
    }
    res.json(sessionStatus);
});

// 🟢 API فحص صحة الجلسات ونسبة الحظر لـ Replit Agent (معدل لمعالجة خطأ غير متصل)
app.get('/sessions/health', (req, res) => {
    const sessionKeys = Object.keys(sessions);

    // إذا لم تكن هناك جلسات ممررة بعد، يتم إرجاع جلسة افتراضية لمنع توقف Replit Agent
    if (sessionKeys.length === 0) {
        return res.json([{
            sessionId: "default",
            sendAttempts: 0,
            confirmedBanEvents: 0,
            currentStatus: "offline",
            banSignals: []
        }]);
    }

    const healthData = sessionKeys.map(sessionId => {
        const session = sessions[sessionId];
        return {
            sessionId: sessionId,
            sendAttempts: session.sendAttempts || 0,
            confirmedBanEvents: session.confirmedBanEvents || 0,
            currentStatus: session.status || 'offline',
            banSignals: session.banSignals || []
        };
    });

    res.json(healthData);
});

async function startWhatsAppSession(sessionId = 'default') {
    // إغلاق السوكيت القديم إن وجد لمنع التضارب
    if (sessions[sessionId] && sessions[sessionId].sock) {
        try {
            sessions[sessionId].sock.ev.removeAllListeners();
            sessions[sessionId].sock.ws?.close();
        } catch (e) {
            // ignore cleanup errors
        }
    }

    const authPath = `auth_info_baileys_${sessionId}`;
    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`ℹ️ تشغيل واتساب بـ Version: ${version.join('.')} (Is Latest: ${isLatest})`);

    const logger = P({ level: 'silent' });
    
    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true, 
        logger,
        browser: ['Mac OS', 'Chrome', '120.0.0.0'],
        syncFullHistory: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000, // لمنع المهلة (Timeouts) أثناء الإرسال
        keepAliveIntervalMs: 10000    // الحفاظ على حيوية الـ WebSocket
    });

    // الحفاظ على الإحصائيات السابقة إن وجدت
    const existingSendAttempts = sessions[sessionId]?.sendAttempts || 0;
    const existingBanEvents = sessions[sessionId]?.confirmedBanEvents || 0;
    const existingBanSignals = sessions[sessionId]?.banSignals || [];

    sessions[sessionId] = { 
        sock, 
        status: 'connecting',
        sendAttempts: existingSendAttempts,
        confirmedBanEvents: existingBanEvents,
        banSignals: existingBanSignals
    };

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log(`\n📲 [${sessionId}] تم توليد QR code جديد!`);
            try {
                const qrImage = await qrcode.toDataURL(qr);
                io.emit('qr', { sessionId, qrImage, qrRaw: qr });
                if (sessions[sessionId]) sessions[sessionId].status = 'qr_received';
            } catch (err) {
                console.error("Error generating QR:", err);
            }
        }

        if (connection === 'close') {
            let reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            console.log(`❌ الاتصال مقفول لجلسة [${sessionId}]. السبب: ${reason}`);
            
            if (reason === DisconnectReason.loggedOut || reason === 401 || reason === 403 || reason === 405) {
                console.log(`🧹 مسح ملفات الجلسة المنتهية [${sessionId}]...`);
                
                if (sessions[sessionId]) {
                    sessions[sessionId].confirmedBanEvents = (sessions[sessionId].confirmedBanEvents || 0) + 1;
                    sessions[sessionId].banSignals.push({
                        time: new Date().toISOString(),
                        reason: `Logged out or banned (code: ${reason})`
                    });
                }

                if (fs.existsSync(authPath)) {
                    fs.rmSync(authPath, { recursive: true, force: true });
                }
                delete sessions[sessionId];
                io.emit('status', { sessionId, status: 'logged_out' });
                
                setTimeout(() => startWhatsAppSession(sessionId), 5000);
            } else {
                if (sessions[sessionId]) sessions[sessionId].status = 'reconnecting';
                io.emit('status', { sessionId, status: 'reconnecting' });
                setTimeout(async () => {
                    await startWhatsAppSession(sessionId);
                }, 5000);
            }
        } else if (connection === 'open') {
            console.log(`\n✅ الجلسة متصلة وجاهزة! [${sessionId}]`);
            
            if (sessions[sessionId]) {
                sessions[sessionId].status = 'connected';
                sessions[sessionId].sock = sock;
            }
            io.emit('status', { sessionId, status: 'connected', user: sock.user });
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;
            const from = msg.key.remoteJid;
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
            console.log(`📩 رسالة جديدة من [${from}]: ${text}`);
        }
    });

    return sock;
}

// 🛠️ دالة مساعدة لتحويل وتأكيد رقم الواتساب (JID)
async function getSanitizedJid(sock, number) {
    let cleanNumber = number.toString().replace(/[^0-9]/g, '');
    
    try {
        const [result] = await sock.onWhatsApp(cleanNumber);
        if (result && result.exists) {
            return result.jid;
        }
    } catch (e) {
        console.warn(`onWhatsApp check failed for ${cleanNumber}, using fallback format.`);
    }
    
    return `${cleanNumber}@s.whatsapp.net`;
}

// 🟢 API لتحديث حالة "يكتب الآن" أو "تسجيل صوتي"
app.post('/presence', async (req, res) => {
    const { sessionId = 'default', number, presence = 'composing' } = req.body;

    if (!number) {
        return res.status(400).json({ error: 'Phone number is required' });
    }

    const session = sessions[sessionId];
    if (!session || !session.sock || session.status !== 'connected') {
        return res.status(400).json({ error: `Session ${sessionId} is not connected.` });
    }

    try {
        const jid = await getSanitizedJid(session.sock, number);
        await session.sock.sendPresenceUpdate(presence, jid);
        res.json({ success: true, sessionId, jid, presence });
    } catch (err) {
        console.error(`Error updating presence:`, err);
        res.status(500).json({ error: err.message });
    }
});

// 🟢 إرسال رسالة فردية (مع دعم إعادة الاتصال التلقائي)
app.post('/send-message', async (req, res) => {
    const { sessionId = 'default', number, message, showTyping = true } = req.body;

    if (!number || !message) {
        return res.status(400).json({ error: 'Number and message are required' });
    }

    let session = sessions[sessionId];

    if (!session || !session.sock || session.status !== 'connected') {
        console.log(`⚠️ الجلسة ${sessionId} غير متصلة أثناء محاولة الإرسال، جاري إعادة الاتصال...`);
        startWhatsAppSession(sessionId);
        return res.status(503).json({ error: `Session ${sessionId} was disconnected. Reconnecting... Please try again in 5 seconds.` });
    }

    try {
        session.sendAttempts = (session.sendAttempts || 0) + 1;
        const jid = await getSanitizedJid(session.sock, number);

        if (showTyping) {
            try {
                await session.sock.sendPresenceUpdate('composing', jid);
                await new Promise(resolve => setTimeout(resolve, 1500));
                await session.sock.sendPresenceUpdate('paused', jid);
            } catch (pErr) {
                console.warn("Typing presence skipped due to minor error:", pErr.message);
            }
        }

        await session.sock.sendMessage(jid, { text: message });
        res.json({ success: true, sessionId, sentTo: jid });
    } catch (err) {
        console.error(`❌ Error sending message:`, err.message);
        
        if (sessions[sessionId]) sessions[sessionId].status = 'disconnected';
        startWhatsAppSession(sessionId);

        res.status(500).json({ error: 'Failed to send message. Connection was lost and is now reconnecting.' });
    }
});

// 🟢 إرسال الحملات الإعلانية
app.post('/send-campaign', async (req, res) => {
    const { sessionId = 'default', numbers, message, delay = 5000 } = req.body;

    if (!numbers || !Array.isArray(numbers) || !message) {
        return res.status(400).json({ error: 'Numbers array and message are required' });
    }

    const session = sessions[sessionId];
    if (!session || !session.sock || session.status !== 'connected') {
        return res.status(400).json({ error: `Session ${sessionId} is not connected.` });
    }

    res.json({ success: true, message: 'Campaign started', total: numbers.length });

    for (const number of numbers) {
        try {
            session.sendAttempts = (session.sendAttempts || 0) + 1;
            const jid = await getSanitizedJid(session.sock, number);
            
            try {
                await session.sock.sendPresenceUpdate('composing', jid);
                await new Promise(resolve => setTimeout(resolve, 1500));
                await session.sock.sendPresenceUpdate('paused', jid);
            } catch (e) {
                // Ignore presence errors in campaign loop
            }

            await session.sock.sendMessage(jid, { text: message });
            console.log(`✅ Campaign: Message sent to ${jid}`);
            
            await new Promise(resolve => setTimeout(resolve, delay));
        } catch (err) {
            console.error(`❌ Campaign: Error sending to ${number}:`, err.message);
        }
    }
});

// 🟢 استعادة الجلسات تلقائياً عند التشغيل
const checkAndInitSessions = async () => {
    try {
        const files = fs.readdirSync(__dirname);
        const authFolders = files.filter(file => file.startsWith('auth_info_baileys_'));

        if (authFolders.length > 0) {
            for (const folder of authFolders) {
                const actualSessionId = folder.replace('auth_info_baileys_', '');
                console.log(`🔄 جاري استعادة الجلسة [${actualSessionId}]...`);
                await startWhatsAppSession(actualSessionId);
            }
        } else {
            console.log(`🚀 البدء التلقائي للجلسة الافتراضية [default]...`);
            await startWhatsAppSession('default');
        }
    } catch (err) {
        console.error('خطأ أثناء استعادة الجلسات:', err);
    }
};

// 🟢 منع Render من النوم (Self Ping كل 5 دقائق)
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_EXTERNAL_URL) {
    setInterval(() => {
        http.get(RENDER_EXTERNAL_URL, (res) => {
            console.log(`⏰ Self-ping successful: ${res.statusCode}`);
        }).on('error', (err) => {
            console.error('❌ Self-ping error:', err.message);
        });
    }, 5 * 60 * 1000);
}

server.listen(port, () => {
    console.log(`🚀 Server is running on port ${port}`);
    checkAndInitSessions();
});
