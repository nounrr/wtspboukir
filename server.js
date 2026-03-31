const path = require('path');
const REMINDER_AT ='19:4';

// Load environment variables from .env (use absolute path so it works under PM2/systemd)
const dotenvResult = require('dotenv').config({ path: path.join(__dirname, '.env') });
if (dotenvResult?.error) {
  console.warn('[config] .env not loaded:', dotenvResult.error.message);
}

const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const qrcodeTerminal = require('qrcode-terminal');
const QRCodeLib = require('qrcode');
const cron = require('node-cron');

const { createPoolFromEnv } = require('./lib/db');
const { runDailyTaskReminders, runDailyTaskRemindersViaApi } = require('./reminders/dailyTaskReminders');
const { getLogs, getSentMessages, clearLogs, logReminder } = require('./lib/logger');
const { RateLimitedQueue } = require('./lib/sendQueue');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { maxHttpBufferSize: 5e7 }); // 50MB limit for media uploads

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampInt(value, { min, max, fallback }) {
  const n = Number(value);
  const intVal = Number.isFinite(n) ? Math.floor(n) : fallback;
  if (!Number.isFinite(intVal)) return fallback;
  return Math.max(min, Math.min(max, intVal));
}

function randIntInclusive(min, max) {
  const a = Math.floor(min);
  const b = Math.floor(max);
  if (b <= a) return a;
  return a + Math.floor(Math.random() * (b - a + 1));
}

// Security: simple API key protection for send endpoints
const API_KEY = process.env.WA_API_KEY || process.env.WHTSP_SERVICE_API_KEY || null;

function requireApiKey(req, res, next) {
  if (!API_KEY) return res.status(500).json({ ok: false, error: 'api_key_not_configured' });
  const provided = req.get('x-api-key');
  if (!provided || provided !== API_KEY) return res.status(401).json({ ok: false, error: 'unauthorized' });
  next();
}

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: process.env.WWEBJS_CLIENT_ID || undefined,
    dataPath: process.env.WWEBJS_AUTH_DIR || undefined,
  }),
  puppeteer: {
    headless: true,
    // If Chrome is installed locally, you can set CHROME_PATH env to its executable
    executablePath: process.env.CHROME_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote']
  },
  // Désactiver les fonctionnalités qui peuvent causer des erreurs
  authTimeoutMs: 60000,
  qrMaxRetries: 5,
  // Options pour éviter l'erreur "markedUnread"
  webVersionCache: {
    type: 'remote',
    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
  }
});

const REMINDER_SOURCE = (process.env.REMINDER_SOURCE || 'db').toLowerCase(); // 'db' | 'api'

// DB pool (SIRH back database)
let dbPool = null;
if (REMINDER_SOURCE !== 'api') {
  try {
    dbPool = createPoolFromEnv();
    console.log('[db] MySQL pool created');
  } catch (e) {
    console.warn('[db] Not configured, reminders disabled until DB_* env vars are set:', e?.message);
  }
}

let isClientReady = false;
let lastQr = null;
let lastState = 'INIT';
let lastReadyAt = null;
let lastGetState = null;
let lastGetStateAt = null;
let reinitTimer = null;

async function refreshClientState() {
  try {
    const state = await client.getState();
    lastGetState = state;
    lastGetStateAt = Date.now();

    if (typeof state === 'string' && state) {
      // Keep lastState aligned with what WhatsApp reports (whatsapp-web.js can miss change_state on some updates)
      lastState = state;
    }

    // Self-heal: sometimes the WhatsApp Web session is CONNECTED but the 'ready' event never fires.
    // In that case, allow the service to recover automatically.
    if (state === 'CONNECTED' && !isClientReady) {
      console.warn('[wa] state is CONNECTED but isClientReady=false; forcing ready=true');
      isClientReady = true;
      lastReadyAt = Date.now();
      io.emit('ready');
    }

    if (state !== 'CONNECTED' && isClientReady) {
      // If WhatsApp reports non-connected state, reflect it.
      isClientReady = false;
    }

    return state;
  } catch (_e) {
    return null;
  }
}
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

// WhatsApp send throttling (prevents burst sending that can trigger bans/blocks)
// Defaults: 10 messages per 10 minutes, smoothed to ~1/min with some jitter.
const WA_RATE_WINDOW_MS = process.env.WA_RATE_WINDOW_MS ? Number(process.env.WA_RATE_WINDOW_MS) : 10 * 60 * 1000;
const WA_RATE_MAX = process.env.WA_RATE_MAX ? Number(process.env.WA_RATE_MAX) : 10;
const WA_MIN_INTERVAL_MS = process.env.WA_MIN_INTERVAL_MS
  ? Number(process.env.WA_MIN_INTERVAL_MS)
  : (Number.isFinite(WA_RATE_WINDOW_MS) && Number.isFinite(WA_RATE_MAX) && WA_RATE_MAX > 0)
    ? Math.ceil(WA_RATE_WINDOW_MS / WA_RATE_MAX)
    : 0;
const WA_JITTER_MS = process.env.WA_JITTER_MS ? Number(process.env.WA_JITTER_MS) : 2500;

// Optional occasional long pause between sends (helps mimic human usage)
const WA_LONG_PAUSE_CHANCE = process.env.WA_LONG_PAUSE_CHANCE ? Number(process.env.WA_LONG_PAUSE_CHANCE) : 0;
const WA_LONG_PAUSE_MIN_MS = process.env.WA_LONG_PAUSE_MIN_MS ? Number(process.env.WA_LONG_PAUSE_MIN_MS) : 0;
const WA_LONG_PAUSE_MAX_MS = process.env.WA_LONG_PAUSE_MAX_MS ? Number(process.env.WA_LONG_PAUSE_MAX_MS) : 0;

// WhatsApp-web.js sometimes crashes inside "sendSeen" after WhatsApp Web updates.
// Default to false to keep sending messages reliable; can be re-enabled via WA_SEND_SEEN=true.
const WA_SEND_SEEN = String(process.env.WA_SEND_SEEN || 'false').toLowerCase() === 'true';

// File to persist queue state
const QUEUE_FILE = path.join(__dirname, '.queue-persist.json');

const waSendQueue = new RateLimitedQueue({
  name: 'wa-send',
  storageFile: QUEUE_FILE,
  minIntervalMs: WA_MIN_INTERVAL_MS,
  maxPerWindow: WA_RATE_MAX,
  windowMs: WA_RATE_WINDOW_MS,
  jitterMs: WA_JITTER_MS,
  longPauseChance: WA_LONG_PAUSE_CHANCE,
  longPauseMinMs: WA_LONG_PAUSE_MIN_MS,
  longPauseMaxMs: WA_LONG_PAUSE_MAX_MS,
  logger: console,
  processor: async ({ jid, text, media }) => {
    // Wait for client to be ready (instead of failing immediately if queue loads before content)
    while (!isClientReady || !isWaConnected()) {
      await new Promise(r => setTimeout(r, 2000));
    }
    const options = { sendSeen: WA_SEND_SEEN };
    if (media && media.data) {
        const { MessageMedia } = require('whatsapp-web.js');
        const msgMedia = new MessageMedia(media.mimetype, media.data, media.filename);
        if (text) {
          options.caption = text;
        }
        return client.sendMessage(jid, msgMedia, options);
    }
    return client.sendMessage(jid, text, options);
  }
});

async function enqueueWaSend(jid, text, meta = {}) {
  // Pass data object { jid, text, media } to be persisted
  return waSendQueue.enqueue({ jid, text, media: meta.media }, { jid, meta });
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

client.on('qr', async (qr) => {
  console.log('QR Code généré');
  isClientReady = false;
  lastQr = qr;
  try {
    console.log('Scanne ce QR avec WhatsApp > Appareils liés (Linked devices):');
    qrcodeTerminal.generate(qr, { small: true });
  } catch (e) {
    console.warn('Impossible d\'afficher le QR en ASCII:', e?.message);
  }
  
  try {
      const qrDataUrl = await QRCodeLib.toDataURL(qr);
      io.emit('qr', { qr, qrDataUrl });
  } catch(e) {
      io.emit('qr', { qr });
  }
});

client.on('ready', () => {
  console.log('Client prêt ✅');
  isClientReady = true;
  lastState = 'CONNECTED';
  lastReadyAt = Date.now();
  io.emit('ready');
});

client.on('authenticated', () => {
  console.log('Authentifié ✅');
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
io.on('connection', async (socket) => {
  console.log('Nouveau client connecté');

  // Envoyer l'état actuel du client
  if (isClientReady) {
    socket.emit('ready');
  } else if (lastQr) {
      try {
          const qrDataUrl = await QRCodeLib.toDataURL(lastQr);
          socket.emit('qr', { qr: lastQr, qrDataUrl });
      } catch(e) {}
  }

  socket.on('send_message', async ({ phoneNumber, message, media }) => {
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

      await enqueueWaSend(chatId, message, { source: 'socket_io', media });
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
  const raw = (phone || '').toString().trim();
  if (!raw) return '';
  if (raw.startsWith('+')) {
    return normalizeDigits(raw);
  }
  if (raw.startsWith('00')) {
    return normalizeDigits(raw.slice(2));
  }

  let p = normalizeDigits(raw);
  if (!p) return '';

  const ccEnv = (process.env.DEFAULT_CC || '').replace(/\D+/g, '');
  if (p.startsWith('0')) {
    if (ccEnv) {
      return ccEnv + p.slice(1);
    }
    return p;
  }
  if (ccEnv && !p.startsWith(ccEnv)) {
    return ccEnv + p;
  }
  return p;
}

function normalizeToJid(phone) {
  const digits = normalizePhone(phone);
  return `${digits}@c.us`;
}

async function resolveJidFromPhone(phone) {
  const digits = normalizePhone(phone);
  if (!digits || digits.length < 8) return null;
  try {
    const numberId = await client.getNumberId(digits);
    return numberId?._serialized || null;
  } catch (_) {
    return null;
  }
}

// Daily reminders
const REMINDER_TZ =  'Africa/Casablanca';

// Reminder time (HH:mm, 24h). Example: '15:57'
// Lecture depuis .env (REMINDER_AT), sinon par défaut 16:00

// Debug: Log effective configuration
console.log('[config] REMINDER_AT:', REMINDER_AT);
console.log('[config] REMINDER_TZ from env:', process.env.REMINDER_TZ);
console.log('[config] REMINDER_CRON from env (optional override):', process.env.REMINDER_CRON);

function cronFromReminderAt(reminderAt) {
  if (!reminderAt) {
    console.log('[config] cronFromReminderAt: reminderAt is empty/null');
    return null;
  }
  const m = String(reminderAt).trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!m) {
    console.log('[config] cronFromReminderAt: invalid format for', reminderAt);
    return null;
  }
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  const cron = `${minute} ${hour} * * *`;
  console.log('[config] cronFromReminderAt: converted', reminderAt, 'to', cron);
  return cron;
}

const REMINDER_CRON = process.env.REMINDER_CRON || cronFromReminderAt(REMINDER_AT) || '0 8 * * *';
console.log('[config] Final REMINDER_CRON:', REMINDER_CRON);
const REMINDER_ONLY_ENVOYER_AUTO = (process.env.REMINDER_ONLY_ENVOYER_AUTO || 'true').toLowerCase() !== 'false';
const REMINDER_SEND_DELAY_MS = process.env.REMINDER_SEND_DELAY_MS ? Number(process.env.REMINDER_SEND_DELAY_MS) : 600;
const REMINDER_API_BASE = process.env.REMINDER_API_BASE || null; // e.g. https://example.com/api
const REMINDER_API_KEY = process.env.REMINDER_API_KEY || process.env.TEMPLATE_API_KEY || null;

function isWaConnected() {
  return lastState === 'CONNECTED' || lastGetState === 'CONNECTED';
}

if (REMINDER_SOURCE === 'api') {
  if (!REMINDER_API_BASE) {
    console.warn('[reminders] REMINDER_SOURCE=api but REMINDER_API_BASE is missing; reminders disabled');
  } else {
    if (!REMINDER_API_KEY) {
      console.warn('[reminders] REMINDER_SOURCE=api but REMINDER_API_KEY is missing; backend may return 401');
    } else {
      console.log(`[reminders] api auth configured (keyLen=${String(REMINDER_API_KEY).length})`);
    }
    cron.schedule(
      REMINDER_CRON,
      async () => {
        try {
          const result = await runDailyTaskRemindersViaApi({
            client,
            apiBase: REMINDER_API_BASE,
            apiKey: REMINDER_API_KEY,
            normalizeToJid,
            isWaConnected,
            tz: REMINDER_TZ,
            onlyEnvoyerAuto: REMINDER_ONLY_ENVOYER_AUTO,
            sendMessage: enqueueWaSend,
            sendDelayMs: 0,
            logger: console,
          });
          console.log('[reminders] done', result);
        } catch (e) {
          console.error('[reminders] job error', e);
        }
      },
      { timezone: REMINDER_TZ }
    );
    console.log(`[reminders] scheduled cron="${REMINDER_CRON}" tz="${REMINDER_TZ}" source=api onlyEnvoyerAuto=${REMINDER_ONLY_ENVOYER_AUTO}`);
  }
} else if (dbPool) {
  cron.schedule(
    REMINDER_CRON,
    async () => {
      try {
        const result = await runDailyTaskReminders({
          client,
          pool: dbPool,
          normalizeToJid,
          isWaConnected,
          tz: REMINDER_TZ,
          onlyEnvoyerAuto: REMINDER_ONLY_ENVOYER_AUTO,
          sendMessage: enqueueWaSend,
          sendDelayMs: 0,
          logger: console,
        });
        console.log('[reminders] done', result);
      } catch (e) {
        console.error('[reminders] job error', e);
      }
    },
    { timezone: REMINDER_TZ }
  );
  console.log(`[reminders] scheduled cron="${REMINDER_CRON}" tz="${REMINDER_TZ}" source=db onlyEnvoyerAuto=${REMINDER_ONLY_ENVOYER_AUTO}`);
}

// REST endpoints
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/status', async (_req, res) => {
  let state = lastState;
  const refreshed = await refreshClientState();
  if (refreshed) state = refreshed;
  res.json({
    ready: isClientReady && (state === 'CONNECTED' || lastState === 'CONNECTED'),
    state,
    lastState,
    sendQueue: waSendQueue.stats(),
    hasQr: !!lastQr,
    lastReadyAt,
    lastGetState,
    lastGetStateAt,
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
    let state = lastState;
    try { state = await client.getState(); } catch (_) {}
    const connected = isClientReady && (state === 'CONNECTED' || lastState === 'CONNECTED');
    if (!connected) {
      return res.status(503).json({ ok: false, error: 'wa_not_ready', state, lastState, isClientReady });
    }
    if (!phone || !text) return res.status(400).json({ ok: false, error: 'phone_and_text_required' });
    const jid = normalizeToJid(phone);
    const msg = await enqueueWaSend(jid, text, { source: 'manual_api', endpoint: '/send-text' });
    
    // Logger le message envoyé
    logReminder({
      type: 'reminder_success',
      date: new Date().toISOString().split('T')[0],
      request: { tel: phone, message: text, source: 'manual_api', endpoint: '/send-text' },
      response: { success: true, jid, messageId: msg.id?._serialized }
    });
    
    res.json({ ok: true, id: msg.id?._serialized });
  } catch (e) {
    console.error('send-text error', e);
    
    // Logger l'erreur
    logReminder({
      type: 'reminder_error',
      date: new Date().toISOString().split('T')[0],
      request: { tel: req.body?.phone, message: req.body?.text, source: 'manual_api', endpoint: '/send-text' },
      response: { success: false },
      error: e?.message || 'unknown'
    });
    
    res.status(500).json({ ok: false, error: e?.message || 'unknown' });
  }
});

// Send media (image/pdf/etc) with optional caption
app.post('/send-media', requireApiKey, async (req, res) => {
  try {
    const { phone, caption, mediaUrl, base64, mimetype, filename } = req.body || {};
    let state = lastState;
    try { state = await client.getState(); } catch (_) {}
    const connected = isClientReady && (state === 'CONNECTED' || lastState === 'CONNECTED');
    if (!connected) {
      return res.status(503).json({ ok: false, error: 'wa_not_ready', state, lastState, isClientReady });
    }
    if (!phone) return res.status(400).json({ ok: false, error: 'phone_required' });

    let mediaBase64 = base64;
    let mediaMime = mimetype;
    let mediaName = filename || 'file';

    if (mediaUrl) {
      const resp = await fetch(mediaUrl);
      if (!resp.ok) {
        return res.status(400).json({ ok: false, error: 'fetch_media_failed', status: resp.status });
      }
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

    const jid = await resolveJidFromPhone(phone);
    if (!jid) {
      return res.status(400).json({ ok: false, error: 'invalid_or_unregistered_phone' });
    }

    const msg = await enqueueWaSend(jid, caption || '', {
      source: 'manual_api',
      endpoint: '/send-media',
      media: {
        mimetype: mediaMime,
        data: mediaBase64,
        filename: mediaName,
      },
    });

    logReminder({
      type: 'reminder_success',
      date: new Date().toISOString().split('T')[0],
      request: {
        tel: phone,
        message: caption || '',
        source: 'manual_api',
        endpoint: '/send-media',
        mediaUrl: mediaUrl || null,
        filename: mediaName,
      },
      response: { success: true, jid, messageId: msg.id?._serialized },
    });

    res.json({ ok: true, id: msg.id?._serialized });
  } catch (e) {
    console.error('send-media error', e);

    logReminder({
      type: 'reminder_error',
      date: new Date().toISOString().split('T')[0],
      request: {
        tel: req.body?.phone,
        message: req.body?.caption || '',
        source: 'manual_api',
        endpoint: '/send-media',
        mediaUrl: req.body?.mediaUrl || null,
        filename: req.body?.filename || null,
      },
      response: { success: false },
      error: e?.message || 'unknown',
    });

    res.status(500).json({ ok: false, error: e?.message || 'unknown' });
  }
});

// Send plain text in batches (bypasses waSendQueue rate-limit)
// Body example:
// {
//   "items": [{"phone":"+2126...","text":"..."}],
//   "batchSize": 10,
//   "minDelaySec": 3,
//   "maxDelaySec": 10,
//   "batchPauseSec": 60
// }
app.post('/send-text-batch', requireApiKey, async (req, res) => {
  try {
    let state = lastState;
    try { state = await client.getState(); } catch (_) {}
    const connected = isClientReady && (state === 'CONNECTED' || lastState === 'CONNECTED');
    if (!connected) {
      return res.status(503).json({ ok: false, error: 'wa_not_ready', state, lastState, isClientReady });
    }

    const body = req.body || {};
    const rawItems = Array.isArray(body.items) ? body.items : [];
    if (rawItems.length === 0) return res.status(400).json({ ok: false, error: 'items_required' });
    if (rawItems.length > 2000) return res.status(400).json({ ok: false, error: 'too_many_items', max: 2000 });

    const batchSize = clampInt(body.batchSize, { min: 1, max: 50, fallback: 10 });
    const minDelayMs = clampInt(body.minDelaySec, { min: 0, max: 60, fallback: 3 }) * 1000;
    const maxDelayMs = clampInt(body.maxDelaySec, { min: 0, max: 120, fallback: 10 }) * 1000;
    const batchPauseMs = clampInt(body.batchPauseSec, { min: 0, max: 3600, fallback: 60 }) * 1000;

    const delayMin = Math.min(minDelayMs, maxDelayMs);
    const delayMax = Math.max(minDelayMs, maxDelayMs);

    const items = rawItems.map((it, idx) => {
      const phone = it?.phone ?? it?.to ?? it?.tel ?? it?.recipient;
      const text = it?.text ?? it?.message;
      return { idx, phone, text };
    });

    const startedAt = Date.now();
    let sent = 0;
    let failed = 0;
    let invalid = 0;

    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);

      const settled = await Promise.allSettled(
        batch.map(async (item) => {
          const phone = item.phone;
          const text = item.text;
          if (!phone || !text) {
            invalid++;
            return { ok: false, skipped: true, reason: 'phone_or_text_missing', idx: item.idx };
          }

          const waitMs = randIntInclusive(delayMin, delayMax);
          if (waitMs > 0) await sleep(waitMs);

          const jid = normalizeToJid(phone);
          try {
            const msg = await client.sendMessage(jid, text, { sendSeen: WA_SEND_SEEN });
            sent++;
            logReminder({
              type: 'reminder_success',
              date: new Date().toISOString().split('T')[0],
              request: { tel: phone, message: text, source: 'manual_api', endpoint: '/send-text-batch' },
              response: { success: true, jid, messageId: msg.id?._serialized }
            });
            return { ok: true, idx: item.idx, jid, id: msg.id?._serialized };
          } catch (e) {
            failed++;
            logReminder({
              type: 'reminder_error',
              date: new Date().toISOString().split('T')[0],
              request: { tel: phone, message: text, source: 'manual_api', endpoint: '/send-text-batch' },
              response: { success: false, jid },
              error: e?.message || 'unknown'
            });
            return { ok: false, idx: item.idx, jid, error: e?.message || 'unknown' };
          }
        })
      );

      // If more batches remain, wait before next batch
      const hasMore = i + batchSize < items.length;
      if (hasMore && batchPauseMs > 0) {
        await sleep(batchPauseMs);
      }

      // Avoid unused variable linting if any
      void settled;
    }

    const durationMs = Date.now() - startedAt;
    res.json({
      ok: true,
      requested: items.length,
      batchSize,
      delay: { minMs: delayMin, maxMs: delayMax },
      batchPauseMs,
      sent,
      failed,
      invalid,
      durationMs,
    });
  } catch (e) {
    console.error('send-text-batch error', e);
    res.status(500).json({ ok: false, error: e?.message || 'unknown' });
  }
});

// Send template rendered by Laravel API
app.post('/send-template', requireApiKey, async (req, res) => {
  try {
    const { phone, templateKey, params } = req.body || {};
    let state = lastState;
    try { state = await client.getState(); } catch (_) {}
    const connected = isClientReady && (state === 'CONNECTED' || lastState === 'CONNECTED');
    if (!connected) {
      return res.status(503).json({ ok: false, error: 'wa_not_ready', state, lastState, isClientReady });
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
  const msg = await enqueueWaSend(jid, text, { source: 'manual_api', endpoint: '/send-template', templateKey });
    
    // Logger le message envoyé
    logReminder({
      type: 'reminder_success',
      date: new Date().toISOString().split('T')[0],
      request: { tel: phone, message: text, source: 'manual_api', endpoint: '/send-template', templateKey },
      response: { success: true, jid, messageId: msg.id?._serialized }
    });
    
    res.json({ ok: true, id: msg.id?._serialized });
  } catch (e) {
    console.error('send-template error', e);
    
    // Logger l'erreur
    logReminder({
      type: 'reminder_error',
      date: new Date().toISOString().split('T')[0],
      request: { tel: req.body?.phone, source: 'manual_api', endpoint: '/send-template', templateKey: req.body?.templateKey },
      response: { success: false },
      error: e?.message || 'unknown'
    });
    
    res.status(500).json({ ok: false, error: e?.message || 'unknown' });
  }
});

// Endpoints pour les logs (nouveaux messages JSON uniquement)
app.get('/api/logs', async (req, res) => {
  try {
    const { limit, type, date, tel, exclude } = req.query;
    const options = {};
    
    if (limit) options.limit = parseInt(limit);
    if (type) options.type = type;
    if (date) options.date = date;

    // Liste des numéros à exclure (uniquement via query param)
    const defaultExcluded = [];
    const excludedNumbers = exclude ? [...defaultExcluded, ...exclude.split(',').map(n => n.trim())] : defaultExcluded;

    // Fonction pour normaliser et vérifier si un numéro est exclu
    const isExcluded = (phone) => {
      const normalized = normalizeDigits(phone);
      return excludedNumbers.some(ex => {
        const exNorm = normalizeDigits(ex);
        return normalized === exNorm || normalized.endsWith(exNorm) || exNorm.endsWith(normalized);
      });
    };

    // Récupérer tous les logs pour les erreurs
    const allLogs = getLogs({ date: options.date });
    
    // Séparer les erreurs et les succès, puis filtrer
    let errors = allLogs.filter(log => log.type === 'reminder_error' || log.type === 'error');
    let messages = getSentMessages({ limit: options.limit || 1000, date: options.date });

    // Filtrer par numéro de téléphone si spécifié
    if (tel) {
      const telNorm = normalizeDigits(tel);
      messages = messages.filter(msg => {
        const msgTel = normalizeDigits(msg.tel || '');
        return msgTel.includes(telNorm) || telNorm.includes(msgTel);
      });
      errors = errors.filter(err => {
        const errTel = normalizeDigits(err.request?.tel || '');
        return errTel.includes(telNorm) || telNorm.includes(errTel);
      });
    }

    // Exclure les numéros de la liste d'exclusion
    messages = messages.filter(msg => !isExcluded(msg.tel));
    errors = errors.filter(err => !isExcluded(err.request?.tel));

    // Calculer les statistiques (uniquement messages et erreurs, après filtres)
    const today = new Date().toISOString().split('T')[0];
    const todayMessages = messages.filter(msg => msg.timestamp && msg.timestamp.startsWith(today));
    const todayErrors = errors.filter(err => err.timestamp && err.timestamp.startsWith(today));

    const stats = {
      totalMessages: messages.length,
      totalErrors: errors.length,
      todayMessages: todayMessages.length,
      todayErrors: todayErrors.length,
      total: messages.length + errors.length,
      today: todayMessages.length + todayErrors.length
    };

    // Limiter les résultats après calcul des stats
    const limitedMessages = limit ? messages.slice(0, parseInt(limit)) : messages.slice(0, 100);
    const limitedErrors = errors.slice(0, 20);

    res.json({ 
      ok: true, 
      errors: limitedErrors,
      messages: limitedMessages, 
      stats,
      filters: {
        date: date || null,
        tel: tel || null,
        excluded: excludedNumbers,
        limit: limit || 100
      }
    });
  } catch (e) {
    console.error('[logs] Error:', e);
    res.status(500).json({ ok: false, error: e?.message || 'unknown' });
  }
});

app.get('/api/logs/messages', async (req, res) => {
  try {
    const { limit, date } = req.query;
    const options = {};
    
    if (limit) options.limit = parseInt(limit);
    if (date) options.date = date;

    const messages = getSentMessages(options);

    res.json({ ok: true, messages, total: messages.length });
  } catch (e) {
    console.error('[logs] Error:', e);
    res.status(500).json({ ok: false, error: e?.message || 'unknown' });
  }
});

// Endpoint statistiques désactivé - travail uniquement avec nouveaux messages JSON
// app.get('/api/logs/stats', ...);

// Endpoint backfill désactivé - travail uniquement avec JSON
// app.post('/api/logs/backfill-reminders', requireApiKey, async (req, res) => {
//   res.status(410).json({ ok: false, error: 'endpoint_disabled', message: 'Backfill désactivé - travail uniquement avec JSON' });
// });

app.delete('/api/logs', requireApiKey, (req, res) => {
  try {
    const result = clearLogs();
    res.json({ ok: true, cleared: result });
  } catch (e) {
    console.error('[logs] Error:', e);
    res.status(500).json({ ok: false, error: e?.message || 'unknown' });
  }
});

// Test endpoint to manually trigger reminders
app.post('/api/send-reminder-test', requireApiKey, async (req, res) => {
  try {
    let state = 'UNKNOWN';
    try { state = await client.getState(); } catch (_) {}
    if (!isClientReady || state !== 'CONNECTED') {
      return res.status(503).json({ ok: false, error: 'wa_not_ready', state, message: 'WhatsApp client is not ready. Please scan QR code first.' });
    }

    console.log('[reminder-test] Manual reminder trigger started...');
    
    let result;
    if (REMINDER_SOURCE === 'api') {
      if (!REMINDER_API_BASE) {
        return res.status(500).json({ ok: false, error: 'REMINDER_API_BASE not configured' });
      }
      result = await runDailyTaskRemindersViaApi({
        client,
        apiBase: REMINDER_API_BASE,
        apiKey: REMINDER_API_KEY,
        normalizeToJid,
        isWaConnected,
        tz: REMINDER_TZ,
        onlyEnvoyerAuto: REMINDER_ONLY_ENVOYER_AUTO,
        sendMessage: enqueueWaSend,
        sendDelayMs: 0,
        logger: console,
      });
    } else if (dbPool) {
      result = await runDailyTaskReminders({
        client,
        pool: dbPool,
        normalizeToJid,
        isWaConnected,
        tz: REMINDER_TZ,
        onlyEnvoyerAuto: REMINDER_ONLY_ENVOYER_AUTO,
        sendMessage: enqueueWaSend,
        sendDelayMs: 0,
        logger: console,
      });
    } else {
      return res.status(500).json({ ok: false, error: 'no_reminder_source_configured' });
    }

    console.log('[reminder-test] Manual reminder completed:', result);
    res.json({ 
      ok: true, 
      result,
      config: {
        source: REMINDER_SOURCE,
        tz: REMINDER_TZ,
        cron: REMINDER_CRON,
        onlyEnvoyerAuto: REMINDER_ONLY_ENVOYER_AUTO
      }
    });
  } catch (e) {
    console.error('[reminder-test] Error:', e);
    res.status(500).json({ ok: false, error: e?.message || 'unknown', stack: e?.stack });
  }
});

client.initialize();

// Keep state in sync even if events are missed (WhatsApp Web updates can cause that).
setInterval(() => {
  refreshClientState();
}, 15000).unref?.();

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
