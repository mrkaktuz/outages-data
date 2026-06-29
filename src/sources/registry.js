/**
 * Registry of all configured sources. To add a region, create an adapter and
 * list it here — the pipeline picks it up automatically.
 */

import dtekKrem from './dtek/dtek-krem.js';
import dtekKem from './dtek/dtek-kem.js';

/** @type {import('../core/schema.js').SourceAdapter[]} */
export const sources = [dtekKrem, dtekKem];

export function getSource(id) {
  return sources.find((source) => source.id === id);
}
