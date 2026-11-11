import { XeroError, type EventSource, type FunctionRegistry, type Logger, type Metrics } from '@xero/core';
import { SqsPoller, type DeliverFn, type SqsPort } from '@xero/event-source-sqs';
import type { InvocationRouter } from '@xero/invocation';

export type SqsPortFactory = (source: EventSource) => SqsPort;

interface Running {
  poller: SqsPoller;
  warnings: string[];
}

/** Owns the lifecycle of one SQS poller per attached event source. Pollers only run while AWS is connected. */
export class EventSourceManager {
  private readonly running = new Map<string, Running>();
  private retryTimer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    private readonly o: {
      registry: FunctionRegistry;
      router: InvocationRouter;
      portFactory: SqsPortFactory;
      logger: Logger;
      metrics: Metrics;
      retryMs?: number;
    },
  ) {}

  private deliverFor(source: EventSource): DeliverFn {
    const fn = this.o.registry.getFunctionById(source.functionId);
    return async (event) => {
      const name = this.o.registry.getFunctionById(source.functionId)?.name ?? fn?.name;
      if (!name) throw new XeroError('FUNCTION_NOT_FOUND', 'function for this event source no longer exists');
      const res = await this.o.router.invoke({
        functionName: name,
        payload: new TextEncoder().encode(JSON.stringify(event)),
        target: source.target,
        invocationType: 'RequestResponse',
        source: 'sqs',
      });
      return { status: res.status, payload: res.payload };
    };
  }

  /** Starts a poller and returns queue facts. Throws (and leaves nothing running) if the queue is unreachable. */
  async startSource(source: EventSource): Promise<{ warnings: string[]; visibilityTimeoutSec: number; hasDeadLetterQueue: boolean; fifo: boolean }> {
    await this.stopSource(source.id);
    const poller = new SqsPoller({ source, sqs: this.o.portFactory(source), deliver: this.deliverFor(source), logger: this.o.logger.child({ component: 'sqs', sourceId: source.id }), metrics: this.o.metrics });
    const started = await poller.start();
    this.running.set(source.id, { poller, warnings: started.warnings });
    return { warnings: started.warnings, ...started.queue };
  }

  async stopSource(id: string): Promise<void> {
    const r = this.running.get(id);
    if (!r) return;
    this.running.delete(id);
    await r.poller.stop();
  }

  /** (Re)starts every persisted source. Failures are logged and retried; they never prevent local execution. */
  async startAll(): Promise<void> {
    this.stopped = false;
    let pending = 0;
    for (const source of this.o.registry.listEventSources()) {
      if (this.running.has(source.id)) continue;
      try {
        await this.startSource(source);
      } catch (e) {
        pending += 1;
        this.o.logger.warn('event source could not start; will retry', { sourceId: source.id, code: e instanceof XeroError ? e.code : 'ERROR' });
      }
    }
    if (pending > 0 && !this.stopped) {
      this.retryTimer = setTimeout(() => void this.startAll(), this.o.retryMs ?? 30_000);
      this.retryTimer.unref();
    }
  }

  async stopAll(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    await Promise.all([...this.running.keys()].map((id) => this.stopSource(id)));
  }

  status(id: string): { running: boolean; warnings: string[]; stats: ReturnType<SqsPoller['stats']> | undefined } {
    const r = this.running.get(id);
    return { running: Boolean(r), warnings: r?.warnings ?? [], stats: r?.poller.stats() };
  }
}
