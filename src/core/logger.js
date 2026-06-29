/** Minimal structured logger — timestamped lines on stderr, JSON-safe. */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

function emit(level, message, fields) {
  if (LEVELS[level] < threshold) return;
  const stamp = new Date().toISOString();
  const extra = fields && Object.keys(fields).length ? ' ' + JSON.stringify(fields) : '';
  process.stderr.write(`${stamp} ${level.toUpperCase()} ${message}${extra}\n`);
}

export const log = {
  debug: (m, f) => emit('debug', m, f),
  info: (m, f) => emit('info', m, f),
  warn: (m, f) => emit('warn', m, f),
  error: (m, f) => emit('error', m, f),
};
