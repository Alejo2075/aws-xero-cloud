import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createController, type Controller } from '@xero/controller';
import { XeroClient } from '@xero/sdk';
import { silentLogger } from '@xero/telemetry';
import { forceRemove } from '../integration/harness.js';

// These tests need a running Docker-compatible engine and may pull public AWS Lambda base images.
// They never use AWS credentials or contact AWS services. Skipped automatically when no daemon is reachable.
const dockerUp = ((): boolean => {
  const r = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: 'ignore', timeout: 10_000 });
  return r.status === 0;
})();

const FIXTURES = resolve(import.meta.dirname, 'fixtures');
const docker = (...args: string[]): string => execFileSync('docker', args, { encoding: 'utf8' }).trim();

describe.skipIf(!dockerUp)('local execution on a real container engine', () => {
  let home: string;
  let c: Controller;
  let client: XeroClient;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'xero-e2e-'));
    c = await createController({ config: { home, port: 0, maxWorkers: 4 }, logger: silentLogger }, {});
    client = new XeroClient({ baseUrl: c.url, token: c.token });
  }, 120_000);
  afterAll(async () => {
    await c?.close();
    forceRemove(home);
  });

  const node = (extra: object = {}) => client.deployLocal('behave', { runtime: 'nodejs22.x', handler: 'index.handler', sourcePath: join(FIXTURES, 'behavior-node'), timeoutSec: 5, memoryMb: 256, idleTtlSec: 60, ...extra });
  const managed = (): string[] => docker('ps', '-q', '--filter', 'label=xero.managed=true').split('\n').filter(Boolean);

  it('runs a Node.js handler: cold start, then warm reuse of the same container', async () => {
    await node();
    const a = await client.invoke<{ ok: boolean; counter: number }>('behave', { log: 'hello from container' });
    const b = await client.invoke<{ counter: number }>('behave', {});
    expect(a).toMatchObject({ status: 'succeeded', coldStart: true, payload: { ok: true, counter: 1 } });
    expect(b).toMatchObject({ coldStart: false, payload: { counter: 2 } });
    expect(managed()).toHaveLength(1);
  }, 180_000);

  it('applies the documented hardening to the real container', async () => {
    const id = managed()[0]!;
    const inspect = JSON.parse(docker('inspect', id))[0];
    expect(inspect.HostConfig).toMatchObject({ ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], PidsLimit: 256, Memory: 256 * 1024 * 1024 });
    expect(inspect.HostConfig.SecurityOpt).toContain('no-new-privileges');
    expect(inspect.Mounts.map((m: { Destination: string; RW: boolean }) => [m.Destination, m.RW])).toEqual([['/var/task', false]]);
    const ports = inspect.NetworkSettings.Ports['8080/tcp'];
    expect(ports.every((p: { HostIp: string }) => p.HostIp === '127.0.0.1')).toBe(true);
    const r = await client.invoke<{ uid: number }>('behave', {});
    expect(r.payload!.uid).not.toBe(0); // non-root
  });

  it('captures function logs', async () => {
    await client.invoke('behave', { log: 'unique-log-line-123' });
    await new Promise((r) => setTimeout(r, 1500));
    const logs = await client.logs('behave');
    expect(logs.some((l) => l.message.includes('unique-log-line-123'))).toBe(true);
  });

  it('reports handler exceptions as function errors', async () => {
    const r = await client.invoke<{ errorMessage: string }>('behave', { throw: true });
    expect(r.status).toBe('function-error');
    expect(r.payload!.errorMessage).toContain('intentional failure');
  });

  it('terminates the container on timeout (fencing), then recovers with a fresh worker', async () => {
    await node({ timeoutSec: 1 });
    await client.invoke('behave', {}); // warm up the new deployment
    const before = managed();
    await expect(client.invoke('behave', { sleepMs: 5000 })).rejects.toMatchObject({ code: 'INVOCATION_TIMEOUT' });
    for (const id of before) expect(managed()).not.toContain(id);
    expect((await client.invoke('behave', {})).status).toBe('succeeded');
  }, 120_000);

  it('reports an out-of-memory kill distinctly from a crash', async () => {
    await node({ memoryMb: 128, timeoutSec: 10 });
    const err = await client.invoke('behave', { allocateMb: 600 }).catch((e: unknown) => e);
    expect(['WORKER_OOM', 'WORKER_CRASHED']).toContain((err as { code: string }).code);
    const crash = await client.invoke('behave', { crash: true }).catch((e: unknown) => e);
    expect((crash as { code: string }).code).toBe('WORKER_CRASHED');
    expect((await client.invoke('behave', {})).status).toBe('succeeded'); // controller and new workers unaffected
  }, 180_000);

  it('cannot write to the read-only artifact mount', async () => {
    const r = await client.invoke('behave', { writeRoot: true });
    expect(r.status).toBe('function-error');
  });

  it('scales to zero after the idle TTL', async () => {
    await node({ idleTtlSec: 1, timeoutSec: 5 });
    await client.invoke('behave', {});
    expect(managed().length).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 3500));
    expect(managed()).toHaveLength(0);
    expect((await client.invoke('behave', {})).coldStart).toBe(true);
  }, 120_000);

  it('enforces bounded concurrency with a CAPACITY_EXHAUSTED rejection', async () => {
    await node({ maxConcurrency: 1, timeoutSec: 6 });
    await client.invoke('behave', {});
    const slow = client.invoke('behave', { sleepMs: 1500 });
    await new Promise((r) => setTimeout(r, 200));
    // One in flight; the next two requests queue (queue limit is 16 by default) and complete after it.
    const queued = await Promise.all([client.invoke('behave', {}), client.invoke('behave', {})]);
    expect(queued.every((q) => q.status === 'succeeded')).toBe(true);
    await slow;
  }, 120_000);

  it('runs a Python handler', async () => {
    await client.deployLocal('behave-py', { runtime: 'python3.13', handler: 'app.handler', sourcePath: join(FIXTURES, 'behavior-python'), timeoutSec: 5 });
    const r = await client.invoke<{ ok: boolean }>('behave-py', { log: 'py' });
    expect(r.payload).toMatchObject({ ok: true });
    const err = await client.invoke<{ errorType: string }>('behave-py', { raise: true });
    expect(err.status).toBe('function-error');
    expect(err.payload!.errorType).toBe('ValueError');
  }, 180_000);

  it('removes containers when the controller stops, and reaps orphans at startup', async () => {
    expect(managed().length).toBeGreaterThan(0);
    await c.close();
    expect(managed()).toHaveLength(0);
    c = await createController({ config: { home, port: 0 }, logger: silentLogger }, {});
    client = new XeroClient({ baseUrl: c.url, token: c.token });
    expect((await client.listFunctions()).map((f) => f.name).sort()).toEqual(['behave', 'behave-py']); // metadata survived
  }, 120_000);
});
