#!/usr/bin/env node
/**
 * CLI entry point.
 *
 *   node src/index.js                 # collect every configured source
 *   node src/index.js --source dtek-krem
 *   node src/index.js --out data --attempts 3
 *
 * Env: STORAGE_STATE_PATH (reuse browser cookies), LOG_LEVEL, DTEK_DATA_TIMEOUT_MS.
 */

import path from 'node:path';
import { sources, getSource } from './sources/registry.js';
import { log } from './core/logger.js';

function parseArgs(argv) {
  const args = { source: null, outDir: 'data', attempts: 3 };
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--source') args.source = argv[(i += 1)];
    else if (flag === '--out') args.outDir = argv[(i += 1)];
    else if (flag === '--attempts') args.attempts = Number(argv[(i += 1)]);
    else if (flag === '--notify-test') args.notifyTest = true;
    else if (flag === '--help' || flag === '-h') args.help = true;
  }
  return args;
}

function printHelp() {
  process.stdout.write(
    [
      'Usage: node src/index.js [options]',
      '',
      '  --source <id>     Collect only this source (e.g. dtek-krem)',
      '  --out <dir>       Output directory (default: data)',
      '  --attempts <n>    Fetch attempts per source (default: 3)',
      '  -h, --help        Show this help',
      '',
      'Available sources: ' + sources.map((s) => s.id).join(', '),
      '',
    ].join('\n'),
  );
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  if (args.notifyTest) {
    const { sendTelegram } = await import('./core/notify.js');
    const configured = Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
    const res = await sendTelegram({
      text: `outages-data: тест сповіщень ✅ (${new Date().toISOString()})`,
      silent: false,
    });
    log.info('notify-test', { configured, ...res });
    if (!res.sent) process.exitCode = 1; // surface misconfig in the workflow
    return;
  }

  const selected = args.source ? [getSource(args.source)].filter(Boolean) : sources;
  if (selected.length === 0) {
    log.error('unknown source', { source: args.source });
    process.exitCode = 2;
    return;
  }

  const { runPipeline } = await import('./core/pipeline.js');
  const { docs, allOk } = await runPipeline({
    sources: selected,
    outDir: path.resolve(args.outDir),
    attempts: args.attempts,
    storageStatePath: process.env.STORAGE_STATE_PATH || null,
  });

  for (const doc of docs) {
    log.info('result', { source: doc.source.id, status: doc.status.code, groups: doc.groups.length });
  }
  // Stale data is acceptable, so a partial failure is not a hard error; the
  // status is recorded in each document for consumers to act on.
  if (!allOk) log.warn('one or more sources did not refresh');
}

main().catch((err) => {
  log.error('fatal', { message: String(err && err.message), stack: err && err.stack });
  process.exitCode = 1;
});
