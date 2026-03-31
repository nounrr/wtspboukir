'use strict';

const { DateTime } = require('luxon');
const { logReminder } = require('../lib/logger');

function getTodayDateString(tz) {
  return DateTime.now().setZone(tz).toISODate(); // YYYY-MM-DD
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function shouldSendSeen() {
  return String(process.env.WA_SEND_SEEN || 'false').toLowerCase() === 'true';
}

// ── Delay between each WhatsApp message (ms) ──
const INTER_MESSAGE_DELAY_MS = 500; // 0.5s

// ── Group tasks by employee tel ──
function groupTasksByTel(tasks) {
  const map = new Map();
  for (const row of tasks) {
    const tel = String(row.tel || '').trim();
    if (!tel) continue;
    if (!map.has(tel)) {
      map.set(tel, {
        tel,
        prenom: row.prenom,
        name: row.name,
        tasks: [],
      });
    }
    map.get(tel).tasks.push(row);
  }
  return Array.from(map.values());
}

// ── Build digest message (same format as TaskEmploye front-end) ──
function buildDigestMessages(employeeTasks, { maxLen = 950 } = {}) {
  const titles = employeeTasks
    .map((t) => String(t.description || t.title || `Tâche #${t.id}`).trim())
    .filter(Boolean);

  const total = titles.length;
  const lines = [];
  lines.push('*Rappel des tâches*');
  lines.push(`Nombre des tâches: ${total}`);
  titles.forEach((title) => lines.push(`- ${title}`));

  const raw = lines.join('\n');
  const chunks = splitTextByMaxLen(raw, maxLen);
  if (chunks.length <= 1) return chunks;
  return chunks.map((c, idx) =>
    `*Rappel des tâches* (${idx + 1}/${chunks.length})\n${c.replace(/^\*Rappel des tâches\*\n?/i, '')}`.trim()
  );
}

function splitTextByMaxLen(text, maxLen) {
  const max = Math.max(100, Number(maxLen) || 950);
  const src = String(text || '');
  if (src.length <= max) return [src];

  const parts = [];
  const lines = src.split(/\r?\n/);
  let buf = '';

  const pushBuf = () => {
    const trimmed = buf.replace(/\n+$/g, '');
    if (trimmed) parts.push(trimmed);
    buf = '';
  };

  for (const rawLine of lines) {
    const line = String(rawLine ?? '');
    if (!line) {
      if ((buf + '\n').length <= max) {
        buf += '\n';
      } else {
        pushBuf();
      }
      continue;
    }
    if (line.length > max) {
      pushBuf();
      let i = 0;
      while (i < line.length) {
        parts.push(line.slice(i, i + max));
        i += max;
      }
      continue;
    }
    const next = buf ? `${buf}\n${line}` : line;
    if (next.length <= max) {
      buf = next;
    } else {
      pushBuf();
      buf = line;
    }
  }

  pushBuf();
  return parts.length ? parts : [''];
}

// ── Keep old per-task format for backward compat (unused now but exported) ──
function makeReminderText(row) {
  const assignee = [row.prenom, row.name].filter(Boolean).join(' ').trim() || '—';

  const start = row.effective_start || row.start_date || '—';
  const end = row.effective_end || row.end_date || '—';
  const pct = row.pourcentage ?? 0;
  const label = row.description || row.title || `Tâche #${row.id}`;

  const project = row.project_title || row.projectTitle || '—';
  const list = row.list_title || row.listTitle || '—';
  const type = row.type || '—';
  const status = row.status || '—';

  return [
    `⏰ Rappel de tâche`,
    `📝 ${label}`,
    `📁 Projet: ${project}`,
    `📋 Liste: ${list}`,
    `🏷️ Statut: ${status}`,
    `📌 Type: ${type}`,
    `📊 Progression: ${pct}%`,
    `📅 Début: ${start}`,
    `⏳ Échéance: ${end}`,
    `👥 Assigné à: ${assignee}`,
  ].join('\n');
}

async function fetchTasksToRemindFromApi({ apiBase, apiKey, today, tz, onlyEnvoyerAuto }) {
  const base = (apiBase || '').replace(/\/$/, '');
  if (!base) throw new Error('REMINDER_API_BASE not configured');

  const url = `${base}/reminders/daily-tasks?date=${encodeURIComponent(today)}&tz=${encodeURIComponent(tz)}&onlyEnvoyerAuto=${onlyEnvoyerAuto ? 'true' : 'false'}`;
  const headers = { 'Accept': 'application/json' };
  if (apiKey) headers['X-Api-Key'] = apiKey;

  const resp = await fetch(url, { method: 'GET', headers });
  if (!resp.ok) {
    const t = await resp.text();
    if (resp.status === 401 || resp.status === 403) {
      const keyInfo = apiKey ? `keyLen=${String(apiKey).length}` : 'keyMissing';
      throw new Error(
        `Reminders API unauthorized (${resp.status}) (${keyInfo}). ` +
          `Check REMINDER_API_KEY matches sirh-back REMINDER_API_KEY and header "X-Api-Key" is allowed. Body=${t}`
      );
    }
    throw new Error(`Reminders API failed ${resp.status} ${t}`);
  }
  const data = await resp.json();
  return Array.isArray(data?.items) ? data.items : [];
}

async function fetchTasksToRemind(pool, today, { onlyEnvoyerAuto }) {
  const whereAuto = onlyEnvoyerAuto ? 'AND (t.envoyer_auto IS NULL OR t.envoyer_auto = 0)' : '';

  const sql = `
    SELECT
      t.id,
      t.description,
      t.status,
      t.pourcentage,
      t.type,
      t.start_date,
      t.end_date,
      COALESCE(t.start_date, t.date_debut_prevu) AS effective_start,
      COALESCE(t.end_date, t.date_fin_prevu) AS effective_end,
      l.title AS list_title,
      p.titre AS project_title,
      u.name,
      u.prenom,
      u.tel
    FROM todo_tasks t
    LEFT JOIN todo_lists l ON l.id = t.todo_list_id
    LEFT JOIN projects p ON p.id = l.project_id
    JOIN users u ON u.id = t.assigned_to
    WHERE
      t.assigned_to IS NOT NULL
      AND u.tel IS NOT NULL
      AND TRIM(u.tel) <> ''
      AND COALESCE(t.start_date, t.date_debut_prevu) IS NOT NULL
      AND COALESCE(t.end_date, t.date_fin_prevu) IS NOT NULL
      AND COALESCE(t.start_date, t.date_debut_prevu) <= ?
      AND COALESCE(t.end_date, t.date_fin_prevu) >= ?
      AND t.status <> 'Terminée'
      AND (t.pourcentage IS NULL OR t.pourcentage < 100)
      ${whereAuto}
    ORDER BY u.id, t.id
  `;

  const [rows] = await pool.query(sql, [today, today]);
  return rows;
}

// ── Shared core: group + digest + send with 0.5s delay ──
async function sendGroupedReminders({
  tasks,
  normalizeToJid,
  sendMessage,
  client,
  today,
  source,
  logger,
}) {
  const groups = groupTasksByTel(tasks);
  logger.log(`[reminders] grouped into ${groups.length} employees (today=${today}) [source=${source}]`);

  let sentMessages = 0;
  let sentEmployees = 0;
  let failedMessages = 0;
  let failedEmployees = 0;
  const errors = [];

  for (const group of groups) {
    const jid = normalizeToJid(group.tel);
    const texts = buildDigestMessages(group.tasks, { maxLen: 950 });

    let employeeFailed = false;

    for (const text of texts) {
      try {
        if (typeof sendMessage === 'function') {
          await sendMessage(jid, text, { source, tel: group.tel, today });
        } else {
          await client.sendMessage(jid, text, { sendSeen: shouldSendSeen() });
        }
        sentMessages++;

        logReminder({
          type: 'reminder_success',
          date: today,
          request: { tel: group.tel, message: text, tasksCount: group.tasks.length },
          response: { success: true, jid },
        });
      } catch (e) {
        failedMessages++;
        employeeFailed = true;
        const errorMsg = e?.message || String(e);
        errors.push({ tel: group.tel, error: errorMsg });
        logger.error(`[reminders] send failed tel=${group.tel} err=${errorMsg}`);

        logReminder({
          type: 'reminder_error',
          date: today,
          request: { tel: group.tel },
          response: { success: false },
          error: errorMsg,
        });
      }

      // 0.5s delay between each message
      await sleep(INTER_MESSAGE_DELAY_MS);
    }

    if (employeeFailed) failedEmployees++;
    else sentEmployees++;
  }

  return {
    ok: true,
    today,
    totalTasks: tasks.length,
    employees: groups.length,
    sentEmployees,
    failedEmployees,
    sentMessages,
    failedMessages,
    errors,
    source,
  };
}

async function runDailyTaskReminders({
  client,
  pool,
  normalizeToJid,
  isWaConnected,
  tz,
  onlyEnvoyerAuto,
  sendMessage,
  sendDelayMs,
  logger = console,
}) {
  const today = getTodayDateString(tz);

  logReminder({
    type: 'reminder_start',
    date: today,
    request: { source: 'db', tz, onlyEnvoyerAuto },
  });

  if (!isWaConnected()) {
    logger.warn(`[reminders] WA not connected; skip (today=${today})`);
    const errorResult = { ok: false, skipped: true, reason: 'wa_not_connected', today };
    logReminder({
      type: 'reminder_error',
      date: today,
      request: { source: 'db', tz, onlyEnvoyerAuto },
      response: errorResult,
      error: 'WhatsApp non connecté',
    });
    return errorResult;
  }

  const tasks = await fetchTasksToRemind(pool, today, { onlyEnvoyerAuto });
  logger.log(`[reminders] tasks to remind=${tasks.length} (today=${today})`);

  logReminder({
    type: 'reminder_tasks_found',
    date: today,
    request: { source: 'db', tz, onlyEnvoyerAuto, tasksCount: tasks.length },
    response: { tasks: tasks.map((t) => ({ id: t.id, tel: t.tel, description: t.description })) },
  });

  const result = await sendGroupedReminders({
    tasks,
    normalizeToJid,
    sendMessage,
    client,
    today,
    source: 'db',
    logger,
  });

  logReminder({
    type: 'reminder_complete',
    date: today,
    request: { source: 'db', tz, onlyEnvoyerAuto },
    response: result,
  });

  return result;
}

async function runDailyTaskRemindersViaApi({
  client,
  apiBase,
  apiKey,
  normalizeToJid,
  isWaConnected,
  tz,
  onlyEnvoyerAuto,
  sendMessage,
  sendDelayMs,
  logger = console,
}) {
  const today = getTodayDateString(tz);

  logReminder({
    type: 'reminder_start',
    date: today,
    request: { source: 'api', apiBase, tz, onlyEnvoyerAuto },
  });

  if (!isWaConnected()) {
    logger.warn(`[reminders] WA not connected; skip (today=${today})`);
    const errorResult = { ok: false, skipped: true, reason: 'wa_not_connected', today };
    logReminder({
      type: 'reminder_error',
      date: today,
      request: { source: 'api', apiBase, tz, onlyEnvoyerAuto },
      response: errorResult,
      error: 'WhatsApp non connecté',
    });
    return errorResult;
  }

  const tasks = await fetchTasksToRemindFromApi({ apiBase, apiKey, today, tz, onlyEnvoyerAuto });
  logger.log(`[reminders] tasks to remind=${tasks.length} (today=${today}) [source=api]`);

  logReminder({
    type: 'reminder_tasks_found',
    date: today,
    request: { source: 'api', apiBase, tz, onlyEnvoyerAuto, tasksCount: tasks.length },
    response: { tasks: tasks.map((t) => ({ id: t.id, tel: t.tel, description: t.description })) },
  });

  const result = await sendGroupedReminders({
    tasks,
    normalizeToJid,
    sendMessage,
    client,
    today,
    source: 'api',
    logger,
  });

  logReminder({
    type: 'reminder_complete',
    date: today,
    request: { source: 'api', apiBase, tz, onlyEnvoyerAuto },
    response: result,
  });

  return result;
}

module.exports = { runDailyTaskReminders, runDailyTaskRemindersViaApi };
