import { mkdtempSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { restoreBackup } from '@xero/controller';
import { SqliteRegistry } from '@xero/registry';
import { run } from '../../apps/cli/src/index.js';
import { createEnv, forceRemove, type Env } from './harness.js';

let env: Env;
beforeEach(async () => { env = await createEnv(); });
afterEach(async () => { await env.close(); });
const deploy = (name: string) => env.client.deployLocal(name, { runtime: 'nodejs22.x', handler: 'index.handler', sourcePath: env.source({ 'index.js': 'x' }) });

async function xero(args: string[]) {
  let out = '', err = '';
  const code = await run(args, { client: async () => env.client, stdout: (s) => (out += s), stderr: (s) => (err += s), stdin: async () => '', cwd: env.work });
  return { code, out, err };
}

describe('backup and restore', () => {
  it('snapshots the registry (0600) and restores it offline, keeping the previous database', async () => {
    await deploy('keep');
    const { path } = await env.client.createBackup();
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    await deploy('added-after-backup');
    await env.controller.close();
    const r = restoreBackup(env.home, path);
    expect(r.previous && existsSync(r.previous)).toBe(true);
    await env.restart();
    expect((await env.client.listFunctions()).map((f) => f.name)).toEqual(['keep']);
    expect((await env.client.invoke('keep', {})).status).toBe('succeeded'); // artifacts are content-addressed and untouched
  });

  it('refuses to restore a snapshot from a newer schema and leaves the live database alone', async () => {
    await deploy('safe');
    await env.controller.close();
    const dir = mkdtempSync(join(tmpdir(), 'xero-newer-'));
    const newer = join(dir, 'newer.db');
    new SqliteRegistry(newer, { migrations: [{ version: 1, name: 'a', sql: 'CREATE TABLE a (x INTEGER);' }, { version: 999, name: 'z', sql: 'CREATE TABLE z (x INTEGER);' }] }).close();
    expect(() => restoreBackup(env.home, newer)).toThrowError(expect.objectContaining({ code: 'STATE_INCOMPATIBLE' }));
    expect(() => restoreBackup(env.home, join(dir, 'missing.db'))).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    forceRemove(dir);
    await env.restart();
    expect((await env.client.listFunctions()).map((f) => f.name)).toEqual(['safe']);
  });
});

describe('images, doctor and readiness', () => {
  it('pre-pulls the distinct base images of every supported runtime', async () => {
    const r = await env.client.pullImages();
    expect(r.pulled.sort()).toEqual(['public.ecr.aws/lambda/nodejs:20', 'public.ecr.aws/lambda/nodejs:22', 'public.ecr.aws/lambda/python:3.12', 'public.ecr.aws/lambda/python:3.13']);
    expect((env.backend as unknown as { pulled: string[] }).pulled).toHaveLength(4);
    const cli = await xero(['images', 'pull', 'python3.13']);
    expect(cli.out).toContain('python:3.13');
    await expect(env.client.pullImages(['ruby3.3'])).rejects.toMatchObject({ code: 'RUNTIME_UNSUPPORTED' });
  });

  it('doctor reports failures and warnings with an exit code, and never contains secrets', async () => {
    const good = await xero(['doctor']);
    expect(good.code).toBe(0);
    expect(good.out).toMatch(/ok\s+container-engine/);
    expect(good.out).toContain('not connected (local-only mode)');
    env.backend.down = true;
    const bad = await xero(['doctor']);
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/FAIL\s+container-engine/);
    await env.client.connectAws({ region: 'us-east-1' });
    env.identity.failVerify = new (await import('@xero/core')).XeroError('AWS_CREDENTIALS_ERROR', 'x');
    expect((await xero(['doctor'])).out).toMatch(/WARN\s+aws/);
  });

  it('/v1/ready is unauthenticated, minimal and reflects the engine', async () => {
    let r = await fetch(`${env.controller.url}/v1/ready`);
    expect(await r.json()).toEqual({ ready: true, engine: true });
    env.backend.down = true;
    r = await fetch(`${env.controller.url}/v1/ready`);
    expect(await r.json()).toEqual({ ready: true, engine: false });
  });

  it('backup via CLI', async () => {
    const r = await xero(['backup']);
    expect(r.out).toContain('Backup written to');
    expect(r.out).toContain('xero-controller restore --from');
  });
});
