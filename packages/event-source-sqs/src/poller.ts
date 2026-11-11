import { XeroError, isXeroError, type EventSource, type Logger, type Metrics } from '@xero/core';
import { parseQueueUrl } from '@xero/specification';
import { sleep as defaultSleep } from '@xero/shared';
import type { DeliverFn, QueueInfo, SqsEvent, SqsMessage, SqsPort } from './types.js';

export interface PollerOptions {
  source: Pick<EventSource, 'id' | 'queueUrl' | 'region' | 'batchSize' | 'maxInFlight' | 'visibilityExtensionSec'>;
  sqs: SqsPort;
  deliver: DeliverFn;
  logger?: Logger | undefined;
  metrics?: Metrics | undefined;
  waitSeconds?: number;
  /** Seconds before a never-executed (rejected) batch becomes visible again. */
  releaseDelaySec?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  maxBackoffMs?: number;
}

/** Errors meaning the handler never ran, so the batch can be released sooner than the visibility timeout. */
const NOT_EXECUTED = new Set(['CAPACITY_EXHAUSTED', 'TARGET_NOT_DEPLOYED', 'AWS_NOT_CONNECTED', 'FUNCTION_NOT_FOUND', 'AWS_THROTTLED', 'AWS_ACCESS_DENIED', 'PAYLOAD_TOO_LARGE', 'PAYLOAD_INVALID']);

export function queueArn(queueUrl: string): string {
  const p = parseQueueUrl(queueUrl);
  if (!p) throw new XeroError('EVENT_SOURCE_INVALID', 'invalid SQS queue URL');
  return `arn:aws:sqs:${p.region}:${p.accountId}:${p.queueName}`;
}

export function toSqsEvent(messages: readonly SqsMessage[], arn: string, region: string): SqsEvent {
  return {
    Records: messages.map((m) => ({
      messageId: m.messageId,
      receiptHandle: m.receiptHandle,
      body: m.body,
      attributes: m.attributes,
      messageAttributes: Object.fromEntries(
        Object.entries(m.messageAttributes).map(([k, v]) => [k, { stringValue: v.stringValue, binaryValue: v.binaryValue, stringListValues: [], binaryListValues: [], dataType: v.dataType }]),
      ),
      md5OfBody: m.md5OfBody,
      eventSource: 'aws:sqs' as const,
      eventSourceARN: arn,
      awsRegion: region,
    })),
  };
}

/**
 * Interprets a Lambda "partial batch response". Returns the set of failed message ids, or 'all' when the response is
 * malformed (conservative: never delete a message the handler did not clearly acknowledge).
 */
export function parseBatchItemFailures(payload: Uint8Array, batchIds: ReadonlySet<string>): Set<string> | 'all' {
  if (payload.byteLength === 0) return new Set();
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return new Set(); // non-JSON result without batchItemFailures == full success (Lambda semantics)
  }
  if (doc === null || typeof doc !== 'object' || !('batchItemFailures' in doc)) return new Set();
  const list = (doc as { batchItemFailures: unknown }).batchItemFailures;
  if (list === null || list === undefined) return new Set();
  if (!Array.isArray(list)) return 'all';
  const failed = new Set<string>();
  for (const item of list) {
    const id = (item as { itemIdentifier?: unknown } | null)?.itemIdentifier;
    if (typeof id !== 'string' || id === '' || !batchIds.has(id)) return 'all';
    failed.add(id);
  }
  return failed;
}

export interface PollerStats {
  running: boolean;
  inFlight: number;
  received: number;
  deleted: number;
  failed: number;
  consecutiveReceiveErrors: number;
  lastError: string | undefined;
}

/**
 * Outbound-only SQS consumer (long polling). Delivery is at-least-once: a message is deleted only after the handler
 * acknowledges it; everything else is left to reappear after the visibility timeout and, eventually, the queue's DLQ.
 */
export class SqsPoller {
  private readonly abort = new AbortController();
  private readonly inFlight = new Set<Promise<void>>();
  private loop: Promise<void> | undefined;
  private info: QueueInfo | undefined;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly arn: string;
  private readonly s: PollerStats = { running: false, inFlight: 0, received: 0, deleted: 0, failed: 0, consecutiveReceiveErrors: 0, lastError: undefined };

  constructor(private readonly o: PollerOptions) {
    this.sleep = o.sleep ?? defaultSleep;
    this.arn = queueArn(o.source.queueUrl);
  }

  stats(): PollerStats {
    return { ...this.s, inFlight: this.inFlight.size };
  }

  /** Reads queue attributes (read-only) and begins polling in the background. */
  async start(): Promise<{ queue: QueueInfo; warnings: string[] }> {
    this.info = await this.api('sqs:GetQueueAttributes', () => this.o.sqs.getQueueInfo());
    const warnings: string[] = [];
    if (!this.info.hasDeadLetterQueue) warnings.push('the queue has no dead-letter queue: poison messages will be redelivered indefinitely until they expire');
    if (this.info.fifo && this.o.source.maxInFlight > 1) warnings.push('FIFO queue: processing is serialised to one batch at a time to preserve ordering');
    this.s.running = true;
    this.loop = this.run();
    return { queue: this.info, warnings };
  }

  async stop(drainTimeoutMs = 10_000): Promise<void> {
    this.abort.abort();
    await this.loop?.catch(() => undefined);
    await Promise.race([Promise.allSettled([...this.inFlight]), this.sleep(drainTimeoutMs)]);
    this.s.running = false;
  }

  private api<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    this.o.metrics?.inc('aws_requests_total', { operation });
    return fn();
  }

  private maxInFlight(): number {
    return this.info?.fifo ? 1 : this.o.source.maxInFlight;
  }

  private async run(): Promise<void> {
    const { signal } = this.abort;
    let backoff = 1000;
    const maxBackoff = this.o.maxBackoffMs ?? 60_000;
    while (!signal.aborted) {
      if (this.inFlight.size >= this.maxInFlight()) {
        await Promise.race(this.inFlight); // backpressure: do not receive while at capacity
        continue;
      }
      let messages: SqsMessage[];
      try {
        messages = await this.api('sqs:ReceiveMessage', () => this.o.sqs.receive({ maxMessages: this.o.source.batchSize, waitSeconds: this.o.waitSeconds ?? 20, signal }));
        this.s.consecutiveReceiveErrors = 0;
        this.s.lastError = undefined;
        backoff = 1000;
      } catch (e) {
        if (signal.aborted) break;
        this.s.consecutiveReceiveErrors += 1;
        this.s.lastError = isXeroError(e) ? e.code : 'ERROR';
        this.o.logger?.warn('sqs receive failed; backing off', { sourceId: this.o.source.id, code: this.s.lastError, backoffMs: backoff });
        await this.sleep(backoff, signal);
        backoff = Math.min(maxBackoff, backoff * 2);
        continue;
      }
      if (messages.length === 0) continue;
      this.s.received += messages.length;
      this.o.metrics?.inc('sqs_messages_received_total', {}, messages.length);
      const task: Promise<void> = this.process(messages).finally(() => this.inFlight.delete(task));
      this.inFlight.add(task);
    }
  }

  private async process(messages: SqsMessage[]): Promise<void> {
    const entries = messages.map((m, i) => ({ id: String(i), receiptHandle: m.receiptHandle, messageId: m.messageId }));
    const log = this.o.logger?.child({ sourceId: this.o.source.id, batchSize: messages.length });
    for (const m of messages) {
      if (Number(m.attributes.ApproximateReceiveCount ?? 1) >= 5 && !this.info?.hasDeadLetterQueue) {
        this.o.metrics?.inc('sqs_poison_suspects_total');
        log?.warn('message received repeatedly and the queue has no DLQ', { messageId: m.messageId });
      }
    }
    const extender = this.startExtender(entries);
    try {
      let outcome;
      try {
        outcome = await this.o.deliver(toSqsEvent(messages, this.arn, this.o.source.region));
      } catch (e) {
        const code = isXeroError(e) ? e.code : 'INTERNAL';
        this.s.failed += messages.length;
        this.o.metrics?.inc('sqs_messages_failed_total', { reason: code }, messages.length);
        this.o.metrics?.inc('sqs_batches_total', { outcome: 'error' });
        if (NOT_EXECUTED.has(code)) {
          // Not executed: safe to release early (with a delay so we do not hot-loop on a saturated host).
          await this.releaseEarly(entries, log);
          await this.sleep(1000, this.abort.signal);
        }
        log?.warn('batch delivery failed; messages left for redelivery', { code });
        return;
      }
      if (outcome.status === 'function-error') {
        this.s.failed += messages.length;
        this.o.metrics?.inc('sqs_messages_failed_total', { reason: 'function_error' }, messages.length);
        this.o.metrics?.inc('sqs_batches_total', { outcome: 'function_error' });
        log?.warn('handler reported an error; messages left for redelivery');
        return;
      }
      const ids = new Set(messages.map((m) => m.messageId));
      const parsed = parseBatchItemFailures(outcome.payload, ids);
      if (parsed === 'all') log?.warn('handler returned a malformed batchItemFailures document; treating the whole batch as failed');
      let failedIds: Set<string> = parsed === 'all' ? ids : parsed;
      if (this.info?.fifo && failedIds.size > 0) {
        // FIFO: once a message fails, later messages of the batch must not be acknowledged out of order.
        const first = messages.findIndex((m) => failedIds.has(m.messageId));
        failedIds = new Set(messages.slice(first).map((m) => m.messageId));
      }
      const ok = entries.filter((e) => !failedIds.has(e.messageId));
      this.s.failed += failedIds.size;
      if (failedIds.size > 0) this.o.metrics?.inc('sqs_messages_failed_total', { reason: 'batch_item_failure' }, failedIds.size);
      if (ok.length > 0) {
        try {
          const res = await this.api('sqs:DeleteMessageBatch', () => this.o.sqs.deleteBatch(ok.map((e) => ({ id: e.id, receiptHandle: e.receiptHandle }))));
          const deleted = ok.length - res.failed.length;
          this.s.deleted += deleted;
          this.o.metrics?.inc('sqs_messages_deleted_total', {}, deleted);
          if (res.failed.length > 0) log?.warn('some messages could not be deleted and will be redelivered (duplicates possible)', { count: res.failed.length });
        } catch (e) {
          log?.warn('delete failed; messages will be redelivered (duplicates possible)', { code: isXeroError(e) ? e.code : 'ERROR' });
        }
      }
      this.o.metrics?.inc('sqs_batches_total', { outcome: failedIds.size > 0 ? 'partial' : 'ok' });
    } finally {
      clearInterval(extender);
    }
  }

  private async releaseEarly(entries: Array<{ id: string; receiptHandle: string }>, log: Logger | undefined): Promise<void> {
    try {
      await this.api('sqs:ChangeMessageVisibilityBatch', () => this.o.sqs.changeVisibility(entries.map((e) => ({ id: e.id, receiptHandle: e.receiptHandle })), this.o.releaseDelaySec ?? 10));
    } catch (e) {
      log?.warn('could not release messages early', { code: isXeroError(e) ? e.code : 'ERROR' });
    }
  }

  private startExtender(entries: Array<{ id: string; receiptHandle: string }>): NodeJS.Timeout | undefined {
    const ext = this.o.source.visibilityExtensionSec;
    if (ext <= 0) return undefined;
    const vt = this.info?.visibilityTimeoutSec ?? ext;
    const everyMs = Math.max(250, (Math.min(vt, ext) * 1000) / 2);
    const t = setInterval(() => {
      this.api('sqs:ChangeMessageVisibilityBatch', () => this.o.sqs.changeVisibility(entries.map((e) => ({ id: e.id, receiptHandle: e.receiptHandle })), ext)).catch((e: unknown) => {
        this.o.logger?.warn('visibility extension failed', { code: isXeroError(e) ? e.code : 'ERROR' });
      });
    }, everyMs);
    t.unref();
    return t;
  }
}
