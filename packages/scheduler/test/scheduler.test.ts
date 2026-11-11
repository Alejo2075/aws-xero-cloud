import { describe, expect, it } from 'vitest';
import { MetricsLike } from './helpers.js';
import { ConcurrencyScheduler } from '../src/index.js';

const soon = (ms = 1000): { deadlineAt: number } => ({ deadlineAt: Date.now() + ms });

describe('ConcurrencyScheduler', () => {
  it('enforces the per-deployment cap and releases to waiters in order', async () => {
    const s = new ConcurrencyScheduler({ maxConcurrent: 10, queueLimit: 10 });
    const a = await s.acquire('f', 1, soon());
    const order: string[] = [];
    const b = s.acquire('f', 1, soon()).then((l) => { order.push('b'); return l; });
    const c = s.acquire('f', 1, soon()).then((l) => { order.push('c'); return l; });
    expect(s.stats()).toMatchObject({ running: 1, queued: 2 });
    a.release();
    (await b).release();
    (await c).release();
    expect(order).toEqual(['b', 'c']);
    expect(s.stats()).toEqual({ running: 0, queued: 0, perKey: {} });
  });

  it('enforces the global bound across deployments and avoids head-of-line blocking', async () => {
    const s = new ConcurrencyScheduler({ maxConcurrent: 2, queueLimit: 10 });
    const a1 = await s.acquire('a', 1, soon());
    const a2 = s.acquire('a', 1, soon()); // blocked by per-key cap, global slot is free
    const b1 = await s.acquire('b', 1, soon()); // must not wait behind a2
    expect(s.stats().running).toBe(2);
    a1.release();
    (await a2).release();
    b1.release();
  });

  it('rejects when the queue is full with CAPACITY_EXHAUSTED and counts it', async () => {
    const m = new MetricsLike();
    const s = new ConcurrencyScheduler({ maxConcurrent: 1, queueLimit: 1, metrics: m });
    const a = await s.acquire('f', 1, soon());
    const waiting = s.acquire('f', 1, soon());
    await expect(s.acquire('f', 1, soon())).rejects.toMatchObject({ code: 'CAPACITY_EXHAUSTED', details: { reason: 'queue_full' } });
    expect(m.count('capacity_rejections_total')).toBe(1);
    a.release();
    (await waiting).release();
  });

  it('times out waiters and honours abort', async () => {
    const s = new ConcurrencyScheduler({ maxConcurrent: 1, queueLimit: 5 });
    const a = await s.acquire('f', 1, soon());
    await expect(s.acquire('f', 1, { deadlineAt: Date.now() + 30 })).rejects.toMatchObject({ details: { reason: 'wait_deadline' } });
    const ac = new AbortController();
    const p = s.acquire('f', 1, { ...soon(), signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ details: { reason: 'aborted' } });
    expect(s.stats().queued).toBe(0);
    a.release();
  });

  it('release is idempotent', async () => {
    const s = new ConcurrencyScheduler({ maxConcurrent: 1, queueLimit: 1 });
    const a = await s.acquire('f', 1, soon());
    a.release();
    a.release();
    expect(s.stats().running).toBe(0);
  });
});
