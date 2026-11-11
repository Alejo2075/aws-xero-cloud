import type { XeroError } from '@xero/core';
import type { BatchEntry, QueueInfo, SqsMessage, SqsPort } from '../src/index.js';

interface Stored {
  msg: SqsMessage;
  visibleAt: number;
  receives: number;
  handle: string;
}

/** In-memory model of the SQS semantics we rely on: visibility timeout, redelivery, receive counts, redrive to DLQ. */
export class FakeSqs implements SqsPort {
  readonly queue: Stored[] = [];
  readonly dlq: SqsMessage[] = [];
  readonly deleted: string[] = [];
  readonly visibilityCalls: Array<{ ids: string[]; timeoutSec: number }> = [];
  receiveCalls = 0;
  receiveError: XeroError | undefined;
  failDeleteIds = new Set<string>();
  maxReceiveCount = Infinity;
  info: QueueInfo = { visibilityTimeoutSec: 0.1, hasDeadLetterQueue: true, fifo: false };
  private seq = 0;

  send(body: string, messageId = `m${++this.seq}`): string {
    this.queue.push({ msg: { messageId, receiptHandle: '', body, md5OfBody: 'md5', attributes: { SentTimestamp: '1' }, messageAttributes: {} }, visibleAt: 0, receives: 0, handle: '' });
    return messageId;
  }

  async getQueueInfo(): Promise<QueueInfo> {
    return this.info;
  }

  async receive(o: { maxMessages: number; waitSeconds: number; signal: AbortSignal }): Promise<SqsMessage[]> {
    this.receiveCalls += 1;
    if (this.receiveError) throw this.receiveError;
    const deadline = Date.now() + Math.min(o.waitSeconds * 1000, 60);
    for (;;) {
      if (o.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      const now = Date.now();
      const visible = this.queue.filter((s) => s.visibleAt <= now).slice(0, o.maxMessages);
      for (const s of [...visible]) {
        if (s.receives >= this.maxReceiveCount) {
          this.dlq.push(s.msg);
          this.queue.splice(this.queue.indexOf(s), 1);
          visible.splice(visible.indexOf(s), 1);
        }
      }
      if (visible.length > 0) {
        return visible.map((s) => {
          s.receives += 1;
          s.visibleAt = now + this.info.visibilityTimeoutSec * 1000;
          s.handle = `rh-${s.msg.messageId}-${s.receives}`;
          return { ...s.msg, receiptHandle: s.handle, attributes: { ...s.msg.attributes, ApproximateReceiveCount: String(s.receives) } };
        });
      }
      if (Date.now() >= deadline) return [];
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  private find(handle: string): Stored | undefined {
    return this.queue.find((s) => s.handle === handle);
  }

  async deleteBatch(entries: readonly BatchEntry[]): Promise<{ failed: string[] }> {
    const failed: string[] = [];
    for (const e of entries) {
      const s = this.find(e.receiptHandle);
      if (!s || this.failDeleteIds.has(s.msg.messageId)) {
        failed.push(e.id);
        continue;
      }
      this.queue.splice(this.queue.indexOf(s), 1);
      this.deleted.push(s.msg.messageId);
    }
    return { failed };
  }

  async changeVisibility(entries: readonly BatchEntry[], timeoutSec: number): Promise<{ failed: string[] }> {
    this.visibilityCalls.push({ ids: entries.map((e) => this.find(e.receiptHandle)?.msg.messageId ?? '?'), timeoutSec });
    for (const e of entries) {
      const s = this.find(e.receiptHandle);
      if (s) s.visibleAt = Date.now() + timeoutSec * 1000;
    }
    return { failed: [] };
  }
}

export const enc = (v: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(v));
export async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}
