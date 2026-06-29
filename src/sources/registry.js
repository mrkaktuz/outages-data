/**
 * Registry of all configured sources. To add a region, create an adapter and
 * list it here — the pipeline picks it up automatically.
 */

import dtekKrem from './dtek/dtek-krem.js';
import dtekKem from './dtek/dtek-kem.js';
import ztoe from './ztoe/ztoe.js';
import chernihiv from './chernihiv/chernihiv.js';

/** @type {import('../core/schema.js').SourceAdapter[]} */
export const sources = [dtekKrem, dtekKem, ztoe, chernihiv];

export function getSource(id) {
  return sources.find((source) => source.id === id);
}
