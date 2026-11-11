import type { Logger } from '@xero/core';
import { Redactor, redactFields } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  level?: LogLevel;
  sink?: (line: string) => void;
  redactor?: Redactor;
  now?: () => number;
  base?: Record<string, unknown>;
}

/** JSON-lines structured logger. All fields pass through redaction by default. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const sink = options.sink ?? ((line: string) => process.stderr.write(`${line}\n`));
  const redactor = options.redactor ?? new Redactor();
  const now = options.now ?? Date.now;
  const make = (base: Record<string, unknown>): Logger => {
    const emit = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
      if (ORDER[lvl] < ORDER[level]) return;
      const record = redactFields({ ...base, ...fields }, redactor) as Record<string, unknown>;
      sink(JSON.stringify({ time: new Date(now()).toISOString(), level: lvl, msg: redactor.redactString(msg), ...record }));
    };
    return {
      debug: (m, f) => emit('debug', m, f),
      info: (m, f) => emit('info', m, f),
      warn: (m, f) => emit('warn', m, f),
      error: (m, f) => emit('error', m, f),
      child: (f) => make({ ...base, ...f }),
    };
  };
  return make(options.base ?? {});
}

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};
