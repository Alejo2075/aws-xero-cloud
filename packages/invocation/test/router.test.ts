import { describe, expect, it } from 'vitest';
import { XeroError } from '@xero/core';
import { dec, enc, harness, lambdaConfig, localConfig } from './harness.js';

const routing = (defaultTarget: 'local' | 'aws-lambda') => ({ strategy: 'manual', defaultTarget }) as const;

function hybrid(h: ReturnType<typeof harness>, defaultTarget: 'local' | 'aws-lambda' = 'local') {
  const fn = h.registry.createFunction({ name: 'hello', description: undefined, routing: routing(defaultTarget) });
  const local = h.registry.addDeployment(fn.id, { target: 'local', config: localConfig() });
  const aws = h.registry.addDeployment(fn.id, { target: 'aws-lambda', config: lambdaConfig });
  h.registry.setAwsConnection({ profile: 'p', region: 'us-east-1', accountId: '123456789012', principalArn: 'arn:aws:iam::123456789012:user/u', verifiedAt: 1 });
  return { fn, local, aws };
}

describe('InvocationRouter — one logical function, two targets', () => {
  it('uses the static default target and records which deployment handled it', async () => {
    const h = harness();
    const { local } = hybrid(h);
    h.backend.handler = (_s, r) => ({ outcome: 'ok', payload: r.payload });
    const res = await h.router.invoke({ functionName: 'hello', payload: enc({ name: 'Ada' }) });
    expect(res).toMatchObject({ target: 'local', deploymentId: local.id, status: 'succeeded', coldStart: true });
    expect(dec(res.payload)).toEqual({ name: 'Ada' });
    expect(h.lambda.calls).toHaveLength(0);
    const rec = h.registry.listInvocations(res.functionId, 5)[0]!;
    expect(rec).toMatchObject({ target: 'local', deploymentId: local.id, status: 'succeeded', requestId: res.requestId, attemptId: res.attemptId, source: 'api' });
  });

  it('routes explicitly to aws-lambda and preserves AWS metadata', async () => {
    const h = harness();
    const { aws } = hybrid(h);
    const res = await h.router.invoke({ functionName: 'hello', target: 'aws-lambda', payload: enc({ a: 1 }), traceId: 'Root=1-abc' });
    expect(res).toMatchObject({ target: 'aws-lambda', deploymentId: aws.id, status: 'succeeded', awsRequestId: 'aws-req-1', executedVersion: '7' });
    expect(h.lambda.calls[0]).toMatchObject({ arn: lambdaConfig.arn, region: 'us-east-1', invocationType: 'RequestResponse', traceId: 'Root=1-abc' });
    expect(h.backend.started).toHaveLength(0);
    expect(h.metrics.counter('aws_requests_total', { operation: 'lambda:Invoke' })).toBe(1);
  });

  it('honours a default target of aws-lambda and still allows explicit local', async () => {
    const h = harness();
    hybrid(h, 'aws-lambda');
    expect((await h.router.invoke({ functionName: 'hello', payload: enc({}) })).target).toBe('aws-lambda');
    expect((await h.router.invoke({ functionName: 'hello', target: 'local', payload: enc({}) })).target).toBe('local');
  });

  it('never falls back: missing target deployment is TARGET_NOT_DEPLOYED and nothing executes', async () => {
    const h = harness();
    const fn = h.registry.createFunction({ name: 'only-local', description: undefined, routing: routing('local') });
    h.registry.addDeployment(fn.id, { target: 'local', config: localConfig() });
    await expect(h.router.invoke({ functionName: 'only-local', target: 'aws-lambda', payload: enc({}) })).rejects.toMatchObject({ code: 'TARGET_NOT_DEPLOYED' });
    expect(h.lambda.calls).toHaveLength(0);
    expect(h.registry.listInvocations(fn.id, 1)[0]).toMatchObject({ status: 'rejected', errorCode: 'TARGET_NOT_DEPLOYED' });
  });

  it('surfaces function errors as function-error (not success) for both targets', async () => {
    const h = harness();
    hybrid(h);
    h.backend.handler = () => ({ outcome: 'function-error', payload: enc({ errorType: 'Error', errorMessage: 'bad' }) });
    h.lambda.behavior = () => ({ statusCode: 200, functionError: 'Unhandled', executedVersion: '1', awsRequestId: 'x', payload: enc({ errorMessage: 'bad' }) });
    const l = await h.router.invoke({ functionName: 'hello', target: 'local', payload: enc({}) });
    const a = await h.router.invoke({ functionName: 'hello', target: 'aws-lambda', payload: enc({}) });
    expect(l).toMatchObject({ status: 'function-error', functionError: 'Unhandled' });
    expect(a).toMatchObject({ status: 'function-error', functionError: 'Unhandled' });
  });

  it('classifies AWS throttling as rejected, distinct from host capacity', async () => {
    const h = harness();
    hybrid(h);
    h.lambda.behavior = () => { throw new XeroError('AWS_THROTTLED', 'slow down'); };
    await expect(h.router.invoke({ functionName: 'hello', target: 'aws-lambda', payload: enc({}) })).rejects.toMatchObject({ code: 'AWS_THROTTLED' });
    const rec = h.registry.listInvocations(h.registry.getFunctionByName('hello')!.id, 1)[0]!;
    expect(rec).toMatchObject({ status: 'rejected', errorCode: 'AWS_THROTTLED', target: 'aws-lambda' });
    expect(h.metrics.counter('capacity_rejections_total')).toBe(0);
  });

  it('records unknown outcomes and never retries them on another target', async () => {
    const h = harness();
    hybrid(h, 'aws-lambda');
    h.lambda.behavior = () => { throw new XeroError('UNKNOWN_OUTCOME', 'connection reset after dispatch'); };
    await expect(h.router.invoke({ functionName: 'hello', payload: enc({}) })).rejects.toMatchObject({ code: 'UNKNOWN_OUTCOME' });
    expect(h.backend.started).toHaveLength(0); // no local replay
    expect(h.lambda.calls).toHaveLength(1); // no retry
    expect(h.registry.listInvocations(h.registry.getFunctionByName('hello')!.id, 1)[0]!.status).toBe('unknown-outcome');
  });

  it('requires an AWS connection for the aws-lambda target', async () => {
    const h = harness();
    const fn = h.registry.createFunction({ name: 'x', description: undefined, routing: routing('aws-lambda') });
    h.registry.addDeployment(fn.id, { target: 'aws-lambda', config: lambdaConfig });
    await expect(h.router.invoke({ functionName: 'x', payload: enc({}) })).rejects.toMatchObject({ code: 'AWS_NOT_CONNECTED' });
  });

  it('async (Event) invocation to aws-lambda is accepted, not completed', async () => {
    const h = harness();
    hybrid(h);
    const res = await h.router.invoke({ functionName: 'hello', target: 'aws-lambda', invocationType: 'Event', payload: enc({}) });
    expect(res.status).toBe('accepted');
    expect(h.lambda.calls[0]!.invocationType).toBe('Event');
  });

  it('async (Event) local invocation: capacity reserved, accepted immediately, real outcome recorded later', async () => {
    const h = harness();
    hybrid(h);
    let release!: () => void;
    h.backend.handler = () => new Promise((r) => { release = () => r({ outcome: 'ok', payload: enc({ done: true }) }); });
    const res = await h.router.invoke({ functionName: 'hello', target: 'local', invocationType: 'Event', payload: enc({}) });
    expect(res.status).toBe('accepted');
    expect(h.scheduler.stats().running).toBe(1);
    await new Promise((r) => setTimeout(r, 20));
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(h.scheduler.stats().running).toBe(0);
    const recs = h.registry.listInvocations(res.functionId, 5);
    expect(recs.map((r) => r.status).sort()).toEqual(['accepted', 'succeeded']);
  });

  it('validates payloads before executing anything', async () => {
    const h = harness();
    hybrid(h);
    await expect(h.router.invoke({ functionName: 'hello', payload: new TextEncoder().encode('{not json') })).rejects.toMatchObject({ code: 'PAYLOAD_INVALID' });
    await expect(h.router.invoke({ functionName: 'hello', payload: new Uint8Array(6 * 1024 * 1024 + 1) })).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(h.backend.started).toHaveLength(0);
    const empty = await h.router.invoke({ functionName: 'hello', payload: new Uint8Array() });
    expect(dec(empty.payload)).toEqual({});
  });

  it('unknown function', async () => {
    await expect(harness().router.invoke({ functionName: 'nope', payload: enc({}) })).rejects.toMatchObject({ code: 'FUNCTION_NOT_FOUND' });
  });

  it('drain waits for in-flight invocations (graceful shutdown)', async () => {
    const h = harness();
    hybrid(h);
    let release!: () => void;
    h.backend.handler = () => new Promise((r) => { release = () => r({ outcome: 'ok', payload: enc({}) }); });
    const p = h.router.invoke({ functionName: 'hello', target: 'local', payload: enc({}) });
    await new Promise((r) => setTimeout(r, 20));
    expect(h.router.pending).toBe(1);
    expect(await h.router.drain(60)).toBe(false); // still running at the deadline
    const drained = h.router.drain(2000);
    release();
    await p;
    expect(await drained).toBe(true);
    expect(h.router.pending).toBe(0);
  });
});
