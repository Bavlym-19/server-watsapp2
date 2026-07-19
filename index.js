const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    isJidBroadcast, isJidGroup, jidNormalizedUser
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

// Store active WhatsApp sessions
const sessions = {};

// HTML Page to show QR Code and pairing code options for multiple sessions
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

// API to start a new session or get status of existing one
app.post("/session/start", async (req, res) => {
    const { sessionId, usePairingCode, phoneNumber } = req.body;

    if (!sessionId) {
        return res.status(400).json({ error: "Session ID is required." });
    }

    if (sessions[sessionId] && sessions[sessionId].sock && sessions[sessionId].sock.user) {
        return res.status(200).json({ status: "already_connected", user: sessions[sessionId].sock.user });
    }

    try {
        await startWhatsAppSession(sessionId, usePairingCode, phoneNumber);
        res.json({ success: true, message: `Session ${sessionId} started.` });
    } catch (error) {
        console.error(`Error starting session ${sessionId}:`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// API to get status of a specific session
app.get("/session/:sessionId/status", (req, res) => {
    const { sessionId } = req.params;
    if (sessions[sessionId]) {
        res.json({ status: sessions[sessionId].status, user: sessions[sessionId].sock?.user });
    } else {
        res.status(404).json({ error: "Session not found." });
    }
});

// دالة تشغيل الجلسة (تم إصلاح خطأ الـ Store)
async function startWhatsAppSession(sessionId, usePairingCode = false, phoneNumber = null) {
    const authPath = `auth_info_baileys_${sessionId}`;
    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const { version } = await fetchLatestBaileysVersion();
    
    const logger = P({ level: "silent" });
    
    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: state.keys, // تصليح الخطأ هنا
        },
        printQRInTerminal: false,
        logger,
        browser: ['Chrome', 'Ubuntu', '1.0'],
        usePairingCode: usePairingCode,
        phoneNumber: usePairingCode ? phoneNumber : undefined
    });

    sessions[sessionId] = { sock, status: "connecting" };

    if (usePairingCode && !sock.user && phoneNumber) {
        try {
            const code = await sock.requestPairingCode(phoneNumber);
            console.log(`Pairing Code for session ${sessionId}: ${code}`);
            io.emit("pairing_code", { sessionId, code });
        } catch (err) {
            console.error(`خطأ في جلب كود الاقتران للجلسة ${sessionId}:`, err);
        }
    }

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log(`QR Code received for session ${sessionId}, emitting to socket...`);
            const qrImage = await qrcode.toDataURL(qr);
            io.emit("qr", { sessionId, qrImage });
            if (sessions[sessionId]) sessions[sessionId].status = "qr_received";
        }

        if (connection === "close") {
            let reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            console.log(`❌ الاتصال مقفول لجلسة [${sessionId}]. الكود أو السبب: ${reason}`);
            
            if (reason === DisconnectReason.loggedOut || reason === 401 || reason === 403) {
                console.log(`Session ${sessionId} logged out or token expired. Deleting auth files...`);
                if (fs.existsSync(authPath)) {
                    fs.rmSync(authPath, { recursive: true, force: true });
                }
                delete sessions[sessionId]; 
                io.emit("status", { sessionId, status: "logged_out" });
            } else {
                console.log(`🔄 تهنيجة مؤقتة في اتصال جلسة [${sessionId}]، جاري محاولة إعادة الربط...`);
                if (sessions[sessionId]) sessions[sessionId].status = "reconnecting";
                io.emit("status", { sessionId, status: "reconnecting" });
                
                setTimeout(async () => {
                    await startWhatsAppSession(sessionId, usePairingCode, phoneNumber);
                }, 5000);
            }
        } else if (connection === "open") {
            console.log(`✅ تم فتح خط الاتصال الحي والواتساب جاهز للإرسال لجلسة: [${sessionId}]`);
            if (sessions[sessionId]) {
                sessions[sessionId].status = "connected";
                sessions[sessionId].sock = sock; 
            }
            io.emit("status", { sessionId, status: "connected", user: sock.user });
        }
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify") return;
        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;
            const from = msg.key.remoteJid;
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
            console.log(`📩 رسالة جديدة في [${sessionId}] من [${from}]: ${text}`);
        }
    });

    return sock;
}

// الـ Endpoint بتاعة إرسال الرسائل من ريبليت
app.post("/send-message", async (req, res) => {
    const { sessionId, number, message } = req.body;

    if (!sessionId || !number || !message) {
        return res.status(400).json({ error: "Session ID, number, and message are required" });
    }

    const session = sessions[sessionId];
    if (!session || !session.sock || session.status !== "connected") {
        return res.status(400).json({ error: `Session ${sessionId} is not connected.` });
    }

    try {
        let cleanNumber = number.replace(/[^0-9]/g, "");
        const jid = cleanNumber.includes("@s.whatsapp.net") ? cleanNumber : `${cleanNumber}@s.whatsapp.net`;
        
        await session.sock.sendMessage(jid, { text: message });
        res.json({ success: true, sessionId });
    } catch (err) {
        console.error(`Error sending message:`, err);
        res.status(500).json({ error: err.message });
    }
});

// كود استعادة الجلسات تلقائياً عند تشغيل السيرفر
const checkAndInitSessions = async () => {
    try {
        const files = fs.readdirSync(__dirname);
        const authFolders = files.filter(file => file.startsWith("auth_info_baileys_"));

        for (const folder of authFolders) {
            const sessionId = folder.replace("auth_info_baileys_", "");
            console.log(`🔄 تم العثور على جلسة مخزنة [${sessionId}]، جاري إعادة الاتصال تلقائياً...`);
            await startWhatsAppSession(sessionId, false, null);
        }
    } catch (err) {
        console.error("خطأ أثناء استعادة الجلسات القديمة تلقائياً:", err);
    }
};

checkAndInitSessions();

server.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
