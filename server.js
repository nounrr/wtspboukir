// Load environment variables from .env
require('dotenv').config();

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const qrcodeTerminal = require('qrcode-terminal');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Security: simple API key protection for send endpoints
const API_KEY = process.env.WA_API_KEY || null;

function requireApiKey(req, res, next) {
  if (!API_KEY) return res.status(500).json({ ok: false, error: 'api_key_not_configured' });
  const provided = req.get('x-api-key');
  if (!provided || provided !== API_KEY) return res.status(401).json({ ok: false, error: 'unauthorized' });
  next();
}

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: process.env.WWEBJS_CLIENT_ID || 'default',
    dataPath: process.env.WWEBJS_AUTH_DIR ? path.resolve(process.env.WWEBJS_AUTH_DIR) : undefined,
  }),
  puppeteer: {
    headless: true,
    // If Chrome is installed locally, you can set CHROME_PATH env to its executable
    executablePath: process.env.CHROME_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote']
  }
});

let isClientReady = false;
let lastQr = null;
let lastState = 'INIT';
let lastReadyAt = null;
let reinitTimer = null;
function scheduleReinit(delayMs = 3000) {
  if (reinitTimer) return;
  reinitTimer = setTimeout(() => {
    reinitTimer = null;
    try {
      console.log('Reinitialisation du client WhatsApp...');
      client.initialize();
    } catch (e) {
      console.warn('Erreur lors de la réinitialisation:', e?.message);
    }
  }, delayMs);
}

// CORS (allow calls from frontend)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Servir les fichiers statiques
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '1mb' }));

client.on('qr', (qr) => {
  console.log('QR Code généré');
  isClientReady = false;
  lastQr = qr;
  lastState = 'QR';
  try {
    console.log('Scanne ce QR avec WhatsApp > Appareils liés (Linked devices):');
    qrcodeTerminal.generate(qr, { small: true });
  } catch (e) {
    console.warn('Impossible d\'afficher le QR en ASCII:', e?.message);
  }
  io.emit('qr', qr);
});

client.on('ready', () => {
  console.log('Client prêt ✅');
  isClientReady = true;
  lastState = 'CONNECTED';
  lastReadyAt = Date.now();
  // Une fois prêt, on n'a plus de QR actif
  lastQr = null;
  io.emit('ready');
});

client.on('authenticated', () => {
  console.log('Authentifié ✅');
  // QR n'est plus pertinent après authentification
  lastQr = null;
  io.emit('authenticated');
});

client.on('auth_failure', (msg) => {
  console.error('Erreur d\'authentification :', msg);
  isClientReady = false;
  lastState = 'AUTH_FAILURE';
  io.emit('auth_failure', msg);
  scheduleReinit(5000);
});

client.on('disconnected', (reason) => {
  console.log('Déconnecté :', reason);
  isClientReady = false;
  lastState = 'DISCONNECTED';
  io.emit('disconnected', reason);
  scheduleReinit(3000);
});

client.on('change_state', (state) => {
  lastState = state || lastState;
});

// Gérer les connexions Socket.IO
io.on('connection', (socket) => {
  console.log('Nouveau client connecté');

  // Envoyer l'état actuel du client
  if (isClientReady) {
    socket.emit('ready');
  }

  socket.on('send_message', async ({ phoneNumber, message }) => {
    try {
      // Vérifier que le client est prêt
      if (!isClientReady) {
        socket.emit('message_error', 'Le client WhatsApp n\'est pas encore prêt. Veuillez scanner le QR code.');
        return;
      }

      const chatId = normalizeToJid(phoneNumber);
      
      // Vérifier que le numéro est valide
      const numberId = await client.getNumberId(chatId.replace('@c.us',''));
      if (!numberId) {
        socket.emit('message_error', 'Numéro WhatsApp invalide ou non enregistré');
        return;
      }

      await client.sendMessage(chatId, message);
      console.log('Message envoyé à', phoneNumber);
      socket.emit('message_success', { phoneNumber });
    } catch (err) {
      console.error('Erreur envoi message ❌', err);
      socket.emit('message_error', err.message || 'Erreur lors de l\'envoi du message');
    }
  });

  socket.on('disconnect', () => {
    console.log('Client déconnecté');
  });
});

// Helpers
function normalizeDigits(p) {
  return (p || '').toString().replace(/\D+/g, '');
}

function normalizePhone(phone) {
  let p = normalizeDigits(phone);
  if (!p) return p;
  // If starts with 0 and DEFAULT_CC is provided, use it (e.g. 212)
  if (p.startsWith('0') && process.env.DEFAULT_CC) {
    p = process.env.DEFAULT_CC.replace(/\D+/g, '') + p.slice(1);
  }
  // If no country code, default to 212 if provided via env or fallback to 212
  if (!p.startsWith('212') && process.env.DEFAULT_CC) {
    const cc = process.env.DEFAULT_CC.replace(/\D+/g, '');
    if (cc && !p.startsWith(cc)) p = cc + p;
  }
  return p;
}

function normalizeToJid(phone) {
  const digits = normalizePhone(phone);
  return `${digits}@c.us`;
}

// REST endpoints
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/status', async (_req, res) => {
  // Utilise l'état en cache pour éviter les retours "UNKNOWN" intermittents
  let state = lastState;
  try {
    // Essayez d'obtenir l'état temps-réel, mais retombez sur le cache en cas d'erreur
    const realtime = await client.getState();
    if (realtime) state = realtime;
  } catch (e) {
    // ignore, on garde lastState
  }
  res.json({
    ready: state === 'CONNECTED',
    state,
    hasQr: !!lastQr,
    lastReadyAt,
    now: Date.now()
  });
});

app.get('/qr', (_req, res) => {
  if (!lastQr) return res.status(404).json({ error: 'no_qr' });
  res.json({ qr: lastQr });
});

// Send plain text
app.post('/send-text', requireApiKey, async (req, res) => {
  try {
    const { phone, text } = req.body || {};
    const state = lastState;
    if (state !== 'CONNECTED') {
      return res.status(503).json({ ok: false, error: 'wa_not_ready', state });
    }
    if (!phone || !text) return res.status(400).json({ ok: false, error: 'phone_and_text_required' });
    const jid = normalizeToJid(phone);
    const msg = await client.sendMessage(jid, text);
    res.json({ ok: true, id: msg.id?._serialized });
  } catch (e) {
    console.error('send-text error', e);
    res.status(500).json({ ok: false, error: e?.message || 'unknown' });
  }
});

// Send media (image/pdf/etc) with optional caption
app.post('/send-media', requireApiKey, async (req, res) => {
  try {
    const { phone, caption, mediaUrl, base64, mimetype, filename } = req.body || {};
    const state = lastState;
    if (state !== 'CONNECTED') {
      return res.status(503).json({ ok: false, error: 'wa_not_ready', state });
    }
    if (!phone) return res.status(400).json({ ok: false, error: 'phone_required' });

    let mediaBase64 = base64;
    let mediaMime = mimetype;
    let mediaName = filename || 'file';

    if (mediaUrl) {
      const resp = await fetch(mediaUrl);
      if (!resp.ok) return res.status(400).json({ ok: false, error: 'fetch_media_failed', status: resp.status });
      const arrayBuf = await resp.arrayBuffer();
      const buff = Buffer.from(arrayBuf);
      mediaBase64 = buff.toString('base64');
      mediaMime = mediaMime || resp.headers.get('content-type') || 'application/octet-stream';
      if (!filename) {
        try {
          const urlObj = new URL(mediaUrl);
          const parts = urlObj.pathname.split('/');
          const last = parts[parts.length - 1];
          if (last) mediaName = last;
        } catch (_) {}
      }
    }

    if (!mediaBase64 || !mediaMime) {
      return res.status(400).json({ ok: false, error: 'media_data_missing' });
    }

    const jid = normalizeToJid(phone);
    const media = new MessageMedia(mediaMime, mediaBase64, mediaName);
    const msg = await client.sendMessage(jid, media, caption ? { caption } : undefined);
    res.json({ ok: true, id: msg.id?._serialized });
  } catch (e) {
    console.error('send-media error', e);
    res.status(500).json({ ok: false, error: e?.message || 'unknown' });
  }
});

// Send template rendered by Laravel API
app.post('/send-template', requireApiKey, async (req, res) => {
  try {
    const { phone, templateKey, params } = req.body || {};
    const state = lastState;
    if (state !== 'CONNECTED') {
      return res.status(503).json({ ok: false, error: 'wa_not_ready', state });
    }
    if (!phone || !templateKey) return res.status(400).json({ ok: false, error: 'phone_and_templateKey_required' });

    const apiBase = process.env.API_BASE || 'http://localhost';
    const url = `${apiBase.replace(/\/$/, '')}/api/templates/render`;
    const headers = { 'Content-Type': 'application/json' };
    const apiKey = process.env.TEMPLATE_API_KEY;
    if (apiKey) headers['X-Api-Key'] = apiKey;

    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ key: templateKey, params: params || {} })
    });
    if (!resp.ok) {
      const t = await resp.text();
      throw new Error(`API render failed ${resp.status} ${t}`);
    }
    const data = await resp.json();
    const text = data?.text || '';
    if (!text) throw new Error('Rendered text empty');

    const jid = normalizeToJid(phone);
    const msg = await client.sendMessage(jid, text);
    res.json({ ok: true, id: msg.id?._serialized });
  } catch (e) {
    console.error('send-template error', e);
    res.status(500).json({ ok: false, error: e?.message || 'unknown' });
  }
});

client.initialize();

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';

server.listen(PORT, HOST, () => {
  console.log(`Serveur démarré sur http://${HOST}:${PORT}`);
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`Erreur: le port ${PORT} est déjà utilisé sur ${HOST}.`);
    console.error('Astuce: arrête l\'autre service ou change PORT/HOST.');
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});
