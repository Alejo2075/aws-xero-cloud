import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { XeroError } from '@xero/core';

export interface ControllerConfig {
  home: string;
  host: string;
  port: number;
  maxWorkers: number;
  queueLimit: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** AWS accounts (other than the connected one) that bindings / event sources may reference. */
  allowedAccountIds: string[];
  /** If non-empty, bindings / event sources are restricted to these regions. */
  allowedRegions: string[];
  dockerBinary: string;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/** The v0.1 controller only binds to loopback. Remote exposure needs TLS + auth work tracked by an ADR. */
export function assertLoopback(host: string): void {
  if (!LOOPBACK.has(host)) {
    throw new XeroError('INVALID_REQUEST', `refusing to bind to "${host}": the v0.1 controller only listens on loopback (127.0.0.1 / ::1)`);
  }
}

const list = (v: string | undefined): string[] => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : []);
const int = (v: string | undefined, d: number, min: number, max: number, name: string): number => {
  if (v === undefined || v === '') return d;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new XeroError('INVALID_REQUEST', `${name} must be an integer between ${min} and ${max}`);
  return n;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<ControllerConfig> = {}): ControllerConfig {
  const level = (env.XERO_LOG_LEVEL ?? 'info') as ControllerConfig['logLevel'];
  const cfg: ControllerConfig = {
    home: resolve(env.XERO_HOME ?? join(homedir(), '.xero')),
    host: env.XERO_HOST ?? '127.0.0.1',
    port: int(env.XERO_PORT, 7777, 0, 65535, 'XERO_PORT'),
    maxWorkers: int(env.XERO_MAX_WORKERS, 8, 1, 256, 'XERO_MAX_WORKERS'),
    queueLimit: int(env.XERO_QUEUE_LIMIT, 16, 0, 10_000, 'XERO_QUEUE_LIMIT'),
    logLevel: ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info',
    allowedAccountIds: list(env.XERO_ALLOWED_ACCOUNTS),
    allowedRegions: list(env.XERO_ALLOWED_REGIONS),
    dockerBinary: env.XERO_DOCKER_BIN ?? 'docker',
    ...overrides,
  };
  assertLoopback(cfg.host);
  return cfg;
}
