import { XeroError } from '@xero/core';
import type {
  ExecutionBackend,
  LogSink,
  ManagedWorkerInfo,
  WorkerHandle,
  WorkerInvokeRequest,
  WorkerInvokeResult,
  WorkerSpec,
} from './index.js';

export type FakeHandler = (spec: WorkerSpec, request: WorkerInvokeRequest, invocationNumber: number) => Promise<WorkerInvokeResult> | WorkerInvokeResult;

/**
 * Test double for ExecutionBackend. It never runs artifact code: behaviour is supplied by the test through `handler`.
 * Honours the deadline/fencing contract (kills the "worker" and raises INVOCATION_TIMEOUT).
 */
export class FakeExecutionBackend implements ExecutionBackend {
  readonly started: WorkerSpec[] = [];
  readonly stopped: string[] = [];
  readonly alive = new Map<string, WorkerSpec>();
  readonly sinks = new Map<string, LogSink>();
  startDelayMs = 0;
  failStart: XeroError | undefined;
  down = false;
  handler: FakeHandler = (_s, r) => ({ outcome: 'ok', payload: r.payload });
  private counter = 0;
  private readonly calls = new Map<string, number>();

  async ping(): Promise<void> {
    if (this.down) throw new XeroError('BACKEND_UNAVAILABLE', 'fake engine down');
  }

  async startWorker(spec: WorkerSpec): Promise<WorkerHandle> {
    if (this.down) throw new XeroError('BACKEND_UNAVAILABLE', 'fake engine down');
    if (this.failStart) throw this.failStart;
    if (this.startDelayMs) await new Promise((r) => setTimeout(r, this.startDelayMs));
    const backendId = `fake-${++this.counter}`;
    this.started.push(spec);
    this.alive.set(backendId, spec);
    return { workerId: spec.workerId, backendId, endpoint: `fake://${backendId}`, startedAt: Date.now() };
  }

  async invoke(worker: WorkerHandle, request: WorkerInvokeRequest): Promise<WorkerInvokeResult> {
    const spec = this.alive.get(worker.backendId);
    if (!spec) throw new XeroError('WORKER_CRASHED', 'worker is gone');
    const n = (this.calls.get(worker.backendId) ?? 0) + 1;
    this.calls.set(worker.backendId, n);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.alive.delete(worker.backendId);
        this.stopped.push(worker.backendId);
        reject(new XeroError('INVOCATION_TIMEOUT', 'invocation exceeded its timeout; worker was terminated'));
      }, Math.max(0, request.deadlineAt - Date.now()));
    });
    try {
      return await Promise.race([Promise.resolve(this.handler(spec, request, n)), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async stopWorker(worker: WorkerHandle): Promise<void> {
    if (this.alive.delete(worker.backendId)) this.stopped.push(worker.backendId);
    this.sinks.delete(worker.backendId);
  }

  streamLogs(worker: WorkerHandle, sink: LogSink): () => void {
    this.sinks.set(worker.backendId, sink);
    return () => this.sinks.delete(worker.backendId);
  }

  /** Emit a log line as if written by the function inside the worker. */
  emitLog(backendId: string, stream: 'stdout' | 'stderr', line: string): void {
    this.sinks.get(backendId)?.(stream, line, Date.now());
  }

  async listManaged(): Promise<ManagedWorkerInfo[]> {
    return [...this.alive.keys()].map((backendId) => ({ backendId, workerId: this.alive.get(backendId)!.workerId, running: true }));
  }

  async reap(backendId: string): Promise<void> {
    this.alive.delete(backendId);
    this.stopped.push(backendId);
  }
}
