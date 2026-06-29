/**
 * Playwright session management and retry orchestration.
 *
 * The DTEK sites sit behind an Imperva Incapsula challenge that only clears
 * once the browser executes its JavaScript, and they sometimes ask the visitor
 * to "wait a few minutes" while data loads. A real Chromium with light stealth
 * tweaks plus a generous wait + retry loop handles both cases.
 */

import { chromium } from 'playwright';
import { log } from './logger.js';
import { STATUS } from './schema.js';
import { CollectError } from './errors.js';

export { CollectError };

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function applyStealth() {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'languages', { get: () => ['uk-UA', 'uk', 'en-US'] });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  if (!window.chrome) window.chrome = { runtime: {} };
}

/**
 * Open a browser context. Pass a `storageState` to reuse cleared-challenge
 * cookies between runs and reduce how often the challenge reappears.
 */
export async function createSession({ storageState } = {}) {
  const browser = await chromium.launch({
    headless: true,
    // Optional override for environments with a pre-provisioned Chromium.
    executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  });
  const context = await browser.newContext({
    locale: 'uk-UA',
    timezoneId: 'Europe/Kyiv',
    userAgent: USER_AGENT,
    viewport: { width: 1366, height: 768 },
    storageState: storageState || undefined,
  });
  await context.addInitScript(applyStealth);

  return {
    context,
    saveState: (path) => context.storageState({ path }),
    close: async () => {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    },
  };
}

/**
 * Run `adapter.fetch` against a fresh page, retrying with exponential backoff.
 * Throws the last {@link CollectError} when every attempt fails.
 *
 * @param {import('playwright').BrowserContext} context
 * @param {import('./schema.js').SourceAdapter} adapter
 */
export async function fetchWithRetry(context, adapter, { attempts = 3, backoffMs = 4000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const page = await context.newPage();
    try {
      log.info('fetch attempt', { source: adapter.id, attempt });
      const raw = await adapter.fetch(page);
      return raw;
    } catch (err) {
      lastError =
        err instanceof CollectError ? err : new CollectError(STATUS.PARSE_ERROR, String(err && err.message));
      log.warn('fetch attempt failed', {
        source: adapter.id,
        attempt,
        code: lastError.code,
        message: lastError.message,
      });
    } finally {
      await page.close().catch(() => {});
    }
    if (attempt < attempts) {
      const delay = backoffMs * attempt + Math.floor(Math.random() * 1000);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}
