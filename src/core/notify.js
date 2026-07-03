/**
 * Optional Telegram notifications.
 *
 * Credentials come from env (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`), provided
 * via GitHub Actions secrets — never committed. When they are absent (local runs
 * or no secrets configured) notifications are silently skipped. Sending is
 * best-effort and never throws, so it cannot break a collection run.
 *
 * Policy:
 *   - data changed on a healthy source  -> silent message (with a short diff)
 *   - source went ok -> failed           -> loud message
 *   - source went failed -> ok           -> loud (recovery) message
 *   - nothing changed and all ok         -> no message
 *
 * De-duplication: a failure is announced only on the ok -> fail transition
 * (`prevOk !== false`). While a source stays broken across consecutive runs we
 * stay silent. The recovery message fires on the first fail -> ok run, so the
 * user always learns the source is back even after a long outage. This relies on
 * `prevOk` reflecting the previously *published* document, which keeps `ok:false`
 * for as long as the source is down (see pipeline.js / publish.js).
 */

/**
 * @typedef {Object} SourceEvent
 * @property {string} name
 * @property {boolean} changed     Did the published file change this run?
 * @property {boolean} [sourceUpdatedChanged] Did the operator's own "updated" label move?
 *   When explicitly `false`, an otherwise-"changed" run is a pure horizon re-date
 *   (day rollover) and must NOT produce an "оновлено" message.
 * @property {boolean|null} prevOk Previous status.ok (null if no previous doc).
 * @property {boolean} nowOk       Current status.ok.
 * @property {string} code         Current status code.
 * @property {number} groups
 * @property {string|null} sourceUpdatedAt
 * @property {string} [changeSummary] Short human description of what changed.
 */

/** Ukrainian plural selector (1 / 2-4 / 5+ with the usual teen exceptions). */
function pluralUa(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

const queueWord = (n) => pluralUa(n, 'черга', 'черги', 'черг');

/** Comma-join a list of labels, capping the tail so messages stay short. */
function formatList(items, cap = 4) {
  if (items.length <= cap) return items.join(', ');
  return `${items.slice(0, cap).join(', ')} +${items.length - cap}`;
}

/** Round hours to one decimal and drop a trailing ".0". */
function formatHours(hours) {
  return String(Math.round(hours * 10) / 10).replace(/\.0$/, '');
}

/** Total hours of definite (kind === 'off') outages across all schedules. */
function offHours(doc) {
  let ms = 0;
  const schedules = (doc && doc.schedules) || {};
  for (const label of Object.keys(schedules)) {
    for (const iv of schedules[label].intervals || []) {
      if (iv.kind === 'off') {
        const span = Date.parse(iv.end) - Date.parse(iv.start);
        if (Number.isFinite(span) && span > 0) ms += span;
      }
    }
  }
  return ms / 3600000;
}

/**
 * Short human description of what changed between two published documents,
 * for the "оновлено" message. Returns '' when there is nothing worth saying.
 * @param {import('./schema.js').ScheduleDocument|null} previous
 * @param {import('./schema.js').ScheduleDocument} doc
 */
export function summarizeChange(previous, doc) {
  const groups = doc.groups || [];
  if (!previous) {
    return groups.length ? `перший збір: ${groups.length} ${queueWord(groups.length)}` : '';
  }

  const prevGroups = new Set(previous.groups || []);
  const currGroups = new Set(groups);
  const added = groups.filter((g) => !prevGroups.has(g));
  const removed = (previous.groups || []).filter((g) => !currGroups.has(g));

  let changedCount = 0;
  for (const label of groups) {
    if (!prevGroups.has(label)) continue;
    const before = JSON.stringify(previous.schedules?.[label]?.intervals ?? []);
    const after = JSON.stringify(doc.schedules?.[label]?.intervals ?? []);
    if (before !== after) changedCount += 1;
  }

  const parts = [];
  if (added.length) parts.push(`нові: ${formatList(added)}`);
  if (removed.length) parts.push(`прибрано: ${formatList(removed)}`);
  if (changedCount) parts.push(`змінено ${changedCount} ${queueWord(changedCount)}`);

  const delta = offHours(doc) - offHours(previous);
  if (Math.abs(delta) >= 0.5) {
    const sign = delta > 0 ? '+' : '−';
    parts.push(`${sign}${formatHours(Math.abs(delta))} год відключень`);
  }

  return parts.join(', ');
}

/**
 * Turn per-source events into Telegram messages (pure, testable).
 * @param {SourceEvent[]} events
 * @returns {{text: string, silent: boolean}[]}
 */
export function buildNotifications(events) {
  const failures = events.filter((e) => !e.nowOk && e.prevOk !== false);
  const recoveries = events.filter((e) => e.nowOk && e.prevOk === false);
  const recoveredNames = new Set(recoveries.map((e) => e.name));
  const updates = events.filter(
    (e) => e.changed && e.nowOk && !recoveredNames.has(e.name) && e.sourceUpdatedChanged !== false,
  );

  const messages = [];

  const loud = [];
  for (const e of failures) loud.push(`⚠️ ${e.name}: збій (${e.code})`);
  for (const e of recoveries) loud.push(`✅ ${e.name}: відновлено (${e.groups} черг)`);
  if (loud.length) {
    messages.push({ text: ['Стан збору графіків відключень', ...loud].join('\n'), silent: false });
  }

  if (updates.length) {
    const lines = updates.map((e) => {
      const stamp = e.sourceUpdatedAt ? ` (${e.sourceUpdatedAt})` : '';
      const summary = e.changeSummary ? ` — ${e.changeSummary}` : '';
      return `🔄 ${e.name}: оновлено${stamp}${summary}`;
    });
    messages.push({ text: ['Оновлення графіків відключень', ...lines].join('\n'), silent: true });
  }

  return messages;
}

/** Send one message via the Telegram Bot API. Never throws. */
export async function sendTelegram({ text, silent }) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const threadId = process.env.TELEGRAM_THREAD_ID; // optional: forum-group topic
  if (!token || !chatId) return { sent: false, reason: 'no-credentials' };
  try {
    const payload = {
      chat_id: chatId,
      text,
      disable_notification: Boolean(silent),
      disable_web_page_preview: true,
    };
    if (threadId) payload.message_thread_id = Number(threadId);
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return { sent: false, reason: `http ${res.status}` };
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: String(err && err.message) };
  }
}

/** Send a batch of messages best-effort; returns per-message results. */
export async function sendNotifications(messages) {
  const results = [];
  for (const message of messages) results.push(await sendTelegram(message));
  return results;
}
