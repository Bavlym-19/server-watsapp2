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

process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const port = process.env.PORT || 3000;

app.use(express.json());

const sessions = {};
const messageQueue = [];
let isProcessingQueue = false;

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.post('/session/start', async (req, res) => {
    const { sessionId = 'default' } = req.body;
    if (sessions[sessionId] && sessions[sessionId].status === 'connected') {
        return res.status(200).json({ status: 'already_connected', user: sessions[sessionId].sock?.user });
    }
    try {
        await startWhatsAppSession(sessionId);
        res.json({ success: true, message: `Session ${sessionId} check/start initiated.` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/session/:sessionId/status', (req, res) => {
    const { sessionId } = req.params;
    res.json({ status: sessions[sessionId]?.status || 'offline', user: sessions[sessionId]?.sock?.user });
});

app.get('/sessions', (req, res) => {
    const sessionStatus = {};
    for (const id in sessions) {
        sessionStatus[id] = { status: sessions[id].status, user: sessions[id].sock?.user };
    }
    res.json(sessionStatus);
});

app.get('/sessions/health', (req, res) => {
    const sessionKeys = Object.keys(sessions);
    if (sessionKeys.length === 0) return res.json([{ sessionId: "default", sendAttempts: 0, disconnectEvents: 0, currentStatus: "offline", banRiskPercentage: "0%" }]);
    
    const healthData = sessionKeys.map(sessionId => {
        const session = sessions[sessionId];
        let riskPercentage = (session.confirmedBanEvents || 0) * 30 + ((session.sendAttempts || 0) > 50 ? 10 : 0);
        return {
            sessionId: sessionId,
            currentStatus: session.status || 'offline',
            sendAttempts: session.sendAttempts || 0,
            disconnectEvents: session.confirmedBanEvents || 0,
            banRiskPercentage: `${Math.min(riskPercentage, 100)}%`,
            queueLength: messageQueue.length
        };
    });
    res.json(healthData);
});

async function startWhatsAppSession(sessionId = 'default') {
    if (sessions[sessionId] && sessions[sessionId].sock) {
        try { sessions[sessionId].sock.ev.removeAllListeners(); sessions[sessionId].sock.ws?.close(); } catch (e) {}
    }

    const authPath = `auth_info_baileys_${sessionId}`;
    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const { version } = await fetchLatestBaileysVersion();
    
    const sock = makeWASocket({
        version,
        auth: state,
        logger: P({ level: 'silent' }),
        browser:['macOS','17.0'], // 🔴 بصمة الماك بوك الصحيحة
        syncFullHistory: false,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 15000,
        markOnlineOnConnect: true
    });

    sessions[sessionId] = { 
        sock, status: 'connecting',
        sendAttempts: sessions[sessionId]?.sendAttempts || 0,
        confirmedBanEvents: sessions[sessionId]?.confirmedBanEvents || 0
    };

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
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
                if (sessions[sessionId]) sessions[sessionId].confirmedBanEvents++;
                if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true });
                delete sessions[sessionId];
                io.emit('status', { sessionId, status: 'logged_out' });
            } else {
                if (sessions[sessionId]) sessions[sessionId].status = 'reconnecting';
                io.emit('status', { sessionId, status: 'reconnecting' });
                // لو في إيرور غريب زي 401، هيمسح الملف البايظ عشان يبدأ من جديد
                if (reason === 401 || reason === 403) {
                    if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true });
                }
                setTimeout(() => startWhatsAppSession(sessionId), 5000);
            }
        } else if (connection === 'open') {
            console.log(`\n✅ الجلسة متصلة وجاهزة! [${sessionId}]`);
            if (sessions[sessionId]) { sessions[sessionId].status = 'connected'; sessions[sessionId].sock = sock; }
            io.emit('status', { sessionId, status: 'connected', user: sock.user });
        }
    });

    sock.ev.on('creds.update', saveCreds);
    return sock;
}

function getSanitizedJid(number) {
    let cleanNumber = number.toString().replace(/[^0-9]/g, '');
    if (cleanNumber.startsWith('0') && cleanNumber.length === 11) cleanNumber = '20' + cleanNumber.substring(1); 
    return `${cleanNumber}@s.whatsapp.net`;
}

async function simulateHumanTyping(sock, jid, message = "") {
    try {
        let typeDuration = Math.max(4000, Math.min(25000, message.length * 150));
        await sock.sendPresenceUpdate('composing', jid);
        if (typeDuration > 10000) {
            await new Promise(r => setTimeout(r, typeDuration / 2));
            await sock.sendPresenceUpdate('paused', jid);
            await new Promise(r => setTimeout(r, 1500));
            await sock.sendPresenceUpdate('composing', jid);
            await new Promise(r => setTimeout(r, typeDuration / 2));
        } else {
            await new Promise(r => setTimeout(r, typeDuration));
        }
        await sock.sendPresenceUpdate('paused', jid);
    } catch (e) {}
}

async function processMessageQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;

    while (messageQueue.length > 0) {
        const task = messageQueue[0];
        let session = sessions[task.sessionId];

        if (!session || !session.sock || session.status !== 'connected') {
            console.log(`⚠️ Queue: Session offline, pausing for 10s...`);
            await new Promise(r => setTimeout(r, 10000));
            continue; 
        }

        messageQueue.shift();

        try {
            session.sendAttempts++;
            if (task.showTyping) await simulateHumanTyping(session.sock, task.jid, task.taskDelay || task.message); // Fix parameter
            await session.sock.sendMessage(task.jid, { text: task.message });
            console.log(`✅ Queued Message sent to ${task.jid} (Remaining: ${messageQueue.length})`);
            
            const randomDelay = (task.delay || 5000) + Math.floor(Math.random() * 8000);
            await new Promise(r => setTimeout(r, randomDelay));
        } catch (err) {
            console.error(`❌ Queue Error sending to ${task.jid}:`, err.message);
            await new Promise(r => setTimeout(r, 5000));
        }
    }
    isProcessingQueue = false;
}

app.post('/send-message', async (req, res) => {
    const { sessionId = 'default', number, message, showTyping = true } = req.body;
    if (!number || !message) return res.status(400).json({ error: 'Number and message are required' });

    const jid = getSanitizedJid(number);
    messageQueue.push({ sessionId, jid, message, showTyping, delay: 5000 });
    
    res.json({ success: true, sessionId, status: 'queued' });
    processMessageQueue();
});

app.post('/send-campaign', async (req, res) => {
    const { sessionId = 'default', numbers, message, delay = 15000, showTyping = true } = req.body;
    if (!numbers || !Array.isArray(numbers) || !message) return res.status(400).json({ error: 'Numbers array and message are required' });

    res.json({ success: true, message: 'Campaign added to queue', total: numbers.length });

    for (const number of numbers) {
        const jid = getSanitizedJid(number);
        messageQueue.push({ sessionId, jid, message, showTyping, delay });
    }
    processMessageQueue();
});

const checkAndInitSessions = async () => {
    try {
        // 🧹 أمر مسح الجلسات المعلقة اللي بتمنع الباركود إنه يظهر
        const files = fs.readdirSync(__dirname);
        for (const file of files) {
            if (file.startsWith('auth_info_baileys_')) {
                fs.rmSync(path.join(__dirname, file), { recursive: true, force: true });
                console.log(`🧹 تم مسح الجلسة القديمة المعلقة: ${file} لإنشاء باركود جديد`);
            }
        }
        console.log(`🚀 البدء لإنشاء الباركود...`);
        await startWhatsAppSession('default');
    } catch (err) {}
};

const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_EXTERNAL_URL) {
    setInterval(() => http.get(RENDER_EXTERNAL_URL).on('error', () => {}), 5 * 60 * 1000);
}

server.listen(port, () => {
    console.log(`🚀 Server is running on port ${port}`);
    checkAndInitSessions();
});
