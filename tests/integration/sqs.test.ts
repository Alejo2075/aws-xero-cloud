import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeSqs, until } from '../../packages/event-source-sqs/test/fake-sqs.js';
import type { SqsPort } from '@xero/event-source-sqs';
import { createEnv, type Env } from './harness.js';

const QUEUE = 'https://sqs.us-east-1.amazonaws.com/123456789012/orders';
let env: Env;
let sqs: FakeSqs;
beforeEach(async () => {
  sqs = new FakeSqs();
  env = await createEnv({ sqs: new Map<string, SqsPort>([[QUEUE, sqs]]) });
  await env.client.connectAws({ region: 'us-east-1' });
  await env.client.deployLocal('worker', { runtime: 'nodejs22.x', handler: 'index.handler', sourcePath: env.source({ 'index.js': 'x' }) });
});
afterEach(async () => { await env.close(); });

describe('SQS -> local function (opt-in, outbound-only)', () => {
  it('requires an AWS connection, an existing queue and an active target deployment', async () => {
    await expect(env.client.attachEventSource({ functionName: 'nope', source: 'sqs', queueUrl: QUEUE })).rejects.toMatchObject({ code: 'FUNCTION_NOT_FOUND' });
    await expect(env.client.attachEventSource({ functionName: 'worker', source: 'sqs', queueUrl: 'https://evil.example.com/123456789012/q' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(env.client.attachEventSource({ functionName: 'worker', source: 'sqs', queueUrl: QUEUE, target: 'aws-lambda' })).rejects.toMatchObject({ code: 'TARGET_NOT_DEPLOYED' });
    await env.client.disconnectAws();
    await expect(env.client.attachEventSource({ functionName: 'worker', source: 'sqs', queueUrl: QUEUE })).rejects.toMatchObject({ code: 'AWS_NOT_CONNECTED' });
  });

  it('delivers SQS events to the local handler and deletes messages only after success', async () => {
    const seen: unknown[] = [];
    env.backend.handler = (_s, r) => { seen.push(JSON.parse(new TextDecoder().decode(r.payload))); return { outcome: 'ok', payload: new TextEncoder().encode('null') }; };
    sqs.info = { visibilityTimeoutSec: 0.1, hasDeadLetterQueue: false, fifo: false };
    const a = await env.client.attachEventSource({ functionName: 'worker', source: 'sqs', queueUrl: QUEUE, batchSize: 5 });
    expect(a.warnings.join(' ')).toMatch(/dead-letter/);
    expect(a.eventSource).toMatchObject({ target: 'local', region: 'us-east-1', batchSize: 5 });
    sqs.send('{"orderId":1}');
    await until(() => sqs.deleted.length === 1);
    expect((seen[0] as { Records: Array<{ body: string; eventSource: string }> }).Records[0]).toMatchObject({ body: '{"orderId":1}', eventSource: 'aws:sqs' });

    const events = await env.client.listEventSources();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ functionName: 'worker', running: true });
    const inv = await env.client.invocations('worker');
    expect(inv[0]).toMatchObject({ source: 'sqs', status: 'succeeded', target: 'local' });
  });

  it('failed handler leaves the message for redelivery (at-least-once)', async () => {
    let calls = 0;
    env.backend.handler = () => ({ outcome: ++calls < 3 ? 'function-error' : 'ok', payload: new TextEncoder().encode(calls < 3 ? '{"errorMessage":"x"}' : 'null') });
    await env.client.attachEventSource({ functionName: 'worker', source: 'sqs', queueUrl: QUEUE });
    sqs.send('retry');
    await until(() => sqs.deleted.length === 1, 5000);
    expect(calls).toBe(3);
  });

  it('keeps polling local-only traffic unaffected, and detach stops the poller', async () => {
    const a = await env.client.attachEventSource({ functionName: 'worker', source: 'sqs', queueUrl: QUEUE });
    await env.client.detachEventSource(a.eventSource.id);
    expect(await env.client.listEventSources()).toEqual([]);
    const before = sqs.receiveCalls;
    await new Promise((r) => setTimeout(r, 150));
    expect(sqs.receiveCalls - before).toBeLessThanOrEqual(1);
    await expect(env.client.detachEventSource(a.eventSource.id)).rejects.toMatchObject({ code: 'EVENT_SOURCE_NOT_FOUND' });
  });

  it('does not persist a source whose queue cannot be reached', async () => {
    sqs.getQueueInfo = async () => { throw new (await import('@xero/core')).XeroError('AWS_ACCESS_DENIED', 'no'); };
    await expect(env.client.attachEventSource({ functionName: 'worker', source: 'sqs', queueUrl: QUEUE })).rejects.toMatchObject({ code: 'AWS_ACCESS_DENIED' });
    expect(await env.client.listEventSources()).toEqual([]);
  });

  it('resumes attached sources after a controller restart', async () => {
    await env.client.attachEventSource({ functionName: 'worker', source: 'sqs', queueUrl: QUEUE });
    await env.restart();
    sqs.send('after-restart');
    await until(() => sqs.deleted.length === 1, 5000);
  });
});
