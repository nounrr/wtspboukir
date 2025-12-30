const fs = require('fs');
const path = require('path');
const readline = require('readline');

function getLogFilePath() {
  const fromEnv = (process.env.WA_LOG_FILE || '').trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(__dirname, 'messages.jsonl');
}

async function appendLog(entry) {
  const filePath = getLogFilePath();
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });

  const safeEntry = {
    ts: typeof entry?.ts === 'number' ? entry.ts : Date.now(),
    iso: entry?.iso || new Date(typeof entry?.ts === 'number' ? entry.ts : Date.now()).toISOString(),
    source: entry?.source || null,
    endpoint: entry?.endpoint || null,
    phone: entry?.phone || null,
    jid: entry?.jid || null,
    type: entry?.type || null,
    text: entry?.text || null,
    caption: entry?.caption || null,
    templateKey: entry?.templateKey || null,
    params: entry?.params || null,
    docPath: entry?.docPath || null,
    mimeType: entry?.mimeType || null,
    filename: entry?.filename || null,
    ok: typeof entry?.ok === 'boolean' ? entry.ok : true,
    messageId: entry?.messageId || null,
    error: entry?.error || null,
  };

  await fs.promises.appendFile(filePath, `${JSON.stringify(safeEntry)}\n`, 'utf8');
  return safeEntry;
}

async function readLastLogs({ limit = 500 } = {}) {
  const filePath = getLogFilePath();
  if (!fs.existsSync(filePath)) return [];

  const max = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(5000, Number(limit))) : 500;

  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  const buffer = [];
  for await (const line of rl) {
    const trimmed = (line || '').trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      buffer.push(obj);
      if (buffer.length > max) buffer.shift();
    } catch (_) {
      // ignore invalid lines
    }
  }

  buffer.sort((a, b) => (a?.ts || 0) - (b?.ts || 0));
  return buffer;
}

function computeStats(messages) {
  const total = messages.length;
  const byDay = {};
  for (const m of messages) {
    const iso = m?.iso || (m?.ts ? new Date(m.ts).toISOString() : null);
    const day = iso ? iso.slice(0, 10) : 'unknown';
    byDay[day] = (byDay[day] || 0) + 1;
  }
  const days = Object.keys(byDay).sort();
  return {
    total,
    byDay,
    days,
    lastIso: total ? (messages[messages.length - 1]?.iso || null) : null,
    firstIso: total ? (messages[0]?.iso || null) : null,
  };
}

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderHtml({ messages, stats, hostInfo }) {
  const rows = messages
    .slice()
    .reverse()
    .map((m) => {
      const doc = m?.docPath ? `<a href="${escapeHtml(m.docPath)}" target="_blank" rel="noreferrer">${escapeHtml(m.docPath)}</a>` : '';
      const ok = m?.ok ? 'OK' : 'ERR';
      return `
        <tr>
          <td>${escapeHtml(m?.iso || '')}</td>
          <td>${escapeHtml(ok)}</td>
          <td>${escapeHtml(m?.phone || '')}</td>
          <td>${escapeHtml(m?.type || '')}</td>
          <td>${escapeHtml(m?.text || m?.caption || '')}</td>
          <td>${doc}</td>
          <td>${escapeHtml(m?.messageId || '')}</td>
          <td>${escapeHtml(m?.endpoint || m?.source || '')}</td>
          <td>${escapeHtml(m?.error || '')}</td>
        </tr>`;
    })
    .join('');

  const dayLines = stats.days
    .slice()
    .reverse()
    .map((d) => `<li><b>${escapeHtml(d)}</b>: ${escapeHtml(stats.byDay[d])}</li>`)
    .join('');

  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>WhatsApp Logs</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; margin: 16px; }
    .meta { margin-bottom: 12px; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #ddd; padding: 8px; vertical-align: top; }
    th { background: #f6f6f6; position: sticky; top: 0; }
    .grid { display: grid; grid-template-columns: 1fr 2fr; gap: 16px; }
    @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
    .muted { color: #666; }
  </style>
</head>
<body>
  <h1>WhatsApp Logs</h1>
  <div class="meta">
    <div><b>Total</b>: ${escapeHtml(stats.total)}</div>
    <div class="muted">${escapeHtml(stats.firstIso || '')} → ${escapeHtml(stats.lastIso || '')}</div>
    ${hostInfo ? `<div class="muted">${escapeHtml(hostInfo)}</div>` : ''}
    <div class="muted">JSON: <a href="/logs.json">/logs.json</a></div>
  </div>

  <div class="grid">
    <div>
      <h3>Count par date</h3>
      <ul>${dayLines || '<li class="muted">Aucun log</li>'}</ul>
    </div>
    <div>
      <h3>Messages (dernier → premier)</h3>
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>OK</th>
            <th>Phone</th>
            <th>Type</th>
            <th>Texte/Caption</th>
            <th>Doc Path</th>
            <th>Message ID</th>
            <th>Source</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>
          ${rows || '<tr><td colspan="9" class="muted">Aucun log</td></tr>'}
        </tbody>
      </table>
    </div>
  </div>
</body>
</html>`;
}

module.exports = {
  getLogFilePath,
  appendLog,
  readLastLogs,
  computeStats,
  renderHtml,
};
