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
  const isTimeout =
    (err && err.name === 'TimeoutError') ||
    /timeout \d+ms exceeded/i.test(message) ||
    // Site down / unreachable (e.g. net::ERR_CONNECTION_TIMED_OUT): network, not parsing.
    /net::ERR_(CONNECTION_|TIMED_OUT|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE|INTERNET_DISCONNECTED|EMPTY_RESPONSE|SSL_)/.test(message);
  return new CollectError(isTimeout ? STATUS.TIMEOUT : STATUS.PARSE_ERROR, message);
}

export { STATUS };
