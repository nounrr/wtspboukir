// Load environment variables from .env
require('dotenv').config();

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');
const path = require('path');
const qrcodeTerminal = require('qrcode-terminal');
const qrcode = require('qrcode');
const waLogs = require('./logs');

// Diagnostics (helps debug "INIT" stuck / no QR)
let initCount = 0;
let lastInitAt = null;
let lastInitError = null;
let lastQrAt = null;
let lastAuthAt = null;
let lastDisconnectAt = null;
let lastDisconnectReason = null;
let lastLoading = null;
let initStartedAt = null;
let initWatchdogTimer = null;
let pendingSessionWipe = false;
const INIT_TIMEOUT_MS = (() => {
  const raw = Number(process.env.WA_INIT_TIMEOUT_MS || 45000);
  return Number.isFinite(raw) ? Math.max(5000, Math.min(5 * 60 * 1000, raw)) : 45000;
})();

// Dangerous but effective recovery: wipe LocalAuth session on init errors.
// Enable only if you're OK with re-pairing by QR.
const WA_AUTO_WIPE_AUTH = String(process.env.WA_AUTO_WIPE_AUTH || '').trim() === '1';

function shouldWipeSessionForError(err) {
  const m = String(err || '').toLowerCase();
  return (
    m.includes('target closed') ||
    m.includes('database is locked') ||
    (m.includes('failed to open') && m.includes('database')) ||
    (m.includes('gcm store') && m.includes('lock')) ||
    m.includes('lockfile') ||
    (m.includes('leveldb') && m.includes('corruption'))
  );
}

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  // Be more tolerant of slow networks / proxies
  pingTimeout: 60000,
  pingInterval: 25000,
});

// Security: simple API key protection for send endpoints
// Accept both WA_API_KEY and legacy WHTSP_SERVICE_API_KEY for flexibility
const API_KEY = process.env.WA_API_KEY || process.env.WHTSP_SERVICE_API_KEY || null;

// WhatsApp Web can crash on some versions when trying to auto-mark chats as seen.
// Default: DO NOT send seen (safer). Set WA_SEND_SEEN=1 to re-enable.
const WA_SEND_SEEN = String(process.env.WA_SEND_SEEN || '').trim() === '1';

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

// If initialize() gets stuck, it is often Puppeteer/Chrome hanging on launch.
// Set explicit launch timeouts so we get an error instead of silent INITIALIZING forever.
const PUPPETEER_LAUNCH_TIMEOUT_MS = (() => {
  const raw = Number(process.env.WA_PUPPETEER_LAUNCH_TIMEOUT_MS || 45000);
  return Number.isFinite(raw) ? Math.max(5000, Math.min(5 * 60 * 1000, raw)) : 45000;
})();
const PUPPETEER_PROTOCOL_TIMEOUT_MS = (() => {
  const raw = Number(process.env.WA_PUPPETEER_PROTOCOL_TIMEOUT_MS || 60000);
  return Number.isFinite(raw) ? Math.max(5000, Math.min(10 * 60 * 1000, raw)) : 60000;
})();
const PUPPETEER_DUMPIO = String(process.env.WA_PUPPETEER_DUMPIO || '').trim() === '1';

// WhatsApp web version cache
// On some VPS networks, fetching the remote version file can hang; allow disabling.
const WA_WEB_VERSION_CACHE = (process.env.WA_WEB_VERSION_CACHE || 'remote').toString().trim().toLowerCase();
const WEB_VERSION_REMOTE_DEFAULT = 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/last.json';
const WEB_VERSION_REMOTE = process.env.WEB_VERSION_REMOTE || WEB_VERSION_REMOTE_DEFAULT;
const webVersionCacheOption = (() => {
  if (WA_WEB_VERSION_CACHE === 'none' || WA_WEB_VERSION_CACHE === 'off' || WA_WEB_VERSION_CACHE === 'disabled') {
    return { type: 'none' };
  }
  if (WA_WEB_VERSION_CACHE === 'remote') {
    return { type: 'remote', remotePath: WEB_VERSION_REMOTE };
  }
  // Unknown value -> safe fallback
  return { type: 'none' };
})();

// Only use CHROME_PATH if it exists; a wrong path will prevent Puppeteer from using bundled Chromium.
const CHROME_PATH = (process.env.CHROME_PATH || '').trim();
const CHROME_PATH_EXISTS = !!(CHROME_PATH && fs.existsSync(CHROME_PATH));
if (CHROME_PATH && !CHROME_PATH_EXISTS) {
  console.warn(`CHROME_PATH is set but not found: ${CHROME_PATH} (will ignore and use Puppeteer default)`);
}

function getSessionDir() {
  return path.join(WWEBJS_AUTH_DIR, `session-${WWEBJS_CLIENT_ID}`);
}

let didCleanupSingletonLocks = false;
async function cleanupChromiumSingletonLocks() {
  if (didCleanupSingletonLocks) return;
  didCleanupSingletonLocks = true;

  const sessionDir = getSessionDir();
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

async function wipeSessionDirIfPending(reason) {
  if (!pendingSessionWipe) return false;
  pendingSessionWipe = false;

  const sessionDir = getSessionDir();
  try {
    console.warn(`[WA:wipe] Removing session dir due to: ${reason || 'unknown'}`);
    await fs.promises.rm(sessionDir, { recursive: true, force: true });
    return true;
  } catch (e) {
    console.error('[WA:wipe] Failed to remove session dir:', sessionDir, e?.message || e);
    // Retry on next init
    pendingSessionWipe = true;
    return false;
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
    executablePath: CHROME_PATH_EXISTS ? CHROME_PATH : undefined,
    timeout: PUPPETEER_LAUNCH_TIMEOUT_MS,
    protocolTimeout: PUPPETEER_PROTOCOL_TIMEOUT_MS,
    dumpio: PUPPETEER_DUMPIO,
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
  webVersionCache: webVersionCacheOption
});

let isClientReady = false;
let lastQr = null;
let lastState = 'INIT';
let lastReadyAt = null;
let reinitTimer = null;

async function ensureAuthDirIsWritable() {
  try {
    await fs.promises.mkdir(WWEBJS_AUTH_DIR, { recursive: true });
    const probe = path.join(WWEBJS_AUTH_DIR, `.write-test-${process.pid}-${Date.now()}`);
    await fs.promises.writeFile(probe, 'ok', 'utf8');
    await fs.promises.unlink(probe);
    return true;
  } catch (e) {
    console.error('Auth dir is not writable:', WWEBJS_AUTH_DIR, e?.message || e);
    lastInitError = `auth_dir_not_writable: ${String(e?.message || e)}`;
    lastState = 'INIT_ERROR';
    return false;
  }
}

async function safeInitializeClient() {
  initCount += 1;
  lastInitAt = Date.now();
  initStartedAt = lastInitAt;
  lastInitError = null;
  lastLoading = null;
  lastState = 'INITIALIZING';

  try {
    const puppeteerPkg = (() => {
      try {
        // whatsapp-web.js depends on puppeteer, but environments vary
        // eslint-disable-next-line global-require
        return require('puppeteer/package.json');
      } catch (_) {
        return null;
      }
    })();
    console.log(
      `[WA:init] attempt=${initCount} chromePath=${CHROME_PATH || '(none)'} chromePathExists=${CHROME_PATH_EXISTS} authDir=${WWEBJS_AUTH_DIR} clientId=${WWEBJS_CLIENT_ID} puppeteer=${puppeteerPkg?.version || 'unknown'}`
    );
  } catch (_) {
    // ignore
  }

  if (initWatchdogTimer) {
    clearTimeout(initWatchdogTimer);
    initWatchdogTimer = null;
  }
  const thisInitAt = initStartedAt;
  initWatchdogTimer = setTimeout(() => {
    // If we’re still not ready and no QR after N ms, treat as hung browser start.
    const stillSameAttempt = initStartedAt === thisInitAt;
    const stillBooting = !isClientReady && !lastQr && (lastState === 'INITIALIZING' || lastState === 'LOADING');
    if (stillSameAttempt && stillBooting) {
      lastInitError = `init_timeout_${INIT_TIMEOUT_MS}ms`;
      lastState = 'INIT_ERROR';
      console.error(`WhatsApp init timed out after ${INIT_TIMEOUT_MS}ms; scheduling reinit`);

      if (WA_AUTO_WIPE_AUTH) {
        // A timeout commonly happens when the Chrome profile is locked/corrupted.
        pendingSessionWipe = true;
      }

      scheduleReinit(2000);
    }
  }, INIT_TIMEOUT_MS);

  const authOk = await ensureAuthDirIsWritable();
  if (!authOk) {
    scheduleReinit(8000);
    return;
  }

  if (WA_AUTO_WIPE_AUTH) {
    await wipeSessionDirIfPending(lastInitError || 'previous_init_error');
  }

  try {
    await cleanupChromiumSingletonLocks();
  } catch (_) {
    // ignore
  }

  try {
    // whatsapp-web.js initialize() is not guaranteed to return a promise across versions
    await Promise.resolve(client.initialize());
  } catch (e) {
    lastInitError = String(e?.message || e);
    lastState = 'INIT_ERROR';
    console.error('client.initialize() failed:', lastInitError);

    if (WA_AUTO_WIPE_AUTH && shouldWipeSessionForError(lastInitError)) {
      pendingSessionWipe = true;
      console.warn('[WA:init] Detected locked/corrupt profile; will wipe session on next init');
    }

    scheduleReinit(8000);
  }
}

async function safeReinitClient() {
  try {
    // Best-effort: destroy existing puppeteer/session if a previous init is hung
    if (typeof client.destroy === 'function') {
      await Promise.resolve(client.destroy());
    }
  } catch (_) {
    // ignore
  }
  await safeInitializeClient();
}
function scheduleReinit(delayMs = 3000) {
  if (reinitTimer) return;
  reinitTimer = setTimeout(() => {
    reinitTimer = null;
    try {
      console.log('Reinitialisation du client WhatsApp...');
      safeReinitClient();
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
  lastQrAt = Date.now();
  lastState = 'QR';
  if (initWatchdogTimer) {
    clearTimeout(initWatchdogTimer);
    initWatchdogTimer = null;
  }
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
  if (initWatchdogTimer) {
    clearTimeout(initWatchdogTimer);
    initWatchdogTimer = null;
  }
  // Une fois prêt, on n'a plus de QR actif
  lastQr = null;
  io.emit('ready');
});

client.on('authenticated', () => {
  console.log('Authentifié ✅');
  lastAuthAt = Date.now();
  // QR n'est plus pertinent après authentification
  lastQr = null;
  io.emit('authenticated');
});

client.on('auth_failure', (msg) => {
  console.error('Erreur d\'authentification :', msg);
  isClientReady = false;
  lastState = 'AUTH_FAILURE';
  lastInitError = String(msg || 'auth_failure');
  if (initWatchdogTimer) {
    clearTimeout(initWatchdogTimer);
    initWatchdogTimer = null;
  }
  io.emit('auth_failure', msg);
  scheduleReinit(5000);
});

client.on('disconnected', (reason) => {
  console.log('Déconnecté :', reason);
  isClientReady = false;
  lastState = 'DISCONNECTED';
  lastDisconnectAt = Date.now();
  lastDisconnectReason = String(reason || 'unknown');
  if (initWatchdogTimer) {
    clearTimeout(initWatchdogTimer);
    initWatchdogTimer = null;
  }
  io.emit('disconnected', reason);
  scheduleReinit(3000);
});

// Useful signal while booting (whatsapp-web.js emits this in many versions)
client.on('loading_screen', (percent, message) => {
  lastLoading = {
    percent: typeof percent === 'number' ? percent : null,
    message: message ? String(message) : null,
    at: Date.now(),
  };
  if (!isClientReady && lastState !== 'QR') lastState = 'LOADING';
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

      const digits = normalizePhone(phoneNumber);
      const jid = await resolveJidFromPhone(phoneNumber);
      if (!jid) {
        socket.emit('message_error', 'Numéro WhatsApp invalide ou non enregistré');
        return;
      }

      const msg = await sendWithLidFallback({
        phone: phoneNumber,
        jid,
        digits,
        payload: message,
      });
      console.log('Message envoyé à', phoneNumber);
      waLogs.appendLog({
        source: 'socket',
        endpoint: 'socket.send_message',
        phone: phoneNumber,
        jid,
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
  if (!digits) return '';
  return `${digits}@c.us`;
}

async function resolveJidFromPhone(phone) {
  const digits = normalizePhone(phone);
  if (!digits) return null;
  if (digits.length < 8) return null;
  try {
    const numberId = await client.getNumberId(digits);
    // Only return a JID if WhatsApp confirms the number exists.
    // Falling back to `${digits}@c.us` can crash inside whatsapp-web.js/WhatsApp Web
    // (e.g. "Evaluation failed ... reading 'markedUnread'") when the chat object is undefined.
    return numberId?._serialized || null;
  } catch (_) {
    return null;
  }
}

function looksLikeNoLidError(err) {
  const m = (err?.message || String(err || '')).toLowerCase();
  return m.includes('no lid for user') || m.includes('tolid') || m.includes('touserlidorthrow');
}

async function sendWithLidFallback({ phone, jid, digits, payload, options }) {
  // Default options: disable sendSeen unless explicitly enabled.
  const mergedOptions = {
    ...(options || {}),
    sendSeen: WA_SEND_SEEN,
  };

  // First try with the resolved JID (usually ...@c.us)
  try {
    return await client.sendMessage(jid, payload, mergedOptions);
  } catch (e) {
    // Workaround for recent WhatsApp Web changes where some accounts fail with:
    // "Evaluation failed: Error: No LID for user".
    if (!looksLikeNoLidError(e)) throw e;

    const altDigits = digits || normalizePhone(phone);
    if (!altDigits) throw e;

    // Try alternate server form used by WhatsApp internally.
    const altJid = `${altDigits}@s.whatsapp.net`;
    try {
      return await client.sendMessage(altJid, payload, mergedOptions);
    } catch (e2) {
      // Last attempt: if jid was ...@c.us, try again explicitly.
      const cUsJid = `${altDigits}@c.us`;
      if (cUsJid !== jid) {
        try {
          return await client.sendMessage(cUsJid, payload, mergedOptions);
        } catch (_) {
          // fall through
        }
      }
      throw e2;
    }
  }
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
    initCount,
    lastInitAt,
    initStartedAt,
    initTimeoutMs: INIT_TIMEOUT_MS,
    lastInitError,
    lastQrAt,
    lastReadyAt,
    lastAuthAt,
    lastDisconnectAt,
    lastDisconnectReason,
    loading: lastLoading,
    now: Date.now()
  });
});

// Lightweight diagnostics endpoint (no secrets)
app.get('/debug', (_req, res) => {
  res.json({
    ok: true,
    pid: process.pid,
    node: process.version,
    state: lastState,
    ready: isClientReady,
    hasQr: !!lastQr,
    initCount,
    lastInitAt,
    initStartedAt,
    initTimeoutMs: INIT_TIMEOUT_MS,
    lastInitError,
    lastQrAt,
    lastReadyAt,
    lastAuthAt,
    lastDisconnectAt,
    lastDisconnectReason,
    loading: lastLoading,
    chromePathProvided: CHROME_PATH || null,
    chromePathExists: CHROME_PATH_EXISTS,
    puppeteerLaunchTimeoutMs: PUPPETEER_LAUNCH_TIMEOUT_MS,
    puppeteerProtocolTimeoutMs: PUPPETEER_PROTOCOL_TIMEOUT_MS,
    puppeteerDumpio: PUPPETEER_DUMPIO,
    waWebVersionCache: WA_WEB_VERSION_CACHE,
    webVersionRemote: WEB_VERSION_REMOTE,
    autoWipeAuthEnabled: WA_AUTO_WIPE_AUTH,
    pendingSessionWipe,
    authDir: WWEBJS_AUTH_DIR,
    sessionDir: getSessionDir(),
    now: Date.now(),
  });
});

// Check if a phone number is registered on WhatsApp (no message is sent)
// Secured via API key because it can be abused for number enumeration.
app.get('/check-number', requireApiKey, async (req, res) => {
  try {
    const phone = (req.query?.phone || '').toString();
    if (!phone) return res.status(400).json({ ok: false, error: 'phone_required' });

    const state = lastState;
    if (state !== 'CONNECTED') {
      return res.status(503).json({ ok: false, error: 'wa_not_ready', state });
    }

    const digits = normalizePhone(phone);
    const jid = await resolveJidFromPhone(phone);
    res.json({
      ok: true,
      input: phone,
      normalizedDigits: digits || null,
      registered: !!jid,
      jid: jid || null,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'unknown' });
  }
});

app.get('/qr', (_req, res) => {
  if (!lastQr) {
    return res.json({
      ok: false,
      error: 'no_qr',
      state: lastState,
      ready: lastState === 'CONNECTED',
      hasQr: false,
      lastReadyAt,
      now: Date.now()
    });
  }
  res.json({
    ok: true,
    qr: lastQr,
    state: lastState,
    ready: lastState === 'CONNECTED',
    hasQr: true,
    lastReadyAt,
    now: Date.now()
  });
});

// QR as PNG (more reliable than client-side QR libs / CDNs)
app.get('/qr.png', async (_req, res) => {
  try {
    if (!lastQr) return res.status(404).json({ error: 'no_qr' });
    const png = await qrcode.toBuffer(lastQr, {
      type: 'png',
      width: 320,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#000000', light: '#FFFFFF' },
    });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.send(png);
  } catch (e) {
    res.status(500).json({ error: 'qr_png_failed', detail: String(e?.message || e) });
  }
});

// Page QR Scanner - Interface visuelle pour scanner le QR Code
app.get('/scanner', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'qr-scanner.html'));
});

// Redirect root to scanner page if not ready, otherwise show status
app.get('/', (_req, res) => {
  if (isClientReady) {
    res.json({ 
      ok: true, 
      status: 'ready',
      message: 'WhatsApp is connected and ready',
      readyAt: lastReadyAt 
    });
  } else {
    res.redirect('/scanner');
  }
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

// Logout endpoint (secured)
// - By default: logs out (best-effort) and restarts the client.
// - Optional: wipe the persisted auth session folder to force a fresh QR.
//   To enable wiping, set WA_ALLOW_WIPE_AUTH=1 in env.
app.post('/logout', requireApiKey, async (req, res) => {
  const wantWipe = String(req.query?.wipe || '').trim() === '1';
  const allowWipe = String(process.env.WA_ALLOW_WIPE_AUTH || '').trim() === '1';

  try {
    isClientReady = false;
    lastState = 'LOGGING_OUT';
    lastQr = null;

    // Best-effort logout (not always supported depending on web version)
    try {
      if (typeof client.logout === 'function') await client.logout();
    } catch (_) {}

    try {
      await client.destroy();
    } catch (_) {}

    let wiped = false;
    if (wantWipe) {
      if (!allowWipe) {
        return res.status(403).json({ ok: false, error: 'wipe_not_allowed', hint: 'Set WA_ALLOW_WIPE_AUTH=1 to allow wipe=1' });
      }
      const sessionDir = getSessionDir();
      try {
        await fs.promises.rm(sessionDir, { recursive: true, force: true });
        wiped = true;
      } catch (_) {
        // ignore
      }
    }

    scheduleReinit(500);
    res.json({ ok: true, wiped });
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
    const digits = normalizePhone(phone);
    const jid = await resolveJidFromPhone(phone);
    if (!jid) return res.status(400).json({ ok: false, error: 'invalid_or_unregistered_phone' });

    const msg = await sendWithLidFallback({ phone, jid, digits, payload: text });
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
    if (looksLikeNoLidError(e)) {
      return res.status(500).json({ ok: false, error: 'wa_no_lid_for_user' });
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

    const digits = normalizePhone(phone);
    const jid = await resolveJidFromPhone(phone);
    if (!jid) return res.status(400).json({ ok: false, error: 'invalid_or_unregistered_phone' });
    const media = new MessageMedia(mediaMime, mediaBase64, mediaName);

    const msg = await sendWithLidFallback({
      phone,
      jid,
      digits,
      payload: media,
      options: caption ? { caption } : undefined,
    });

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
    if (looksLikeNoLidError(e)) {
      return res.status(500).json({ ok: false, error: 'wa_no_lid_for_user' });
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

    // IMPORTANT: resolve the phone via WhatsApp registry before sending.
    // This prevents whatsapp-web.js from crashing inside page.evaluate when chat is undefined
    // (one common symptom: "Evaluation failed: ... reading 'markedUnread'").
    const digits = normalizePhone(phone);
    const jid = await resolveJidFromPhone(phone);
    if (!jid) return res.status(400).json({ ok: false, error: 'invalid_or_unregistered_phone' });

    const msg = await sendWithLidFallback({ phone, jid, digits, payload: text });

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
    if (looksLikeNoLidError(e)) {
      return res.status(500).json({ ok: false, error: 'wa_no_lid_for_user' });
    }
    res.status(500).json({ ok: false, error: e?.message || 'unknown' });
  }
});

(async () => {
  // Boot WhatsApp client with diagnostics + permission checks.
  await safeInitializeClient();
})();

const PORT = process.env.PORT || 3000;
// Default to 0.0.0.0 so the QR page + Socket.IO work remotely without env tweaks
const HOST = process.env.HOST || '0.0.0.0';

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
  try {
    lastInitError = String(reason?.message || reason?.toString?.() || reason || 'unhandledRejection');
    if (lastState === 'INIT' || lastState === 'INITIALIZING' || lastState === 'LOADING') {
      lastState = 'INIT_ERROR';
    }
  } catch (_) {}
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
