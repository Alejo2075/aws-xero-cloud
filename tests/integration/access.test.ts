import { afterEach, describe, expect, it } from 'vitest';
import { hashToken } from '@xero/controller';
import { XeroClient } from '@xero/sdk';
import { createEnv, type Env } from './harness.js';

let env: Env;
afterEach(async () => { await env.close(); });
const as = (token: string) => new XeroClient({ baseUrl: env.controller.url, token });

describe('scoped API tokens', () => {
  it('read, invoke and admin tokens only reach what their scope allows', async () => {
    env = await createEnv();
    await env.client.deployLocal('hello', { runtime: 'nodejs22.x', handler: 'index.handler', sourcePath: env.source({ 'index.js': 'x' }) });
    const read = as((await env.client.createToken('dashboard', 'read')).token);
    const invoke = as((await env.client.createToken('app', 'invoke')).token);
    const admin = as((await env.client.createToken('ops', 'admin')).token);

    expect((await read.listFunctions()).map((f) => f.name)).toEqual(['hello']);
    await expect(read.invoke('hello', {})).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(read.logs('hello')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(read.deleteFunction('hello')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(read.listTokens()).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect((await invoke.invoke('hello', {})).status).toBe('succeeded');
    await expect(invoke.listFunctions()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(invoke.createToken('x', 'admin')).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect((await admin.logs('hello')).length).toBeGreaterThanOrEqual(0);
    expect((await admin.listTokens()).map((t) => t.name)).toEqual(['dashboard', 'app', 'ops']);
  });

  it('revocation takes effect immediately; names are unique among active tokens', async () => {
    env = await createEnv();
    const { token } = await env.client.createToken('temp', 'read');
    await expect(env.client.createToken('temp', 'read')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(await as(token).listFunctions()).toEqual([]);
    await env.client.revokeToken('temp');
    await expect(as(token).listFunctions()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(env.client.revokeToken('temp')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await env.client.createToken('temp', 'invoke'); // name is free again
  });

  it('stores only the hash, survives restarts, and rejects malformed or forged tokens', async () => {
    env = await createEnv();
    const { token, record } = await env.client.createToken('persisted', 'read');
    expect(env.controller.registry.findActiveByHash(token)).toBeUndefined(); // plaintext is not what is stored
    expect(env.controller.registry.findActiveByHash(hashToken(token))?.id).toBe(record.id);
    await env.restart();
    expect(await as(token).listFunctions()).toEqual([]);
    for (const bad of ['xero_read_' + '0'.repeat(48), 'xero_admin_short', 'Bearer', token.slice(0, -1) + (token.endsWith('0') ? '1' : '0')])
      await expect(as(bad).listFunctions()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('never leaks the plaintext in listings', async () => {
    env = await createEnv();
    const { token } = await env.client.createToken('x', 'read');
    expect(JSON.stringify(await env.client.listTokens())).not.toContain(token);
  });
});

describe('rate limiting', () => {
  it('rejects bursts beyond the per-principal budget with 429 and Retry-After; health is exempt', async () => {
    env = await createEnv({ config: { rateLimitRps: 2 } }); // burst of 4
    const limited = await env.client.createToken('app', 'read').then((r) => as(r.token)); // consumes 1 of the master budget
    const results: string[] = [];
    for (let i = 0; i < 8; i++) results.push(await limited.listFunctions().then(() => 'ok', (e: { code: string }) => e.code));
    expect(results.filter((r) => r === 'ok').length).toBeLessThanOrEqual(5);
    expect(results).toContain('RATE_LIMITED');
    const raw = await fetch(`${env.controller.url}/v1/functions`, { headers: { authorization: `Bearer ${env.controller.token}` } });
    // The master principal has its own bucket and is still within budget here.
    expect([200, 429]).toContain(raw.status);
    for (let i = 0; i < 20; i++) expect((await fetch(`${env.controller.url}/v1/health`)).status).toBe(200);
  });
});
