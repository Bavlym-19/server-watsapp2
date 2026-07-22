// التعديل هنا: غيرنا الاستدعاء ليطابق المكتبة الحديثة المثبتة عندك
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason 
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

app.post('/session/start', async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) {
        return res.status(400).json({ error: 'Session ID is required.' });
    }
    if (sessions[sessionId] && sessions[sessionId].sock && sessions[sessionId].sock.user) {
        return res.status(200).json({ status: 'already_connected', user: sessions[sessionId].sock.user });
    }
    try {
        await startWhatsAppSession(sessionId);
        res.json({ success: true, message: `Session ${sessionId} started.` });
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

async function startWhatsAppSession(sessionId) {
    const authPath = `auth_info_baileys_${sessionId}`;
    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    
    const logger = P({ level: 'silent' });
    
    // استخدام الإعدادات الحديثة المتوافقة مع الـ package.json بتاعك
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger,
        browser: ['Chrome', 'Ubuntu', '1.0']
    });

    sessions[sessionId] = { sock, status: 'connecting' };

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            const qrImage = await qrcode.toDataURL(qr);
            io.emit('qr', { sessionId, qrImage });
            if (sessions[sessionId]) sessions[sessionId].status = 'qr_received';
        }

        if (connection === 'close') {
            let reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            console.log(`❌ الاتصال مقفول لجلسة [${sessionId}]. السبب: ${reason}`);
            
            if (reason === DisconnectReason.loggedOut || reason === 401 || reason === 403) {
                if (fs.existsSync(authPath)) {
                    fs.rmSync(authPath, { recursive: true, force: true });
                }
                delete sessions[sessionId];
                io.emit('status', { sessionId, status: 'logged_out' });
            } else {
                if (sessions[sessionId]) sessions[sessionId].status = 'reconnecting';
                io.emit('status', { sessionId, status: 'reconnecting' });
                setTimeout(async () => {
                    await startWhatsAppSession(sessionId);
                }, 5000);
            }
        } else if (connection === 'open') {
            console.log(`✅ الجلسة متصلة وجاهزة: [${sessionId}]`);
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
    const { sessionId, number, message } = req.body;

    if (!sessionId || !number || !message) {
        return res.status(400).json({ error: 'Session ID, number, and message are required' });
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

// وظيفة إرسال الحملات (رسائل جماعية)
app.post('/send-campaign', async (req, res) => {
    const { sessionId, numbers, message, delay = 5000 } = req.body;

    if (!sessionId || !numbers || !Array.isArray(numbers) || !message) {
        return res.status(400).json({ error: 'Session ID, numbers array, and message are required' });
    }

    const session = sessions[sessionId];
    if (!session || !session.sock || session.status !== 'connected') {
        return res.status(400).json({ error: `Session ${sessionId} is not connected.` });
    }

    res.json({ success: true, message: 'Campaign started', total: numbers.length });

    // تشغيل الحملة في الخلفية
    for (const number of numbers) {
        try {
            let cleanNumber = number.toString().replace(/[^0-9]/g, '');
            const jid = cleanNumber.includes('@s.whatsapp.net') ? cleanNumber : `${cleanNumber}@s.whatsapp.net`;
            
            await session.sock.sendMessage(jid, { text: message });
            console.log(`✅ Campaign: Message sent to ${cleanNumber}`);
            
            // انتظر قبل إرسال الرسالة التالية
            await new Promise(resolve => setTimeout(resolve, delay));
        } catch (err) {
            console.error(`❌ Campaign: Error sending to ${number}:`, err.message);
        }
    }
});

const checkAndInitSessions = async () => {
    try {
        const files = fs.readdirSync(__dirname);
        const authFolders = files.filter(file => file.startsWith('auth_info_baileys_'));

        for (const folder of authFolders) {
            const actualSessionId = folder.replace('auth_info_baileys_', '');
            console.log(`🔄 استعادة جلسة مخزنة تلقائياً [${actualSessionId}]`);
            await startWhatsAppSession(actualSessionId);
        }
    } catch (err) {
        console.error('خطأ أثناء استعادة الجلسات تلقائياً:', err);
    }
};

checkAndInitSessions();

server.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
