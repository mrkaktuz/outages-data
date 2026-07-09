import { STATUS } from './schema.js';

/** Error carrying a {@link STATUS} code so the pipeline can record it. */
export class CollectError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CollectError';
    this.code = code;
  }
}

/**
 * Wrap an arbitrary error into a CollectError with a sensible status:
 * Playwright navigation/wait timeouts are infrastructure problems (site slow
 * or unreachable), not parse failures.
 */
export function toCollectError(err) {
  if (err instanceof CollectError) return err;
  const message = String(err && err.message);
  const isTimeout = (err && err.name === 'TimeoutError') || /timeout \d+ms exceeded/i.test(message);
  return new CollectError(isTimeout ? STATUS.TIMEOUT : STATUS.PARSE_ERROR, message);
}

export { STATUS };
