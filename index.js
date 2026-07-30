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

// منع السيرفر من إنه يعمل Crash مهما حصلت أخطاء
process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
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

app.get('/session/:sessionId/status', (req, res) => {
    const { sessionId } = req.params;
    if (sessions[sessionId]) {
        res.json({ status: sessions[sessionId].status, user: sessions[sessionId].sock?.user });
    } else {
        res.json({ status: 'offline' });
    }
});

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

// 🟢 API فحص صحة الجلسات ونسبة الخطر
app.get('/sessions/health', (req, res) => {
    const sessionKeys = Object.keys(sessions);
    if (sessionKeys.length === 0) {
        return res.json([{ sessionId: "default", sendAttempts: 0, disconnectEvents: 0, currentStatus: "offline", banRiskPercentage: "0%" }]);
    }
    const healthData = sessionKeys.map(sessionId => {
        const session = sessions[sessionId];
        let sendAttempts = session.sendAttempts || 0;
        let disconnects = session.confirmedBanEvents || 0;
        let riskPercentage = 0;
        if (disconnects > 0) riskPercentage += disconnects * 30; 
        if (sendAttempts > 50) riskPercentage += 10;
        if (sendAttempts > 200) riskPercentage += 20;
        if (riskPercentage > 100) riskPercentage = 100;
        return {
            sessionId: sessionId,
            currentStatus: session.status || 'offline',
            sendAttempts: sendAttempts,
            disconnectEvents: disconnects,
            banRiskPercentage: `${riskPercentage}%`
        };
    });
    res.json(healthData);
});

async function startWhatsAppSession(sessionId = 'default') {
    if (sessions[sessionId] && sessions[sessionId].sock) {
        try {
            sessions[sessionId].sock.ev.removeAllListeners();
            sessions[sessionId].sock.ws?.close();
        } catch (e) {}
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
        browser: ['Ubuntu', 'Chrome', '20.0.04'], // 🔴 رجعنا البصمة ضروري جداً عشان واتساب ميقفلش الجلسة أول ما نبعت
        syncFullHistory: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 15000,
        markOnlineOnConnect: true,
        generateHighQualityLinkPreview: true
    });

    sessions[sessionId] = { 
        sock, 
        status: 'connecting',
        sendAttempts: sessions[sessionId]?.sendAttempts || 0,
        confirmedBanEvents: sessions[sessionId]?.confirmedBanEvents || 0,
        banSignals: sessions[sessionId]?.banSignals || []
    };

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log(`\n📲 [${sessionId}] تم توليد QR code جديد!`);
            try {
                const qrImage = await qrcode.toDataURL(qr);
                io.emit('qr', { sessionId, qrImage, qrRaw: qr });
                if (sessions[sessionId]) sessions[sessionId].status = 'qr_received';
            } catch (err) {}
        }

        if (connection === 'close') {
            let reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            console.log(`❌ الاتصال مقفول لجلسة [${sessionId}]. السبب: ${reason || 'غير معروف'}`);
            
            if (reason === DisconnectReason.loggedOut) {
                console.log(`🧹 مسح ملفات الجلسة المنتهية [${sessionId}]...`);
                if (sessions[sessionId]) {
                    sessions[sessionId].confirmedBanEvents = (sessions[sessionId].confirmedBanEvents || 0) + 1;
                }
                if (fs.existsSync(authPath)) {
                    fs.rmSync(authPath, { recursive: true, force: true });
                }
                delete sessions[sessionId];
                io.emit('status', { sessionId, status: 'logged_out' });
            } else {
                if (sessions[sessionId]) sessions[sessionId].status = 'reconnecting';
                io.emit('status', { sessionId, status: 'reconnecting' });
                setTimeout(() => startWhatsAppSession(sessionId), 5000);
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
    return sock;
}

// 🛠️ دالة تحويل الرقم وإصلاح صيغة الأرقام المصرية تلقائياً
function getSanitizedJid(number) {
    let cleanNumber = number.toString().replace(/[^0-9]/g, '');
    if (cleanNumber.startsWith('0') && cleanNumber.length === 11) {
        cleanNumber = '20' + cleanNumber.substring(1); 
    }
    return `${cleanNumber}@s.whatsapp.net`;
}

// 🎭 محاكاة سريعة للكتابة
async function simulateHumanTyping(sock, jid) {
    try {
        await sock.sendPresenceUpdate('composing', jid);
        await new Promise(r => setTimeout(r, 2000));
        await sock.sendPresenceUpdate('paused', jid);
    } catch (e) {
        console.warn("Typing simulation error:", e.message);
    }
}

app.post('/send-message', async (req, res) => {
    const { sessionId = 'default', number, message, showTyping = true } = req.body;
    if (!number || !message) return res.status(400).json({ error: 'Number and message are required' });

    let session = sessions[sessionId];
    if (!session || !session.sock || session.status !== 'connected') {
        return res.status(503).json({ error: `Session disconnected.` });
    }

    try {
        session.sendAttempts = (session.sendAttempts || 0) + 1;
        const jid = getSanitizedJid(number);

        if (showTyping) await simulateHumanTyping(session.sock, jid);

        await session.sock.sendMessage(jid, { text: message });
        console.log(`✅ Message sent to ${jid}`);
        res.json({ success: true, sessionId, sentTo: jid });
    } catch (err) {
        console.error(`❌ Error sending message:`, err.message);
        res.status(500).json({ error: 'Failed to send message.' });
    }
});

app.post('/send-campaign', async (req, res) => {
    const { sessionId = 'default', numbers, message, delay = 15000, showTyping = true } = req.body;
    if (!numbers || !Array.isArray(numbers) || !message) return res.status(400).json({ error: 'Numbers array and message are required' });

    const session = sessions[sessionId];
    if (!session || !session.sock || session.status !== 'connected') {
        return res.status(400).json({ error: `Session ${sessionId} is not connected.` });
    }

    // إرسال الرد للواجهة فوراً عشان الواجهة متعلقش
    res.json({ success: true, message: 'Campaign started in background', total: numbers.length });

    console.log(`🚀 Starting campaign to ${numbers.length} numbers on session [${sessionId}]`);
    
    // تشغيل الحملة في الخلفية بهدوء وبدون ضغط
    (async () => {
        for (const number of numbers) {
            try {
                if (!sessions[sessionId] || sessions[sessionId].status !== 'connected') {
                    console.log(`⚠️ Session offline, pausing campaign...`);
                    await new Promise(r => setTimeout(r, 10000));
                    continue;
                }

                sessions[sessionId].sendAttempts = (sessions[sessionId].sendAttempts || 0) + 1;
                const jid = getSanitizedJid(number);
                
                if (showTyping) {
                    await simulateHumanTyping(sessions[sessionId].sock, jid);
                }

                await sessions[sessionId].sock.sendMessage(jid, { text: message });
                console.log(`✅ Campaign: Message sent to ${jid}`);
                
                const randomDelay = delay + Math.floor(Math.random() * 8000);
                await new Promise(resolve => setTimeout(resolve, randomDelay));
            } catch (err) {
                console.error(`❌ Campaign: Error sending to ${number}:`, err.message);
                await new Promise(r => setTimeout(r, 5000));
            }
        }
    })();
});

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
    } catch (err) {}
};

// 🟢 منع السيرفر من النوم
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_EXTERNAL_URL) {
    setInterval(() => {
        http.get(RENDER_EXTERNAL_URL, (res) => {}).on('error', (err) => {});
    }, 5 * 60 * 1000);
}

server.listen(port, () => {
    console.log(`🚀 Server is running on port ${port}`);
    checkAndInitSessions();
});
