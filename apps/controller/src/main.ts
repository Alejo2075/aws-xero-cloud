#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createController } from './controller.js';

const { values } = parseArgs({
  options: {
    port: { type: 'string' },
    host: { type: 'string' },
    home: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help) {
  process.stdout.write(`xero-controller [--home DIR] [--host 127.0.0.1] [--port 7777]

Environment: XERO_HOME, XERO_PORT, XERO_MAX_WORKERS, XERO_QUEUE_LIMIT, XERO_LOG_LEVEL,
             XERO_ALLOWED_ACCOUNTS, XERO_ALLOWED_REGIONS, XERO_DOCKER_BIN, XERO_IMAGE_<RUNTIME>
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
