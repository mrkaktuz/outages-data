import { STATUS } from './schema.js';

/** Error carrying a {@link STATUS} code so the pipeline can record it. */
export class CollectError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CollectError';
    this.code = code;
  }
}

export { STATUS };
