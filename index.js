const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason,
    fetchLatestBaileysVersion // <-- إضافة جلب أحدث إصدار
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

// API لبدء جلسة جديدة يدوياً إن أردت
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

async function startWhatsAppSession(sessionId = 'default') {
    const authPath = `auth_info_baileys_${sessionId}`;
    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    
    // جلب أحدث إصدار متوافق من واتساب ويب حل لمشكلة 405
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`ℹ️ تشغيل واتساب بـ Version: ${version.join('.')} (Is Latest: ${isLatest})`);

    const logger = P({ level: 'silent' });
    
    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true, 
        logger,
        browser: ['Mac OS', 'Chrome', '120.0.0.0'], // التعديل هنا مهم لمنع حظر Render
        syncFullHistory: false
    });

    sessions[sessionId] = { sock, status: 'connecting' };

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        // في حالة وجود QR جديد (الجلسة غير مربوطة)
        if (qr) {
            console.log(`\n📲 [${sessionId}] تم توليد QR code جديد! يمكنك مسحه الآن.`);
            const qrImage = await qrcode.toDataURL(qr);
            io.emit('qr', { sessionId, qrImage, qrRaw: qr });
            if (sessions[sessionId]) sessions[sessionId].status = 'qr_received';
        }

        if (connection === 'close') {
            let reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            console.log(`❌ الاتصال مقفول لجلسة [${sessionId}]. السبب: ${reason}`);
            
            // التعامل مع الأخطاء وتجنب الـ Infinite Loop على Render
            if (reason === DisconnectReason.loggedOut || reason === 401 || reason === 403 || reason === 405) {
                console.log(`🧹 مسح ملفات الجلسة المنتهية [${sessionId}]...`);
                if (fs.existsSync(authPath)) {
                    fs.rmSync(authPath, { recursive: true, force: true });
                }
                delete sessions[sessionId];
                io.emit('status', { sessionId, status: 'logged_out' });
                
                // إعادة المحاولة بعد 5 ثوانٍ
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
            console.log(`👤 الحساب: ${sock.user?.name || sock.user?.id}`);
            
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

app.post('/send-message', async (req, res) => {
    const { sessionId = 'default', number, message } = req.body;

    if (!number || !message) {
        return res.status(400).json({ error: 'Number and message are required' });
    }

    const session = sessions[sessionId];
    if (!session || !session.sock || session.status !== 'connected') {
        return res.status(400).json({ error: `Session ${sessionId} is not connected.` });
    }

    try {
        let cleanNumber = number.replace(/[^0-9]/g, '');
        const jid = cleanNumber.includes('@s.whatsapp.net') ? cleanNumber : `${cleanNumber}@s.whatsapp.net`;
        
        await session.sock.sendMessage(jid, { text: message });
        res.json({ success: true, sessionId });
    } catch (err) {
        console.error(`Error sending message:`, err);
        res.status(500).json({ error: err.message });
    }
});

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
            let cleanNumber = number.toString().replace(/[^0-9]/g, '');
            const jid = cleanNumber.includes('@s.whatsapp.net') ? cleanNumber : `${cleanNumber}@s.whatsapp.net`;
            
            await session.sock.sendMessage(jid, { text: message });
            console.log(`✅ Campaign: Message sent to ${cleanNumber}`);
            
            await new Promise(resolve => setTimeout(resolve, delay));
        } catch (err) {
            console.error(`❌ Campaign: Error sending to ${number}:`, err.message);
        }
    }
});

// استعادة الجلسات المخزنة أو البدء بجلسة default تلقائياً
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

server.listen(port, () => {
    console.log(` Server is running on port ${port}`);
    checkAndInitSessions();
});
