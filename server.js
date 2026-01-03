// Load environment variables from .env
require('dotenv').config();

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');
const path = require('path');
const qrcodeTerminal = require('qrcode-terminal');
const waLogs = require('./logs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Security: simple API key protection for send endpoints
// Accept both WA_API_KEY and legacy WHTSP_SERVICE_API_KEY for flexibility
const API_KEY = process.env.WA_API_KEY || process.env.WHTSP_SERVICE_API_KEY || null;

function requireApiKey(req, res, next) {
  if (!API_KEY) return next(); // Skip auth if no API key configured
  const provided = req.get('x-api-key') || req.query?.key;
  if (!provided || provided !== API_KEY) return res.status(401).json({ ok: false, error: 'unauthorized' });
  next();
}

const WWEBJS_CLIENT_ID = process.env.WWEBJS_CLIENT_ID || 'default';
const WWEBJS_AUTH_DIR = process.env.WWEBJS_AUTH_DIR
  ? path.resolve(process.env.WWEBJS_AUTH_DIR)
  : path.join(__dirname, 'auth');

let didCleanupSingletonLocks = false;
async function cleanupChromiumSingletonLocks() {
  if (didCleanupSingletonLocks) return;
  didCleanupSingletonLocks = true;

  const sessionDir = path.join(WWEBJS_AUTH_DIR, `session-${WWEBJS_CLIENT_ID}`);
  const files = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];

  try {
    await fs.promises.access(sessionDir);
  } catch (_) {
    return; // No session dir yet
  }

  for (const f of files) {
    const p = path.join(sessionDir, f);
    try {
      await fs.promises.unlink(p);
      console.log(`Removed stale Chromium lock: ${p}`);
    } catch (e) {
      // Ignore if not present or cannot delete
    }
  }
}

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: WWEBJS_CLIENT_ID,
    // Persist auth in a stable folder to avoid session loss
    dataPath: WWEBJS_AUTH_DIR,
  }),
  restartOnAuthFail: true,
  takeoverOnConflict: true,
  takeoverTimeoutMs: 60000,
  qrMaxRetries: 5,
  puppeteer: {
    headless: true,
    // If Chrome is installed locally, you can set CHROME_PATH env to its executable
    executablePath: process.env.CHROME_PATH,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding'
    ]
  },
  // Keep the web version in sync to reduce random session closes
  webVersionCache: {
    type: 'remote',
    remotePath: process.env.WEB_VERSION_REMOTE || 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/last.json'
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

      const msg = await client.sendMessage(chatId, message);
      console.log('Message envoyé à', phoneNumber);
      waLogs.appendLog({
        source: 'socket',
        endpoint: 'socket.send_message',
        phone: phoneNumber,
        jid: chatId,
        type: 'text',
        text: message,
        ok: true,
        messageId: msg?.id?._serialized || null,
      }).catch(() => {});
      socket.emit('message_success', { phoneNumber });
    } catch (err) {
      console.error('Erreur envoi message ❌', err);
      waLogs.appendLog({
        source: 'socket',
        endpoint: 'socket.send_message',
        phone: phoneNumber,
        jid: normalizeToJid(phoneNumber),
        type: 'text',
        text: message,
        ok: false,
        error: err?.message || 'unknown',
      }).catch(() => {});
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

// Normalize to E.164-like digits without '+' for whatsapp-web.js JID
// Rules:
// - If input starts with '+', keep country code as provided (do NOT override)
// - If input starts with '00', treat as international and drop leading '00'
// - If input is local (starts with '0' or no cc), require DEFAULT_CC, else return as-is (will fail upstream)
function normalizePhone(phone) {
  const raw = (phone || '').toString().trim();
  if (!raw) return '';
  if (raw.startsWith('+')) {
    // Strip '+' but preserve digits
    return normalizeDigits(raw);
  }
  if (raw.startsWith('00')) {
    // '00' international prefix -> drop and keep rest
    return normalizeDigits(raw.slice(2));
  }
  let p = normalizeDigits(raw);
  if (!p) return '';
  const ccEnv = (process.env.DEFAULT_CC || '').replace(/\D+/g, '');
  // Local numbers: leading zero or missing cc
  if (p.startsWith('0')) {
    if (ccEnv) {
      return ccEnv + p.slice(1);
    }
    return p; // no DEFAULT_CC: leave as-is; upstream will error
  }
  // If no explicit cc and env provided, prepend cc; else keep as provided
  if (ccEnv && !p.startsWith(ccEnv)) {
    // Heuristic: if length matches local pattern and doesn't start with cc, prepend cc
    return ccEnv + p;
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

// Logs (HTML + JSON) - secured via API key (header x-api-key or ?key=...)
app.get('/logs.json', requireApiKey, async (req, res) => {
  try {
    const limit = req.query?.limit ? Number(req.query.limit) : (process.env.WA_LOG_MAX ? Number(process.env.WA_LOG_MAX) : 500);
    const messages = await waLogs.readLastLogs({ limit });
    const stats = waLogs.computeStats(messages);
    res.json({ ok: true, stats, messages, logFile: waLogs.getLogFilePath() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'unknown' });
  }
});

app.get('/logs', async (req, res) => {
  try {
    const htmlPath = path.join(__dirname, 'public', 'logs.html');
    let html = await require('fs').promises.readFile(htmlPath, 'utf8');
    
    // Inject API key from env into HTML
    const apiKey = API_KEY || '';
    html = html.replace('__API_KEY_PLACEHOLDER__', apiKey);
    
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    res.status(500).send(`<pre>${String(e?.message || e)}</pre>`);
  }
});

// Restart endpoint (secured)
app.post('/restart', requireApiKey, async (_req, res) => {
  try {
    isClientReady = false;
    lastState = 'RESTARTING';
    try {
      await client.destroy();
    } catch (_) {}
    setTimeout(() => {
      scheduleReinit(500);
    }, 200);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'unknown' });
  }
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
    // Prevent silent region changes: if user supplied '+' prefix, keep it
    const jid = normalizeToJid(phone);
    const candidate = jid.replace('@c.us','');
    // Basic sanity: international numbers should be at least 8 digits
    if (candidate.length < 8) return res.status(400).json({ ok: false, error: 'invalid_phone' });
    const msg = await client.sendMessage(jid, text);
    waLogs.appendLog({
      source: 'rest',
      endpoint: 'POST /send-text',
      phone,
      jid,
      type: 'text',
      text,
      ok: true,
      messageId: msg?.id?._serialized || null,
    }).catch(() => {});
    res.json({ ok: true, id: msg.id?._serialized });
  } catch (e) {
    console.error('send-text error', e);
    try {
      const { phone, text } = req.body || {};
      const jid = phone ? normalizeToJid(phone) : null;
      waLogs.appendLog({
        source: 'rest',
        endpoint: 'POST /send-text',
        phone,
        jid,
        type: 'text',
        text,
        ok: false,
        error: e?.message || 'unknown',
      }).catch(() => {});
    } catch (_) {}
    const msg = (e?.message || '').toLowerCase();
    if (msg.includes('session closed') || msg.includes('protocol error')) {
      lastState = 'DISCONNECTED';
      isClientReady = false;
      scheduleReinit(1000);
      return res.status(503).json({ ok: false, error: 'wa_restarting' });
    }
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

    // IMPORTANT: we never store base64 in logs. For documents/media, store only doc path (URL) or filename.
    waLogs.appendLog({
      source: 'rest',
      endpoint: 'POST /send-media',
      phone,
      jid,
      type: 'media',
      caption: caption || null,
      docPath: mediaUrl || mediaName || null,
      mimeType: mediaMime || null,
      filename: mediaName || null,
      ok: true,
      messageId: msg?.id?._serialized || null,
    }).catch(() => {});

    res.json({ ok: true, id: msg.id?._serialized });
  } catch (e) {
    console.error('send-media error', e);
    try {
      const { phone, caption, mediaUrl, mimetype, filename } = req.body || {};
      const jid = phone ? normalizeToJid(phone) : null;
      waLogs.appendLog({
        source: 'rest',
        endpoint: 'POST /send-media',
        phone,
        jid,
        type: 'media',
        caption: caption || null,
        docPath: mediaUrl || filename || null,
        mimeType: mimetype || null,
        filename: filename || null,
        ok: false,
        error: e?.message || 'unknown',
      }).catch(() => {});
    } catch (_) {}
    const msg = (e?.message || '').toLowerCase();
    if (msg.includes('session closed') || msg.includes('protocol error')) {
      lastState = 'DISCONNECTED';
      isClientReady = false;
      scheduleReinit(1000);
      return res.status(503).json({ ok: false, error: 'wa_restarting' });
    }
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

    waLogs.appendLog({
      source: 'rest',
      endpoint: 'POST /send-template',
      phone,
      jid,
      type: 'template',
      templateKey,
      params: params || {},
      text,
      ok: true,
      messageId: msg?.id?._serialized || null,
    }).catch(() => {});

    res.json({ ok: true, id: msg.id?._serialized });
  } catch (e) {
    console.error('send-template error', e);
    try {
      const { phone, templateKey, params } = req.body || {};
      const jid = phone ? normalizeToJid(phone) : null;
      waLogs.appendLog({
        source: 'rest',
        endpoint: 'POST /send-template',
        phone,
        jid,
        type: 'template',
        templateKey: templateKey || null,
        params: params || {},
        ok: false,
        error: e?.message || 'unknown',
      }).catch(() => {});
    } catch (_) {}
    const msg = (e?.message || '').toLowerCase();
    if (msg.includes('session closed') || msg.includes('protocol error')) {
      lastState = 'DISCONNECTED';
      isClientReady = false;
      scheduleReinit(1000);
      return res.status(503).json({ ok: false, error: 'wa_restarting' });
    }
    res.status(500).json({ ok: false, error: e?.message || 'unknown' });
  }
});

(async () => {
  // If the process previously crashed, Chromium can leave a SingletonLock in the
  // session profile folder and refuse to start. Clean it once on startup.
  await cleanupChromiumSingletonLocks();
  client.initialize();
})();

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

// Global error guards: keep process alive and try reinit
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  const msg = (reason?.message || reason?.toString?.() || '').toLowerCase();
  if (msg.includes('failed to launch the browser process') || msg.includes('processsingleton')) {
    cleanupChromiumSingletonLocks()
      .then(() => scheduleReinit(1000))
      .catch(() => scheduleReinit(2000));
  }
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  scheduleReinit(5000);
});

// Health ping to keep chromium session active
setInterval(async () => {
  try {
    await client.getState();
  } catch (e) {
    // If state call fails and we were connected, trigger a reinit
    if (lastState === 'CONNECTED') {
      console.warn('Health ping failed, scheduling reinit');
      scheduleReinit(3000);
    }
  }
}, 60000);
