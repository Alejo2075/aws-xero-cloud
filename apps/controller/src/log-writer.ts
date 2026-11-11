import type { FunctionRegistry, LogLine, Logger } from '@xero/core';
import type { PooledWorker } from '@xero/scaling';
import type { Redactor } from '@xero/telemetry';
import type { Clock } from '@xero/shared';

/** Buffers function stdout/stderr, redacts known secrets and credential patterns, and persists in batches. */
export class LogWriter {
  private buffer: LogLine[] = [];
  private timer: NodeJS.Timeout | undefined;
  constructor(
    private readonly registry: FunctionRegistry,
    private readonly redactor: Redactor,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly flushMs = 250,
  ) {}

  start(): void {
    this.timer ??= setInterval(() => this.flush(), this.flushMs);
    this.timer.unref();
  }

  push(worker: PooledWorker, stream: 'stdout' | 'stderr' | 'system', message: string, at = this.clock.now()): void {
    const text = message.trimEnd();
    if (!text) return;
    this.buffer.push({ functionId: worker.functionId, deploymentId: worker.deploymentId, requestId: worker.lastRequestId, stream, at, message: this.redactor.redactString(text) });
    if (this.buffer.length >= 100) this.flush();
  }

  flush(): void {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    try {
      this.registry.appendLogs(batch);
    } catch (e) {
      // Function may have been deleted while lines were buffered; never crash the controller for logs.
      this.logger.debug('dropping log batch', { error: e });
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.flush();
  }
}
