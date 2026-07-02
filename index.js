const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
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

// تعديل البورت إجباري لـ 7860 لـ Hugging Face
const port = process.env.PORT || 7860; 

const API_KEY = process.env.API_KEY || "Bavlym19"; 

app.use(express.json());

const sessions = {};

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

app.post("/session/start", async (req, res) => {
    const { sessionId, usePairingCode, phoneNumber } = req.body;

    if (!sessionId) {
        return res.status(400).json({ error: "Session ID is required." });
    }

    if (sessions[sessionId] && sessions[sessionId].sock && sessions[sessionId].sock.user) {
        return res.status(200).json({ status: "already_connected", user: sessions[sessionId].sock.user });
    }

    try {
        const sock = await startWhatsAppSession(sessionId, usePairingCode, phoneNumber);
        sessions[sessionId] = { sock, status: "connecting" };
        res.json({ success: true, message: `Session ${sessionId} started.` });
    } catch (error) {
        console.error(`Error starting session ${sessionId}:`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get("/session/:sessionId/status", (req, res) => {
    const { sessionId } = req.params;
    if (sessions[sessionId]) {
        res.json({ status: sessions[sessionId].status, user: sessions[sessionId].sock?.user });
    } else {
        res.status(404).json({ error: "Session not found." });
    }
});

async function startWhatsAppSession(sessionId, usePairingCode = false, phoneNumber = null) {
    const authPath = `auth_info_baileys_${sessionId}`;
    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    
    const logger = P({ level: "silent" });
    
    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.creds, logger),
        },
        printQRInTerminal: false,
        logger,
        browser: ['Chrome', 'Ubuntu', '1.0'],
        usePairingCode: usePairingCode,
        phoneNumber: usePairingCode ? phoneNumber : undefined
    });

    if (usePairingCode && !sock.user && phoneNumber) {
        const code = await sock.requestPairingCode(phoneNumber);
        console.log(`Pairing Code for session ${sessionId}: ${code}`);
        io.emit("pairing_code", { sessionId, code });
    }

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log(`QR Code received for session ${sessionId}, emitting to socket...`);
            const qrImage = await qrcode.toDataURL(qr);
            io.emit("qr", { sessionId, qrImage });
            sessions[sessionId].status = "qr_received";
        }

        if (connection === "close") {
            let reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            if (reason === DisconnectReason.loggedOut) {
                console.log(`Session ${sessionId} logged out. Deleting auth files.`);
                if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true });
                sessions[sessionId].status = "logged_out";
                io.emit("status", { sessionId, status: "logged_out" });
            } else {
                console.log(`Connection closed for session ${sessionId}, reconnecting...`);
                sessions[sessionId].status = "reconnecting";
                io.emit("status", { sessionId, status: "reconnecting" });
                setTimeout(() => startWhatsAppSession(sessionId, usePairingCode, phoneNumber), 5000);
            }
        } else if (connection === "open") {
            console.log(`Opened connection for session ${sessionId}`);
            sessions[sessionId].status = "connected";
            io.emit("status", { sessionId, status: "connected", user: sock.user });
        }
    });

    sock.ev.on("creds.update", saveCreds);

    return sock;
}

app.post("/send-message", async (req, res) => {
    const { sessionId, number, message, key } = req.body;

    if (key !== API_KEY) {
        return res.status(401).json({ error: "خطأ: مفتاح الأمان غير صحيح!" });
    }

    if (!sessionId || !number || !message) {
        return res.status(400).json({ error: "Session ID, number, and message are required" });
    }

    const session = sessions[sessionId];
    if (!session || !session.sock || session.status !== "connected") {
        return res.status(400).json({ error: `Session ${sessionId} is not connected.` });
    }

    try {
        const jid = number.includes("@s.whatsapp.net") ? number : `${number}@s.whatsapp.net`;
        await session.sock.sendMessage(jid, { text: message });
        res.json({ success: true, sessionId });
    } catch (err) {
        console.error(`Error sending message for session ${sessionId}:`, err);
        res.status(500).json({ error: err.message });
    }
});

// تشغيل السيرفر من خلال الـ http server اللي مربوط بيه الـ socket.io
server.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
