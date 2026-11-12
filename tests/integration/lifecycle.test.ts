import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { XeroApiError, XeroClient } from '@xero/sdk';
import { createEnv, waitFor, type Env } from './harness.js';

let env: Env;
beforeEach(async () => { env = await createEnv(); });
afterEach(async () => { await env.close(); });

const node = () => env.source({ 'index.js': 'exports.handler = async (e) => e;' });
const py = () => env.source({ 'app.py': 'def handler(event, context):\n    return event\n' });

describe('local function lifecycle through the SDK', () => {
  it('deploys, invokes, shows logs, updates and removes a Node.js function (no AWS involved)', async () => {
    const dep = await env.client.deployLocal('hello', { runtime: 'nodejs22.x', handler: 'index.handler', sourcePath: node(), memoryMb: 256, timeoutSec: 5, environment: { GREETING: 'hi' } });
    expect(dep.function.deployments.local).toMatchObject({ version: 1, target: 'local', details: { runtime: 'nodejs22.x', environmentKeys: ['GREETING'] } });
    expect(JSON.stringify(dep)).not.toContain('"hi"'); // env values are never echoed

    env.backend.handler = (_s, r) => ({ outcome: 'ok', payload: new TextEncoder().encode(JSON.stringify({ hello: JSON.parse(new TextDecoder().decode(r.payload)).name })) });
    const res = await env.client.invoke<{ hello: string }>('hello', { name: 'Ada' });
    expect(res).toMatchObject({ status: 'succeeded', target: 'local', coldStart: true, payload: { hello: 'Ada' } });
    expect(res.requestId).toMatch(/^req_/);
    const warm = await env.client.invoke('hello', { name: 'Grace' });
    expect(warm.coldStart).toBe(false);

    env.backend.emitLog([...env.backend.alive.keys()][0]!, 'stdout', 'START RequestId: abc');
    const logs = await waitFor(() => env.client.logs('hello'), (l) => l.length > 0);
    expect(logs[0]).toMatchObject({ stream: 'stdout', message: 'START RequestId: abc' });

    const inspect = await env.client.inspect('hello');
    expect(inspect.recentInvocations.map((i) => i.status)).toEqual(['succeeded', 'succeeded']);
    expect(inspect.recentInvocations[0]!.deploymentId).toBe(dep.function.deployments.local!.id);

    const upd = await env.client.deployLocal('hello', { runtime: 'nodejs22.x', handler: 'index.handler', sourcePath: env.source({ 'index.js': 'exports.handler = async () => 2;' }) });
    expect(upd.function.deployments.local!.version).toBe(2);
    expect((await env.client.inspect('hello')).history.map((h) => `${h.version}:${h.status}`)).toEqual(['2:active', '1:superseded']);
    const after = await env.client.invoke('hello', {});
    expect(after.coldStart).toBe(true); // old workers were retired, new deployment cold-starts

    await env.client.deleteFunction('hello');
    await expect(env.client.inspect('hello')).rejects.toMatchObject({ code: 'FUNCTION_NOT_FOUND', status: 404 });
    expect(env.backend.alive.size).toBe(0);
  });

  it('deploys Python functions with the python runtime image', async () => {
    await env.client.deployLocal('pyfn', { runtime: 'python3.13', handler: 'app.handler', sourcePath: py() });
    await env.client.invoke('pyfn', {});
    expect(env.backend.started[0]).toMatchObject({ image: 'public.ecr.aws/lambda/python:3.13', command: ['app.handler'], functionName: 'pyfn' });
  });

  it('rejects bad deployments with stable error codes', async () => {
    await expect(env.client.deployLocal('x', { runtime: 'nodejs22.x', handler: 'missing.handler', sourcePath: node() })).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' });
    await expect(env.client.deployLocal('x', { runtime: 'nodejs22.x', handler: 'index.handler', sourcePath: '/definitely/not/here' })).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' });
    await expect(env.client.deployLocal('x', { runtime: 'ruby3.3' as never, handler: 'a.b', sourcePath: node() })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(env.client.deployLocal('bad name!', { runtime: 'nodejs22.x', handler: 'index.handler', sourcePath: node() })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(env.client.deployLocal('x', { runtime: 'nodejs22.x', handler: 'index.handler', sourcePath: node(), environment: { AWS_SECRET_ACCESS_KEY: 'nope' } })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(env.client.listFunctions()).resolves.toEqual([]); // failed deployments leave nothing behind
  });

  it('surfaces handler errors as function-error (HTTP 200 + header) and timeouts as 504', async () => {
    await env.client.deployLocal('flaky', { runtime: 'nodejs22.x', handler: 'index.handler', sourcePath: node(), timeoutSec: 1 });
    env.backend.handler = () => ({ outcome: 'function-error', payload: new TextEncoder().encode('{"errorType":"Error","errorMessage":"boom"}') });
    const r = await env.client.invoke<{ errorMessage: string }>('flaky', {});
    expect(r).toMatchObject({ status: 'function-error', functionError: 'Unhandled', payload: { errorMessage: 'boom' } });
    env.backend.handler = () => new Promise(() => undefined);
    await expect(env.client.invoke('flaky', {})).rejects.toMatchObject({ code: 'INVOCATION_TIMEOUT', status: 504 });
    const inv = await env.client.invocations('flaky');
    expect(inv.map((i) => i.status)).toEqual(['timeout', 'function-error']);
  }, 10_000);

  it('async invoke is accepted with 202 semantics', async () => {
    await env.client.deployLocal('bg', { runtime: 'nodejs22.x', handler: 'index.handler', sourcePath: node() });
    const r = await env.client.invoke('bg', { job: 1 }, { type: 'Event' });
    expect(r.status).toBe('accepted');
    expect(r.payload).toBeUndefined();
  });

  it('metrics expose cold/warm starts and invocation counters', async () => {
    await env.client.deployLocal('m', { runtime: 'nodejs22.x', handler: 'index.handler', sourcePath: node() });
    await env.client.invoke('m', {});
    await env.client.invoke('m', {});
    const m = await env.client.metrics();
    const total = (n: string) => m.series.filter((s) => s.name === n).reduce((a, s) => a + (s.value ?? 0), 0);
    expect(total('cold_starts_total')).toBe(1);
    expect(total('warm_hits_total')).toBe(1);
    expect(total('invocations_total')).toBe(2);
    const prom = await fetch(`${env.controller.url}/v1/metrics?format=prometheus`, { headers: { authorization: `Bearer ${env.controller.token}` } });
    expect(await prom.text()).toContain('xero_cold_starts_total 1');
  });
});

describe('controller API security', () => {
  const raw = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) => fetch(`${env.controller.url}${path}`, init);

  it('requires the bearer token for every route except health', async () => {
    expect((await raw('/v1/health')).status).toBe(200);
    expect((await raw('/v1/functions')).status).toBe(401);
    expect((await raw('/v1/functions', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    expect((await raw('/v1/functions', { headers: { authorization: `Bearer ${env.controller.token}` } })).status).toBe(200);
    const bad = new XeroClient({ baseUrl: env.controller.url, token: 'nope' });
    await expect(bad.listFunctions()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('rejects DNS-rebinding hosts and browser-originated requests', async () => {
    const auth = { authorization: `Bearer ${env.controller.token}` };
    const http = await import('node:http');
    const status = (headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
      const u = new URL(env.controller.url);
      const req = http.request({ host: u.hostname, port: u.port, path: '/v1/functions', headers: { ...auth, ...headers } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject);
      req.end();
    });
    expect(await status({ host: 'evil.example.com' })).toBe(401);
    expect(await status({ origin: 'https://evil.example.com' })).toBe(401);
    expect(await status({})).toBe(200);
  });

  it('refuses to bind to non-loopback addresses', async () => {
    const { createController } = await import('@xero/controller');
    await expect(createController({ config: { home: env.home + '-x', host: '0.0.0.0', port: 0 } }, {})).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('caps management request bodies and validates JSON', async () => {
    const auth = { authorization: `Bearer ${env.controller.token}`, 'content-type': 'application/json' };
    const big = await raw('/v1/functions/x/deployments/local', { method: 'POST', headers: auth, body: JSON.stringify({ pad: 'x'.repeat(2 * 1024 * 1024) }) });
    expect(big.status).toBe(413);
    const bad = await raw('/v1/functions/x/deployments/local', { method: 'POST', headers: auth, body: '{nope' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('INVALID_REQUEST');
  });

  it('writes the token with 0600 permissions', async () => {
    const { statSync } = await import('node:fs');
    const { join } = await import('node:path');
    expect(statSync(join(env.home, 'token')).mode & 0o777).toBe(0o600);
    expect(statSync(env.home).mode & 0o777).toBe(0o700);
  });

  it('error envelope carries a request id and the SDK exposes it', async () => {
    const e = await env.client.inspect('nope').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(XeroApiError);
    expect((e as XeroApiError).requestId).toMatch(/^req_/);
  });
});

describe('operational behaviour', () => {
  it('attributes log lines emitted during an invocation to that invocation', async () => {
    await env.client.deployLocal('attr', { runtime: 'nodejs22.x', handler: 'index.handler', sourcePath: node() });
    env.backend.handler = (_s, r) => {
      env.backend.emitLog([...env.backend.alive.keys()][0]!, 'stdout', `during ${r.requestId}`);
      return { outcome: 'ok', payload: new TextEncoder().encode('{}') };
    };
    const first = await env.client.invoke('attr', {});
    const second = await env.client.invoke('attr', {});
    const logs = await waitFor(() => env.client.logs('attr'), (l) => l.length >= 2);
    expect(logs.map((l) => l.requestId)).toEqual([first.requestId, second.requestId]);
  });

  it('shutdown waits for an in-flight invocation instead of dropping it', async () => {
    await env.client.deployLocal('slow', { runtime: 'nodejs22.x', handler: 'index.handler', sourcePath: node(), timeoutSec: 5 });
    let release!: () => void;
    env.backend.handler = () => new Promise((r) => { release = () => r({ outcome: 'ok', payload: new TextEncoder().encode('{"done":true}') }); });
    const inflight = env.client.invoke<{ done: boolean }>('slow', {});
    await new Promise((r) => setTimeout(r, 50));
    const closing = env.controller.close();
    setTimeout(() => release(), 100);
    await expect(inflight).resolves.toMatchObject({ status: 'succeeded', payload: { done: true } });
    await closing;
    env = await createEnv(); // fresh env for afterEach
  });

  it('minWarm is validated, stored and shown', async () => {
    await expect(env.client.deployLocal('w', { runtime: 'nodejs22.x', handler: 'index.handler', sourcePath: node(), maxConcurrency: 1, minWarm: 2 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    const r = await env.client.deployLocal('w', { runtime: 'nodejs22.x', handler: 'index.handler', sourcePath: node(), maxConcurrency: 2, minWarm: 1, idleTtlSec: 0 });
    expect(r.function.deployments.local!.details).toMatchObject({ minWarm: 1 });
    await env.client.invoke('w', {});
    await new Promise((r) => setTimeout(r, 1200));
    expect(env.backend.alive.size).toBe(1); // idleTtl 0 would normally stop it immediately
  });

  it('drops emulator chatter but keeps function output and runtime warnings', async () => {
    await env.client.deployLocal('noisy', { runtime: 'nodejs22.x', handler: 'index.handler', sourcePath: node() });
    await env.client.invoke('noisy', {});
    const id = [...env.backend.alive.keys()][0]!;
    env.backend.emitLog(id, 'stderr', '12 Nov 2026 02:32:30,563 [INFO] (rapid) exec \'/var/runtime/bootstrap\'');
    env.backend.emitLog(id, 'stdout', 'user output');
    env.backend.emitLog(id, 'stderr', '12 Nov 2026 02:32:31,000 [WARNING] (rapid) something odd');
    const logs = await waitFor(() => env.client.logs('noisy'), (l) => l.length >= 2);
    expect(logs.map((l) => l.message)).toEqual(['user output', '12 Nov 2026 02:32:31,000 [WARNING] (rapid) something odd']);
  });
});

