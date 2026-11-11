import { XeroError, type Metrics } from '@xero/core';
import { systemClock, type Clock } from '@xero/shared';

export interface SchedulerOptions {
  /** Global bound on concurrently executing invocations on this host. */
  maxConcurrent: number;
  /** Max invocations allowed to wait for capacity. Beyond this, requests are rejected immediately. */
  queueLimit: number;
  clock?: Clock;
  metrics?: Metrics;
}

export interface Lease {
  release(): void;
}

export interface AcquireOptions {
  /** Absolute epoch ms after which waiting is abandoned. */
  deadlineAt: number;
  signal?: AbortSignal | undefined;
}

interface Waiter {
  key: string;
  limit: number;
  resolve(lease: Lease): void;
  reject(e: unknown): void;
  cleanup(): void;
}

export interface SchedulerStats {
  running: number;
  queued: number;
  perKey: Record<string, number>;
}

/**
 * Admission control: per-deployment concurrency caps + global host bound + bounded FIFO wait queue.
 * Host exhaustion is reported as CAPACITY_EXHAUSTED (distinct from AWS throttling).
 */
export class ConcurrencyScheduler {
  private running = 0;
  private readonly perKey = new Map<string, number>();
  private readonly queue: Waiter[] = [];
  private readonly clock: Clock;

  constructor(private readonly options: SchedulerOptions) {
    this.clock = options.clock ?? systemClock;
  }

  stats(): SchedulerStats {
    return { running: this.running, queued: this.queue.length, perKey: Object.fromEntries(this.perKey) };
  }

  private canRun(key: string, limit: number): boolean {
    return this.running < this.options.maxConcurrent && (this.perKey.get(key) ?? 0) < limit;
  }

  private grant(key: string): Lease {
    this.running += 1;
    this.perKey.set(key, (this.perKey.get(key) ?? 0) + 1);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.running -= 1;
        const n = (this.perKey.get(key) ?? 1) - 1;
        if (n <= 0) this.perKey.delete(key);
        else this.perKey.set(key, n);
        this.drain();
      },
    };
  }

  private reject(reason: string, details: Record<string, unknown>): XeroError {
    this.options.metrics?.inc('capacity_rejections_total', { reason });
    return new XeroError('CAPACITY_EXHAUSTED', 'no local capacity available for this invocation', { reason, ...details });
  }

  acquire(key: string, limit: number, opts: AcquireOptions): Promise<Lease> {
    if (opts.signal?.aborted) return Promise.reject(this.reject('aborted', {}));
    // Queued waiters are only ever blocked by their own per-key cap (else drain() would have granted them), so a
    // runnable request may pass them unless a same-key waiter is already queued (FIFO within a key).
    if (this.canRun(key, limit) && !this.queue.some((w) => w.key === key)) return Promise.resolve(this.grant(key));
    if (this.queue.length >= this.options.queueLimit) {
      return Promise.reject(this.reject('queue_full', { queued: this.queue.length, running: this.running }));
    }
    const wait = opts.deadlineAt - this.clock.now();
    if (wait <= 0) return Promise.reject(this.reject('wait_deadline', {}));
    return new Promise<Lease>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.remove(waiter);
        reject(this.reject('wait_deadline', { waitedMs: wait }));
      }, wait);
      const onAbort = (): void => {
        this.remove(waiter);
        reject(this.reject('aborted', {}));
      };
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      const waiter: Waiter = {
        key,
        limit,
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          opts.signal?.removeEventListener('abort', onAbort);
        },
      };
      this.queue.push(waiter);
    });
  }

  private remove(w: Waiter): void {
    const i = this.queue.indexOf(w);
    if (i >= 0) this.queue.splice(i, 1);
    w.cleanup();
  }

  /** Grant capacity to queued waiters in FIFO order, skipping ones blocked only by their own per-key cap. */
  private drain(): void {
    for (let i = 0; i < this.queue.length && this.running < this.options.maxConcurrent; ) {
      const w = this.queue[i]!;
      if ((this.perKey.get(w.key) ?? 0) < w.limit) {
        this.queue.splice(i, 1);
        w.cleanup();
        w.resolve(this.grant(w.key));
      } else i += 1;
    }
  }
}
