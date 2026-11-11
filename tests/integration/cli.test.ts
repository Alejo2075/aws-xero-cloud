import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../../apps/cli/src/index.js';
import { createEnv, type Env } from './harness.js';

let env: Env;
beforeEach(async () => { env = await createEnv(); });
afterEach(async () => { await env.close(); });

async function xero(args: string[], opts: { stdin?: string; cwd?: string } = {}): Promise<{ code: number; out: string; err: string }> {
  let out = '', err = '';
  const code = await run(args, {
    client: async () => env.client, stdout: (s) => (out += s), stderr: (s) => (err += s), stdin: async () => opts.stdin ?? '', cwd: opts.cwd ?? env.work,
  });
  return { code, out, err };
}

describe('xero CLI over the SDK', () => {
  it('deploy → invoke → inspect → logs → update → remove', async () => {
    const dir = env.source({ 'index.js': 'exports.handler = async (e) => e;' });
    env.backend.handler = (_s, r) => ({ outcome: 'ok', payload: new TextEncoder().encode(JSON.stringify({ echoed: JSON.parse(new TextDecoder().decode(r.payload)) })) });

    const d = await xero(['deploy', dir, '--name', 'hello', '--memory', '256', '--timeout', '4', '--env', 'A=1', '--env', 'B=x=y']);
    expect(d).toMatchObject({ code: 0 });
    expect(d.out).toContain('Deployed hello → local v1');
    const spec = (await env.client.inspect('hello')).function.deployments.local!;
    expect(spec.details).toMatchObject({ runtime: 'nodejs22.x', handler: 'index.handler', memoryMb: 256, timeoutSec: 4, environmentKeys: ['A', 'B'] });

    const i = await xero(['invoke', 'hello', '--payload', '{"name":"Ada"}']);
    expect(i.code).toBe(0);
    expect(JSON.parse(i.out)).toEqual({ echoed: { name: 'Ada' } });
    expect(i.err).toMatch(/succeeded target=local request=req_\w+ cold-start/);
    expect((await xero(['invoke', 'hello'], {})).code).toBe(0);
    expect((await xero(['invoke', 'hello', '--payload', '-'], { stdin: '{"x":1}' })).out).toContain('"x": 1');

    const ins = await xero(['functions', 'inspect', 'hello']);
    expect(ins.out).toMatch(/local: v1 active/);
    expect(ins.out).toMatch(/aws-lambda: not deployed/);
    expect((await xero(['functions', 'list'])).out).toMatch(/hello\s+local\s+v1/);

    env.backend.emitLog([...env.backend.alive.keys()][0]!, 'stderr', 'something happened');
    await new Promise((r) => setTimeout(r, 400));
    expect((await xero(['logs', 'hello'])).out).toContain('ERR');

    expect((await xero(['update', 'hello', dir, '--timeout', '9'])).out).toContain('Updated hello → local v2');
    const rm = await xero(['remove', 'hello']);
    expect(rm.out).toContain('Removed function hello');
    expect((await xero(['functions', 'list'])).out).toBe('No functions deployed.\n');
  });

  it('prints function errors and exits 3; --json output is machine readable', async () => {
    const dir = env.source({ 'index.js': 'x' });
    await xero(['deploy', dir, '--name', 'bad']);
    env.backend.handler = () => ({ outcome: 'function-error', payload: new TextEncoder().encode('{"errorMessage":"nope"}') });
    const r = await xero(['invoke', 'bad', '--json']);
    expect(r.code).toBe(3);
    expect(JSON.parse(r.out)).toMatchObject({ status: 'function-error', functionError: 'Unhandled', payload: { errorMessage: 'nope' } });
  });

  it('reads xero.yaml and lets flags override it; binds the aws-lambda deployment explicitly', async () => {
    const dir = env.source({
      'index.js': 'x',
      'xero.yaml': `apiVersion: xero.dev/v1alpha1
kind: Function
metadata: { name: process-order }
spec:
  runtime: nodejs22.x
  handler: index.handler
  deployments:
    local: { memoryMb: 512, timeoutSec: 6, environment: { TABLE_NAME: orders } }
    aws-lambda: { mode: existing, arn: "arn:aws:lambda:us-east-1:123456789012:function:process-order:live" }
  routing: { strategy: manual, defaultTarget: local }
`,
    });
    await xero(['aws', 'connect', '--region', 'us-east-1']);
    const r = await xero(['deploy', dir, '--timeout', '8']);
    expect(r.code).toBe(0);
    const f = (await env.client.inspect('process-order')).function;
    expect(f.deployments.local!.details).toMatchObject({ memoryMb: 512, timeoutSec: 8, environmentKeys: ['TABLE_NAME'] });
    expect(f.deployments['aws-lambda']!.details.arn).toContain('function:process-order:live');
    const a = await xero(['invoke', 'process-order', '--target', 'aws-lambda']);
    expect(a.err).toContain('target=aws-lambda');
    expect(a.err).toContain('aws-request=aws-req-42');
  });

  it('manages AWS connection, bindings, routing and event sources', async () => {
    expect((await xero(['aws', 'status'])).out).toContain('Not connected to AWS (local-only mode)');
    expect((await xero(['aws', 'connect', '--profile', 'development', '--region', 'us-east-1'])).out).toContain('Connected to AWS account 123456789012');
    const dir = env.source({ 'index.js': 'x' });
    await xero(['deploy', dir, '--name', 'hello']);
    const b = await xero(['functions', 'bind', 'hello', '--arn', 'arn:aws:lambda:us-east-1:123456789012:function:hello:live']);
    expect(b.out).toContain('Bound hello →');
    expect((await xero(['functions', 'route', 'hello', '--default-target', 'aws-lambda'])).out).toContain('default target is now aws-lambda');
    expect((await xero(['invoke', 'hello'])).err).toContain('target=aws-lambda');
    expect((await xero(['functions', 'unbind', 'hello', '--target', 'aws-lambda'])).code).toBe(1); // default target must be changed first
    await xero(['functions', 'route', 'hello', '--default-target', 'local']);
    expect((await xero(['functions', 'unbind', 'hello'])).out).toContain('nothing was changed in AWS');
    expect((await xero(['functions', 'history', 'hello'])).out).toContain('aws-lambda');
    expect((await xero(['events', 'list'])).out).toBe('No event sources.\n');
    expect((await xero(['metrics'])).out).toContain('aws_requests_total');
    expect((await xero(['status'])).out).toContain('connected (123456789012)');
    expect((await xero(['aws', 'disconnect'])).code).toBe(0);
  });

  it('reports usage errors with exit code 2 and API errors with exit code 1', async () => {
    expect((await xero([])).code).toBe(2);
    expect((await xero(['help'])).code).toBe(0);
    expect((await xero(['wat'])).code).toBe(2);
    expect((await xero(['invoke'])).err).toContain('missing function name');
    expect((await xero(['invoke', 'x', '--payload', '{bad'])).err).toContain('not valid JSON');
    expect((await xero(['invoke', 'x', '--target', 'mars'])).code).toBe(2);
    expect((await xero(['deploy', env.source({ 'readme.txt': 'x' })])).err).toContain('cannot infer runtime');
    const nf = await xero(['invoke', 'ghost']);
    expect(nf.code).toBe(1);
    expect(nf.err).toMatch(/error \[FUNCTION_NOT_FOUND\]/);
  });

  it('infers Python functions from lambda_function.py', async () => {
    const dir = env.source({ 'lambda_function.py': 'def lambda_handler(e, c):\n    return e\n' });
    expect((await xero(['deploy', dir, '--name', 'py'])).code).toBe(0);
    expect((await env.client.inspect('py')).function.deployments.local!.details).toMatchObject({ runtime: 'python3.13', handler: 'lambda_function.lambda_handler' });
  });
});
