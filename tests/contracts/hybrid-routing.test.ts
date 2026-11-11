import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEnv, type Env } from '../integration/harness.js';

let env: Env;
beforeEach(async () => { env = await createEnv(); await env.client.connectAws({ region: 'us-east-1' }); });
afterEach(async () => { await env.close(); });
const ARN = 'arn:aws:lambda:us-east-1:123456789012:function:process-order:live';
const local = (over = {}) => ({ runtime: 'nodejs22.x' as const, handler: 'index.handler', sourcePath: env.source({ 'index.js': 'x' }), ...over });

describe('Mode B — invoke an existing native Lambda through Xero', () => {
  it('binds a Lambda-only logical function after read-only verification, without creating anything', async () => {
    const r = await env.client.bindAwsLambda('process-order', { arn: ARN });
    expect(env.lambda.describeCalls).toEqual([ARN]);
    expect(r.function.routing.defaultTarget).toBe('aws-lambda');
    expect(r.function.deployments['aws-lambda']).toMatchObject({ details: { arn: ARN, accountId: '123456789012', region: 'us-east-1', verified: true, observed: { runtime: 'nodejs22.x', handler: 'index.handler' } } });
    expect(r.function.id).not.toContain('arn'); // logical identity is not the ARN
    const out = await env.client.invoke('process-order', { id: 'o-1' });
    expect(out).toMatchObject({ status: 'succeeded', target: 'aws-lambda', awsRequestId: 'aws-req-42', executedVersion: '3', payload: { source: 'native-lambda' } });
    expect(env.lambda.calls[0]).toMatchObject({ arn: ARN, region: 'us-east-1', invocationType: 'RequestResponse' });
    expect(env.backend.started).toHaveLength(0);
  });

  it('preserves AWS semantics: FunctionError is a function-error, errors keep their AWS-specific codes', async () => {
    await env.client.bindAwsLambda('process-order', { arn: ARN });
    env.lambda.response = () => ({ statusCode: 200, functionError: 'Unhandled', executedVersion: '3', awsRequestId: 'r', payload: new TextEncoder().encode('{"errorMessage":"boom"}') });
    expect(await env.client.invoke('process-order', {})).toMatchObject({ status: 'function-error', functionError: 'Unhandled' });
    env.lambda.response = () => { throw new (class extends Error { code = 'AWS_THROTTLED'; })(); };
    await expect(env.client.invoke('process-order', {})).rejects.toMatchObject({ status: 500 }); // untyped errors never leak internals
  });

  it('refuses unverifiable bindings unless explicitly told to skip verification (and says so)', async () => {
    await env.client.disconnectAws();
    await expect(env.client.bindAwsLambda('x', { arn: ARN })).rejects.toMatchObject({ code: 'AWS_NOT_CONNECTED' });
    const r = await env.client.bindAwsLambda('x', { arn: ARN, verify: false });
    expect(r.warnings.join(' ')).toMatch(/UNVERIFIED/);
    expect(r.function.deployments['aws-lambda']!.details.verified).toBe(false);
  });

  it('applies account and region policy to bindings', async () => {
    await expect(env.client.bindAwsLambda('y', { arn: 'arn:aws:lambda:us-east-1:999999999999:function:other:live' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(env.client.bindAwsLambda('y', { arn: 'not-an-arn' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await env.close();
    env = await createEnv({ config: { allowedAccountIds: ['999999999999'], allowedRegions: ['us-east-1'] } });
    await env.client.connectAws({ region: 'us-east-1' });
    await expect(env.client.bindAwsLambda('y', { arn: 'arn:aws:lambda:us-east-1:999999999999:function:other:live' })).resolves.toBeDefined();
    await expect(env.client.bindAwsLambda('z', { arn: 'arn:aws:lambda:eu-west-1:123456789012:function:z:live' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
});

describe('Mode C — one logical function, two independent targets', () => {
  it('registers local + aws-lambda under one name; target is explicit or the static default', async () => {
    await env.client.deployLocal('process-order', local());
    const bound = await env.client.bindAwsLambda('process-order', { arn: ARN });
    const fn = bound.function;
    expect(Object.keys(fn.deployments).sort()).toEqual(['aws-lambda', 'local']);
    expect(fn.deployments.local!.id).not.toBe(fn.deployments['aws-lambda']!.id);
    expect(fn.routing.defaultTarget).toBe('local'); // binding does not silently re-route traffic

    const viaDefault = await env.client.invoke('process-order', {});
    const viaLambda = await env.client.invoke('process-order', {}, { target: 'aws-lambda' });
    const viaLocal = await env.client.invoke('process-order', {}, { target: 'local' });
    expect([viaDefault.target, viaLambda.target, viaLocal.target]).toEqual(['local', 'aws-lambda', 'local']);
    expect(viaDefault.deploymentId).toBe(fn.deployments.local!.id);
    expect(viaLambda.deploymentId).toBe(fn.deployments['aws-lambda']!.id);

    await env.client.setRouting('process-order', 'aws-lambda');
    expect((await env.client.invoke('process-order', {})).target).toBe('aws-lambda');
    const history = await env.client.invocations('process-order');
    expect(history.map((h) => h.target)).toEqual(['aws-lambda', 'local', 'aws-lambda', 'local']);
  });

  it('never routes to a target without a deployment and never silently falls back', async () => {
    await env.client.deployLocal('only-local', local());
    await expect(env.client.invoke('only-local', {}, { target: 'aws-lambda' })).rejects.toMatchObject({ code: 'TARGET_NOT_DEPLOYED', status: 409 });
    await expect(env.client.setRouting('only-local', 'aws-lambda')).rejects.toMatchObject({ code: 'TARGET_NOT_DEPLOYED' });
    expect(env.lambda.calls).toHaveLength(0);
  });

  it('does not replay an unknown outcome on the other target', async () => {
    await env.client.deployLocal('process-order', local());
    await env.client.bindAwsLambda('process-order', { arn: ARN, defaultTarget: 'aws-lambda' });
    env.lambda.offline = true;
    await expect(env.client.invoke('process-order', {})).rejects.toMatchObject({ code: 'AWS_REQUEST_FAILED' });
    expect(env.backend.started).toHaveLength(0);
  });

  it('rejects incompatible targets instead of silently accepting them', async () => {
    await env.client.deployLocal('mismatch', local());
    env.lambda.observed = { ...env.lambda.observed, runtime: 'python3.12', handler: 'app.handler' };
    await expect(env.client.bindAwsLambda('mismatch', { arn: ARN })).rejects.toMatchObject({ code: 'INCOMPATIBLE_TARGET' });
    env.lambda.observed = { ...env.lambda.observed, runtime: 'nodejs20.x', handler: 'other.handler' };
    const ok = await env.client.bindAwsLambda('mismatch', { arn: ARN });
    expect(ok.warnings.join(' ')).toMatch(/runtime differs/);
    expect(ok.warnings.join(' ')).toMatch(/handler differs/);
  });

  it('updating one target leaves the other untouched', async () => {
    await env.client.deployLocal('process-order', local());
    await env.client.bindAwsLambda('process-order', { arn: ARN });
    await env.client.deployLocal('process-order', local());
    const f = (await env.client.inspect('process-order')).function;
    expect(f.deployments.local!.version).toBe(2);
    expect(f.deployments['aws-lambda']!.version).toBe(1);
    await env.client.removeDeployment('process-order', 'aws-lambda');
    expect((await env.client.inspect('process-order')).function.deployments['aws-lambda']).toBeUndefined();
    await expect(env.client.invoke('process-order', {})).resolves.toMatchObject({ target: 'local' });
  });

  it('async invocation of the native Lambda is acceptance, not completion', async () => {
    await env.client.bindAwsLambda('process-order', { arn: ARN });
    const r = await env.client.invoke('process-order', { a: 1 }, { type: 'Event' });
    expect(r.status).toBe('accepted');
    expect(env.lambda.calls[0]!.invocationType).toBe('Event');
  });

  it('cost visibility: AWS requests are counted per operation', async () => {
    await env.client.bindAwsLambda('process-order', { arn: ARN });
    await env.client.invoke('process-order', {});
    await env.client.invoke('process-order', {});
    const m = await env.client.metrics();
    const count = (op: string) => m.series.filter((s) => s.name === 'aws_requests_total' && s.labels.operation === op).reduce((a, s) => a + (s.value ?? 0), 0);
    expect(count('lambda:Invoke')).toBe(2);
    expect(count('lambda:GetFunctionConfiguration')).toBe(1);
    expect(count('sts:GetCallerIdentity')).toBe(1);
  });
});
