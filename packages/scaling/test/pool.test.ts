import { describe, expect, it } from 'vitest';
import { FakeExecutionBackend, type WorkerSpec } from '@xero/execution';
import { WorkerPool, type WorkerRequest } from '../src/index.js';

const spec = (workerId: string, deploymentId = 'dep_1'): WorkerSpec => ({ workerId, functionId: 'fn_1', deploymentId, functionName: 'f', image: 'img', command: ['h'], artifactPath: '/a', memoryMb: 128, timeoutSec: 3, environment: {} });
const req = (deploymentId = 'dep_1', idleTtlMs = 60_000, expires?: number): WorkerRequest => ({
  deploymentId, functionId: 'fn_1', idleTtlMs,
  build: async (id) => ({ spec: spec(id, deploymentId), credentialsExpireAt: expires }),
});
function clock() { let t = 1_000_000; return { now: () => t, advance: (ms: number) => { t += ms; } }; }

describe('WorkerPool', () => {
  it('cold starts then reuses warm workers', async () => {
    const backend = new FakeExecutionBackend();
    const pool = new WorkerPool({ backend, maxWorkers: 4 });
    const a = await pool.checkout(req());
    expect(a.cold).toBe(true);
    await pool.checkin(a.worker, { healthy: true });
    const b = await pool.checkout(req());
    expect(b.cold).toBe(false);
    expect(b.worker).toBe(a.worker);
    expect(backend.started).toHaveLength(1);
  });

  it('does not share a busy worker', async () => {
    const pool = new WorkerPool({ backend: new FakeExecutionBackend(), maxWorkers: 4 });
    const a = await pool.checkout(req());
    const b = await pool.checkout(req());
    expect(b.worker).not.toBe(a.worker);
    expect(pool.stats()).toEqual({ total: 2, busy: 2, idle: 0 });
  });

  it('scales to zero after the idle TTL', async () => {
    const backend = new FakeExecutionBackend();
    const c = clock();
    const pool = new WorkerPool({ backend, maxWorkers: 4, clock: c });
    const a = await pool.checkout(req('dep_1', 30_000));
    await pool.checkin(a.worker, { healthy: true });
    c.advance(29_000);
    expect(await pool.reapIdle()).toBe(0);
    c.advance(1_500);
    expect(await pool.reapIdle()).toBe(1);
    expect(pool.stats().total).toBe(0);
    expect(backend.alive.size).toBe(0);
  });

  it('never reaps busy workers and stops immediately when TTL is 0', async () => {
    const backend = new FakeExecutionBackend();
    const c = clock();
    const pool = new WorkerPool({ backend, maxWorkers: 4, clock: c });
    const busy = await pool.checkout(req('dep_1', 1000));
    c.advance(10_000);
    expect(await pool.reapIdle()).toBe(0);
    await pool.checkin(busy.worker, { healthy: true });
    const z = await pool.checkout(req('dep_2', 0));
    await pool.checkin(z.worker, { healthy: true });
    expect(pool.list().some((w) => w.deploymentId === 'dep_2')).toBe(false);
  });

  it('evicts the LRU idle worker at the host bound and rejects when all are busy', async () => {
    const backend = new FakeExecutionBackend();
    const c = clock();
    const pool = new WorkerPool({ backend, maxWorkers: 2, clock: c });
    const a = await pool.checkout(req('dep_a'));
    c.advance(10);
    const b = await pool.checkout(req('dep_b'));
    await pool.checkin(a.worker, { healthy: true });
    c.advance(10);
    await pool.checkin(b.worker, { healthy: true });
    const cc = await pool.checkout(req('dep_c'));
    expect(cc.cold).toBe(true);
    expect(pool.list().map((w) => w.deploymentId).sort()).toEqual(['dep_b', 'dep_c']);
    await pool.checkout(req('dep_b'));
    await expect(pool.checkout(req('dep_d'))).rejects.toMatchObject({ code: 'CAPACITY_EXHAUSTED' });
  });

  it('stops unhealthy workers and recycles workers with expiring credentials', async () => {
    const backend = new FakeExecutionBackend();
    const c = clock();
    const pool = new WorkerPool({ backend, maxWorkers: 4, clock: c, credentialRefreshMarginMs: 5 * 60_000 });
    const a = await pool.checkout(req('dep_1', 60_000, c.now() + 10 * 60_000));
    await pool.checkin(a.worker, { healthy: false });
    expect(pool.stats().total).toBe(0);
    const b = await pool.checkout(req('dep_1', 60_000, c.now() + 10 * 60_000));
    await pool.checkin(b.worker, { healthy: true });
    c.advance(6 * 60_000); // now within the 5 minute refresh margin
    const d = await pool.checkout(req('dep_1', 60_000, c.now() + 60 * 60_000));
    expect(d.cold).toBe(true);
    expect(d.worker).not.toBe(b.worker);
    expect(backend.stopped.length).toBeGreaterThanOrEqual(2);
  });

  it('retires deployments: idle now, busy on return', async () => {
    const backend = new FakeExecutionBackend();
    const pool = new WorkerPool({ backend, maxWorkers: 4 });
    const a = await pool.checkout(req());
    const b = await pool.checkout(req());
    await pool.checkin(a.worker, { healthy: true });
    await pool.retireDeployment('dep_1');
    expect(pool.stats().total).toBe(1);
    await pool.checkin(b.worker, { healthy: true });
    expect(pool.stats().total).toBe(0);
  });

  it('attributes streamed logs to the worker and stops streaming on stop', async () => {
    const backend = new FakeExecutionBackend();
    const seen: string[] = [];
    const pool = new WorkerPool({ backend, maxWorkers: 2, onLog: (_w, _s, line) => seen.push(line) });
    const a = await pool.checkout(req());
    backend.emitLog(a.worker.handle.backendId, 'stdout', 'hello');
    await pool.stopAll();
    backend.emitLog(a.worker.handle.backendId, 'stdout', 'after');
    expect(seen).toEqual(['hello']);
  });
});
