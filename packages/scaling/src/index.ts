import { XeroError, type Logger, type Metrics } from '@xero/core';
import type { ExecutionBackend, LogStreamName, WorkerHandle, WorkerSpec } from '@xero/execution';
import { systemClock, newId, type Clock, type IdGenerator } from '@xero/shared';

export interface PooledWorker {
  handle: WorkerHandle;
  deploymentId: string;
  functionId: string;
  idleTtlMs: number;
  minWarm: number;
  /** Epoch ms when injected credentials expire; undefined when none were injected. */
  credentialsExpireAt: number | undefined;
  invocations: number;
  lastUsedAt: number;
  busy: boolean;
  retired: boolean;
  /** Request that most recently used the worker; used to attribute log lines. */
  lastRequestId: string | undefined;
  stopLogs: () => void;
}

export interface WorkerRequest {
  deploymentId: string;
  functionId: string;
  idleTtlMs: number;
  /** Keep at least this many workers of the deployment alive (never reaped by the idle TTL). */
  minWarm?: number | undefined;
  /** Builds the spec (may issue credentials). Called only on a cold start. */
  build(workerId: string): Promise<{ spec: WorkerSpec; credentialsExpireAt?: number | undefined }>;
}

export interface PoolOptions {
  backend: ExecutionBackend;
  /** Global bound on workers (busy + idle) on this host. */
  maxWorkers: number;
  clock?: Clock;
  ids?: IdGenerator;
  metrics?: Metrics;
  logger?: Logger;
  /** Recycle a worker when credentials expire within this margin. */
  credentialRefreshMarginMs?: number;
  reapIntervalMs?: number;
  onLog?: (worker: PooledWorker, stream: LogStreamName | 'system', line: string, at: number) => void;
}

/**
 * Warm worker pool. Each worker serves exactly one invocation at a time. Idle workers are stopped after their
 * deployment's idle TTL (scale-to-zero). Admission/concurrency is the scheduler's job; the pool only needs the
 * caller to hold a lease.
 */
export class WorkerPool {
  private readonly workers = new Set<PooledWorker>();
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly margin: number;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly options: PoolOptions) {
    this.clock = options.clock ?? systemClock;
    this.ids = options.ids ?? newId;
    this.margin = options.credentialRefreshMarginMs ?? 5 * 60_000;
  }

  backendFor(): ExecutionBackend {
    return this.options.backend;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.reapIdle(), this.options.reapIntervalMs ?? 1000);
    this.timer.unref();
  }

  stats(): { total: number; busy: number; idle: number } {
    let busy = 0;
    for (const w of this.workers) if (w.busy) busy += 1;
    return { total: this.workers.size, busy, idle: this.workers.size - busy };
  }

  list(): readonly PooledWorker[] {
    return [...this.workers];
  }

  private publish(): void {
    const s = this.stats();
    this.options.metrics?.gauge('workers_running', s.total);
    this.options.metrics?.gauge('workers_busy', s.busy);
  }

  /** Returns a warm worker when possible, otherwise cold-starts one (evicting an idle LRU worker if at the host bound). */
  async checkout(req: WorkerRequest): Promise<{ worker: PooledWorker; cold: boolean }> {
    const now = this.clock.now();
    for (const w of [...this.workers]) {
      if (w.busy || w.deploymentId !== req.deploymentId) continue;
      if (w.retired || (w.credentialsExpireAt !== undefined && w.credentialsExpireAt - now < this.margin)) {
        await this.stop(w, w.retired ? 'retired' : 'credentials_expiring');
        continue;
      }
      w.busy = true;
      this.options.metrics?.inc('warm_hits_total');
      this.publish();
      return { worker: w, cold: false };
    }
    await this.makeRoom();
    const workerId = this.ids('wrk');
    const { spec, credentialsExpireAt } = await req.build(workerId);
    const handle = await this.options.backend.startWorker(spec);
    const worker: PooledWorker = {
      handle,
      deploymentId: req.deploymentId,
      functionId: req.functionId,
      idleTtlMs: req.idleTtlMs,
      minWarm: req.minWarm ?? 0,
      credentialsExpireAt,
      invocations: 0,
      lastUsedAt: this.clock.now(),
      busy: true,
      retired: false,
      lastRequestId: undefined,
      stopLogs: () => undefined,
    };
    if (this.options.onLog) {
      const onLog = this.options.onLog;
      worker.stopLogs = this.options.backend.streamLogs(handle, (stream, line, at) => onLog(worker, stream, line, at));
    }
    this.workers.add(worker);
    this.options.metrics?.inc('cold_starts_total');
    this.publish();
    this.options.logger?.info('worker started', { workerId: handle.workerId, deploymentId: req.deploymentId });
    return { worker, cold: true };
  }

  private async makeRoom(): Promise<void> {
    while (this.workers.size >= this.options.maxWorkers) {
      const idle = [...this.workers].filter((w) => !w.busy).sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      if (!idle) throw new XeroError('CAPACITY_EXHAUSTED', 'all workers are busy', { reason: 'host_workers' });
      await this.stop(idle, 'evicted');
    }
  }

  /** Return a worker after use. Unhealthy or expired workers are stopped; TTL 0 stops immediately. */
  async checkin(worker: PooledWorker, outcome: { healthy: boolean; requestId?: string | undefined }): Promise<void> {
    worker.invocations += 1;
    worker.lastUsedAt = this.clock.now();
    worker.lastRequestId = outcome.requestId ?? worker.lastRequestId;
    worker.busy = false;
    if (!outcome.healthy || worker.retired || (worker.idleTtlMs === 0 && worker.minWarm === 0)) {
      await this.stop(worker, outcome.healthy ? (worker.retired ? 'retired' : 'ttl0') : 'unhealthy');
    }
    this.publish();
  }

  /** Stop idle workers past their TTL. Returns how many were stopped. */
  async reapIdle(): Promise<number> {
    const now = this.clock.now();
    let n = 0;
    for (const w of [...this.workers]) {
      if (!w.busy && now - w.lastUsedAt >= w.idleTtlMs) {
        const siblings = [...this.workers].filter((x) => x.deploymentId === w.deploymentId).length;
        if (!w.retired && siblings <= w.minWarm) continue; // keep the configured warm floor
        await this.stop(w, 'idle_ttl');
        n += 1;
      }
    }
    if (n > 0) this.publish();
    return n;
  }

  /** Called when a deployment is superseded/removed: idle workers stop now, busy ones when returned. */
  async retireDeployment(deploymentId: string): Promise<void> {
    for (const w of [...this.workers]) {
      if (w.deploymentId !== deploymentId) continue;
      w.retired = true;
      if (!w.busy) await this.stop(w, 'retired');
    }
    this.publish();
  }

  async stopAll(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await Promise.all([...this.workers].map((w) => this.stop(w, 'shutdown')));
    this.publish();
  }

  private async stop(w: PooledWorker, reason: string): Promise<void> {
    if (!this.workers.delete(w)) return;
    w.stopLogs();
    try {
      await this.options.backend.stopWorker(w.handle);
    } catch (e) {
      this.options.logger?.warn('failed to stop worker', { workerId: w.handle.workerId, error: e });
    }
    this.options.logger?.info('worker stopped', { workerId: w.handle.workerId, reason });
  }
}
