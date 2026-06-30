/**
 * Житомиробленерго (ZTOE) adapter.
 *
 * Unlike DTEK there is no anti-bot challenge and no `window.DisconSchedule` —
 * the schedule is plain server-rendered HTML (a coloured table per date). We
 * still drive it through the shared browser (the page is windows-1251 encoded;
 * Chromium decodes it for us), grab the HTML and turn it into the same
 * `DisconSchedule` shape the DTEK normalizer consumes (see {@link parseZtoeHtml}).
 */

import { CollectError, STATUS } from '../../core/errors.js';
import { log } from '../../core/logger.js';
import { normalize } from '../dtek/normalize.js';
import { parseZtoeHtml } from './parse.js';

const NAV_TIMEOUT_MS = Number(process.env.ZTOE_NAV_TIMEOUT_MS || process.env.DTEK_NAV_TIMEOUT_MS || 45000);

const URL = 'https://www.ztoe.com.ua/unhooking-search.php';

async function fetchSnapshot(page) {
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  await page.waitForSelector('table', { timeout: NAV_TIMEOUT_MS }).catch(() => {});

  const html = await page.content();
  if (!html || html.length < 1000) {
    throw new CollectError(STATUS.NO_DATA, 'ZTOE page returned no content');
  }

  const raw = parseZtoeHtml(html);
  const dates = Object.keys(raw.fact.data);
  if (dates.length === 0) {
    // No schedule table. ZTOE drops the table entirely when Ukrenergo has not
    // ordered any outages ("...графіків погодинних відключень... не надходило").
    // That is a legitimately empty schedule (power on everywhere), not a failure:
    // publish it as ok-empty. Only a genuinely broken page is a NO_DATA error.
    const looksLikePage = raw.sourceUpdatedAt || /відключен|надходил|погодинних/i.test(html);
    if (looksLikePage) {
      log.info('ztoe: no outage schedule published', { sourceUpdatedAt: raw.sourceUpdatedAt });
      return raw; // empty fact.data -> normalize yields 0 groups, status stays ok
    }
    throw new CollectError(STATUS.NO_DATA, 'no schedule tables found on ZTOE page');
  }
  log.info('ztoe parsed', { dates: dates.length, sourceUpdatedAt: raw.sourceUpdatedAt });
  return raw;
}

/** @type {import('../../core/schema.js').SourceAdapter} */
const adapter = {
  id: 'ztoe',
  displayName: 'Житомиробленерго',
  region: 'Житомирська область',
  url: URL,
  fetch: (page) => fetchSnapshot(page),
  parse: (raw) => normalize(raw),
};

export default adapter;
export const __test__ = { parseZtoeHtml };
