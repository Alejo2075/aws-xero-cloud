#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createController } from './controller.js';
import { loadConfig } from './config.js';
import { restoreBackup } from './restore.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    from: { type: 'string' },
    port: { type: 'string' },
    host: { type: 'string' },
    home: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (positionals[0] === 'restore') {
  try {
    if (!values.from) throw new Error('usage: xero-controller restore --from <backup.db> [--home DIR]  (stop the controller first)');
    const cfg = loadConfig(process.env, values.home ? { home: values.home } : {});
    const r = restoreBackup(cfg.home, values.from);
    process.stdout.write(`restored ${values.from} into ${cfg.home}${r.previous ? ` (previous database kept at ${r.previous})` : ''}\n`);
    process.exit(0);
  } catch (e) {
    process.stderr.write(`restore failed: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}

if (values.help) {
  process.stdout.write(`xero-controller [--home DIR] [--host 127.0.0.1] [--port 7777]
xero-controller restore --from <backup.db> [--home DIR]   (offline; stop the controller first)

Environment: XERO_HOME, XERO_PORT, XERO_MAX_WORKERS, XERO_QUEUE_LIMIT, XERO_LOG_LEVEL,
             XERO_ALLOWED_ACCOUNTS, XERO_ALLOWED_REGIONS, XERO_DOCKER_BIN, XERO_DOCKER_RUNTIME, XERO_IMAGE_<RUNTIME>,
             XERO_MAX_LOG_LINES, XERO_MAX_INVOCATIONS, XERO_DRAIN_TIMEOUT_MS
The controller only listens on loopback. The API token is stored in <home>/token.\n`);
  process.exit(0);
}

try {
  const overrides: { home?: string; host?: string; port?: number } = {};
  if (values.home) overrides.home = values.home;
  if (values.host) overrides.host = values.host;
  if (values.port) overrides.port = Number(values.port);
  const controller = await createController({ config: overrides });
  const shutdown = (signal: string): void => {
    process.stderr.write(`received ${signal}, shutting down\n`);
    void controller.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
} catch (e) {
  process.stderr.write(`failed to start: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
