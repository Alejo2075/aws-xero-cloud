import { afterEach, describe, expect, it } from 'vitest';
import { XeroError } from '@xero/core';
import { MetricsRegistry } from '@xero/telemetry';
import { SqsPoller, parseBatchItemFailures, queueArn, toSqsEvent, type DeliverFn, type SqsEvent } from '../src/index.js';
import { FakeSqs, enc, until } from './fake-sqs.js';

const QUEUE = 'https://sqs.us-east-1.amazonaws.com/123456789012/orders';
let poller: SqsPoller | undefined;
afterEach(async () => { await poller?.stop(500); poller = undefined; });

function setup(deliver: DeliverFn, sqs = new FakeSqs(), over: { maxInFlight?: number; batchSize?: number; visibilityExtensionSec?: number } = {}) {
  const metrics = new MetricsRegistry();
  poller = new SqsPoller({
    source: { id: 'es_1', queueUrl: QUEUE, region: 'us-east-1', batchSize: 10, maxInFlight: 1, visibilityExtensionSec: 0, ...over },
    sqs, deliver, metrics, waitSeconds: 1, sleep: (ms, signal) => new Promise<void>((r) => { const t = setTimeout(r, Math.min(ms, 20)); signal?.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); }),
  });
  return { sqs, metrics, poller };
}
const ok = { status: 'succeeded' as const, payload: new Uint8Array() };

describe('event shape', () => {
  it('produces the Lambda SQSEvent shape with the queue ARN', () => {
    const e = toSqsEvent([{ messageId: 'a', receiptHandle: 'r', body: '{"x":1}', md5OfBody: 'm', attributes: { ApproximateReceiveCount: '1' }, messageAttributes: { k: { dataType: 'String', stringValue: 'v' } } }], queueArn(QUEUE), 'us-east-1');
    expect(e.Records[0]).toMatchObject({ messageId: 'a', body: '{"x":1}', eventSource: 'aws:sqs', eventSourceARN: 'arn:aws:sqs:us-east-1:123456789012:orders', awsRegion: 'us-east-1' });
    expect(e.Records[0]!.messageAttributes.k).toMatchObject({ stringValue: 'v', dataType: 'String', stringListValues: [] });
  });
  it('rejects non-AWS queue urls', () => {
    expect(() => queueArn('https://evil.example.com/123456789012/q')).toThrowError(expect.objectContaining({ code: 'EVENT_SOURCE_INVALID' }));
  });
});

describe('parseBatchItemFailures', () => {
  const ids = new Set(['a', 'b', 'c']);
  it('no key / empty body = full success', () => {
    expect(parseBatchItemFailures(new Uint8Array(), ids)).toEqual(new Set());
    expect(parseBatchItemFailures(enc({ ok: true }), ids)).toEqual(new Set());
    expect(parseBatchItemFailures(enc(null), ids)).toEqual(new Set());
    expect(parseBatchItemFailures(enc({ batchItemFailures: [] }), ids)).toEqual(new Set());
  });
  it('lists failed ids', () => {
    expect(parseBatchItemFailures(enc({ batchItemFailures: [{ itemIdentifier: 'b' }] }), ids)).toEqual(new Set(['b']));
  });
  it('treats malformed responses as whole-batch failure', () => {
    for (const bad of [{ batchItemFailures: 'x' }, { batchItemFailures: [{ itemIdentifier: '' }] }, { batchItemFailures: [{ itemIdentifier: 'zzz' }] }, { batchItemFailures: [{}] }])
      expect(parseBatchItemFailures(enc(bad), ids)).toBe('all');
  });
});

describe('SqsPoller — at-least-once delivery', () => {
  it('deletes messages only after the handler succeeds', async () => {
    const events: SqsEvent[] = [];
    let gate!: () => void;
    const { sqs, poller } = setup(async (e) => { events.push(e); await new Promise<void>((r) => { gate = r; }); return ok; });
    sqs.send('one'); sqs.send('two');
    await poller.start();
    await until(() => events.length === 1);
    expect(sqs.deleted).toEqual([]); // processing in flight: nothing acknowledged yet
    expect(events[0]!.Records.map((r) => r.body)).toEqual(['one', 'two']);
    gate();
    await until(() => sqs.deleted.length === 2);
    expect(poller.stats()).toMatchObject({ received: 2, deleted: 2 });
  });

  it('partial batch failure: acknowledges only the successes; the failure is redelivered', async () => {
    const seen: string[][] = [];
    let attempt = 0;
    const { sqs, poller } = setup(async (e) => {
      seen.push(e.Records.map((r) => r.messageId));
      attempt += 1;
      return attempt === 1 ? { status: 'succeeded', payload: enc({ batchItemFailures: [{ itemIdentifier: e.Records[1]!.messageId }] }) } : ok;
    });
    const a = sqs.send('a'); const b = sqs.send('b'); const c = sqs.send('c');
    await poller.start();
    await until(() => sqs.deleted.length === 3);
    expect(seen[0]).toEqual([a, b, c]);
    expect(seen[1]).toEqual([b]); // only the failed message came back (duplicate delivery of b is expected)
    expect(sqs.deleted.slice(0, 2)).toEqual([a, c]);
  });

  it('function error: never deletes, message is redelivered after the visibility timeout', async () => {
    let calls = 0;
    const { sqs, poller } = setup(async () => (++calls < 3 ? { status: 'function-error', payload: enc({ errorMessage: 'x' }) } : ok));
    sqs.send('retry-me');
    await poller.start();
    await until(() => sqs.deleted.length === 1);
    expect(calls).toBe(3);
  });

  it('poison message (reported via batchItemFailures) ends in the queue DLQ and does not block the good one', async () => {
    const sqs = new FakeSqs();
    sqs.maxReceiveCount = 2;
    const { poller } = setup(async (e) => {
      const poison = e.Records.filter((r) => r.body === 'poison').map((r) => ({ itemIdentifier: r.messageId }));
      return { status: 'succeeded', payload: enc({ batchItemFailures: poison }) };
    }, sqs);
    sqs.send('poison');
    sqs.send('good');
    await poller.start();
    await until(() => sqs.dlq.length === 1 && sqs.deleted.length === 1, 5000);
    expect(sqs.dlq[0]!.body).toBe('poison');
    expect(sqs.deleted).not.toContain(sqs.dlq[0]!.messageId);
  });

  it('without a partial-batch response a poison message fails its whole batch (documented Lambda-compatible behaviour)', async () => {
    const sqs = new FakeSqs();
    sqs.maxReceiveCount = 2;
    const { poller } = setup(async (e) => (e.Records.some((r) => r.body === 'poison') ? { status: 'function-error', payload: enc({ errorMessage: 'bad' }) } : ok), sqs);
    sqs.send('poison');
    sqs.send('good');
    await poller.start();
    await until(() => sqs.dlq.length === 2, 5000);
    expect(sqs.deleted).toEqual([]);
  });

  it('malformed batchItemFailures leaves the whole batch undeleted', async () => {
    let calls = 0;
    const { sqs, poller } = setup(async () => (++calls === 1 ? { status: 'succeeded', payload: enc({ batchItemFailures: [{ itemIdentifier: 'nope' }] }) } : ok));
    sqs.send('a'); sqs.send('b');
    await poller.start();
    await until(() => sqs.deleted.length === 2);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('capacity rejection releases the batch early instead of waiting for the full visibility timeout', async () => {
    let calls = 0;
    const { sqs, poller, metrics } = setup(async () => { if (++calls === 1) throw new XeroError('CAPACITY_EXHAUSTED', 'busy'); return ok; });
    sqs.info.visibilityTimeoutSec = 30;
    sqs.send('a');
    await poller.start();
    await until(() => sqs.visibilityCalls.length === 1);
    expect(sqs.visibilityCalls[0]!.timeoutSec).toBe(10);
    expect(sqs.deleted).toEqual([]);
    expect(metrics.counter('sqs_messages_failed_total', { reason: 'CAPACITY_EXHAUSTED' })).toBe(1);
  });

  it('timeouts / unknown outcomes are NOT released early (they may have executed)', async () => {
    const { sqs, poller } = setup(async () => { throw new XeroError('INVOCATION_TIMEOUT', 'slow'); });
    sqs.info.visibilityTimeoutSec = 30;
    sqs.send('a');
    await poller.start();
    await until(() => poller.stats().failed === 1);
    expect(sqs.visibilityCalls).toEqual([]);
    expect(sqs.deleted).toEqual([]);
  });

  it('extends visibility while a long invocation is running', async () => {
    let gate!: () => void;
    const { sqs, poller } = setup(() => new Promise((r) => { gate = () => r(ok); }), new FakeSqs(), { visibilityExtensionSec: 1 });
    sqs.info.visibilityTimeoutSec = 1;
    sqs.send('slow');
    await poller.start();
    await until(() => sqs.visibilityCalls.length >= 1);
    expect(sqs.visibilityCalls[0]!.timeoutSec).toBe(1);
    gate();
    await until(() => sqs.deleted.length === 1);
  });

  it('applies backpressure: never more batches in flight than maxInFlight', async () => {
    let concurrent = 0, peak = 0;
    const { sqs, poller } = setup(async () => { concurrent += 1; peak = Math.max(peak, concurrent); await new Promise((r) => setTimeout(r, 30)); concurrent -= 1; return ok; }, new FakeSqs(), { batchSize: 1, maxInFlight: 2 });
    for (let i = 0; i < 6; i++) sqs.send(`m${i}`);
    await poller.start();
    await until(() => sqs.deleted.length === 6);
    expect(peak).toBe(2);
  });

  it('survives receive failures with backoff and recovers (outage does not crash the poller)', async () => {
    const sqs = new FakeSqs();
    sqs.receiveError = new XeroError('AWS_REQUEST_FAILED', 'network down');
    const { poller } = setup(async () => ok, sqs);
    sqs.send('a');
    await poller.start();
    await until(() => poller.stats().consecutiveReceiveErrors >= 2);
    expect(poller.stats().lastError).toBe('AWS_REQUEST_FAILED');
    sqs.receiveError = undefined;
    await until(() => sqs.deleted.length === 1);
    expect(poller.stats().consecutiveReceiveErrors).toBe(0);
  });

  it('delete failures are tolerated (message will be redelivered => duplicate)', async () => {
    const sqs = new FakeSqs();
    const id = sqs.send('a');
    sqs.failDeleteIds.add(id);
    let calls = 0;
    const { poller } = setup(async () => { calls += 1; if (calls === 2) sqs.failDeleteIds.clear(); return ok; }, sqs);
    await poller.start();
    await until(() => sqs.deleted.length === 1);
    expect(calls).toBe(2); // duplicate delivery caused by the failed delete
  });

  it('FIFO: a failure stops acknowledgement of later messages in the batch', async () => {
    const sqs = new FakeSqs();
    sqs.info = { visibilityTimeoutSec: 0.1, hasDeadLetterQueue: true, fifo: true };
    let first = true;
    const { poller } = setup(async (e) => { if (first) { first = false; return { status: 'succeeded', payload: enc({ batchItemFailures: [{ itemIdentifier: e.Records[1]!.messageId }] }) }; } return ok; }, sqs);
    const a = sqs.send('a'); sqs.send('b'); sqs.send('c');
    await poller.start();
    await until(() => sqs.deleted.length === 3);
    expect(sqs.deleted[0]).toBe(a); // only 'a' was acknowledged in the first pass; b and c came back in order
  });

  it('start() warns when the queue has no DLQ and reports queue attributes', async () => {
    const sqs = new FakeSqs();
    sqs.info = { visibilityTimeoutSec: 30, hasDeadLetterQueue: false, fifo: false };
    const { poller } = setup(async () => ok, sqs);
    const r = await poller.start();
    expect(r.queue.visibilityTimeoutSec).toBe(30);
    expect(r.warnings.join(' ')).toMatch(/dead-letter/);
  });

  it('counts billable AWS requests', async () => {
    const { sqs, poller, metrics } = setup(async () => ok);
    sqs.send('a');
    await poller.start();
    await until(() => sqs.deleted.length === 1);
    expect(metrics.counter('aws_requests_total', { operation: 'sqs:ReceiveMessage' })).toBeGreaterThanOrEqual(1);
    expect(metrics.counter('aws_requests_total', { operation: 'sqs:DeleteMessageBatch' })).toBe(1);
  });
});
