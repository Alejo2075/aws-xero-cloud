import { describe, expect, it } from 'vitest';
import { MetricsRegistry, Redactor, createLogger } from '../src/index.js';

describe('logger redaction', () => {
  it('redacts sensitive keys, access key ids, bearer tokens and registered secrets', () => {
    const lines: string[] = [];
    const redactor = new Redactor();
    redactor.addSecret('SuperSecretSessionTokenValue');
    const log = createLogger({ sink: (l) => lines.push(l), redactor, now: () => 0 });
    log.info('call with SuperSecretSessionTokenValue', {
      requestId: 'r1',
      sessionToken: 'abc',
      event: { name: 'Ada' },
      note: 'key AKIAABCDEFGHIJKLMNOP and Bearer abcdefghijkl',
      nested: { password: 'p' },
    });
    const out = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(out.msg).toBe('call with [REDACTED]');
    expect(out.sessionToken).toBe('[REDACTED]');
    expect(out.event).toBe('[REDACTED]');
    expect(out.requestId).toBe('r1');
    expect(out.note).toBe('key [REDACTED] and [REDACTED]');
    expect((out.nested as Record<string, string>).password).toBe('[REDACTED]');
  });
  it('honours level and child fields', () => {
    const lines: string[] = [];
    const log = createLogger({ sink: (l) => lines.push(l), level: 'warn' }).child({ component: 'x' });
    log.info('no');
    log.warn('yes');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ component: 'x', msg: 'yes' });
  });
});

describe('metrics', () => {
  it('counts, gauges, observes and renders prometheus text', () => {
    const m = new MetricsRegistry();
    m.inc('invocations_total', { target: 'local', outcome: 'ok' });
    m.inc('invocations_total', { target: 'local', outcome: 'ok' }, 2);
    m.inc('invocations_total', { target: 'aws-lambda', outcome: 'ok' });
    m.gauge('workers_running', 3);
    m.observe('duration_ms', 10);
    m.observe('duration_ms', 30);
    expect(m.counter('invocations_total', { target: 'local' })).toBe(3);
    expect(m.counter('invocations_total')).toBe(4);
    const text = m.renderPrometheus();
    expect(text).toContain('xero_invocations_total{outcome="ok",target="local"} 3');
    expect(text).toContain('xero_workers_running 3');
    expect(text).toContain('xero_duration_ms_sum 40');
  });
});
