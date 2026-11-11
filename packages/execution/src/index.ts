import { XeroError } from '@xero/core';
import type { Runtime, RuntimeFamily } from '@xero/specification';

export interface WorkerSpec {
  workerId: string;
  functionId: string;
  deploymentId: string;
  functionName: string;
  image: string;
  /** Container command, i.e. the handler string understood by the AWS runtime interface. */
  command: string[];
  /** Absolute host path of the immutable artifact. Mounted read-only. */
  artifactPath: string;
  memoryMb: number;
  timeoutSec: number;
  /** May contain secrets (temporary credentials). Backends must not expose it via process arguments. */
  environment: Readonly<Record<string, string>>;
}

export interface WorkerHandle {
  workerId: string;
  /** Backend specific container/process id. */
  backendId: string;
  endpoint: string;
  startedAt: number;
}

export interface WorkerInvokeRequest {
  requestId: string;
  payload: Uint8Array;
  /** Absolute epoch-ms deadline. The backend MUST fence (kill) the worker when it passes. */
  deadlineAt: number;
  signal?: AbortSignal | undefined;
}

export interface WorkerInvokeResult {
  /** 'function-error' means the handler threw; payload is the error document. */
  outcome: 'ok' | 'function-error';
  payload: Uint8Array;
}

export interface ManagedWorkerInfo {
  workerId: string;
  backendId: string;
  running: boolean;
}

export type LogStreamName = 'stdout' | 'stderr';
export type LogSink = (stream: LogStreamName, line: string, at: number) => void;

/**
 * Port implemented by execution backends. Failures are reported as XeroError with codes
 * WORKER_START_FAILED, INVOCATION_TIMEOUT, WORKER_CRASHED, WORKER_OOM, BACKEND_UNAVAILABLE.
 */
export interface ExecutionBackend {
  ping(): Promise<void>;
  startWorker(spec: WorkerSpec): Promise<WorkerHandle>;
  invoke(worker: WorkerHandle, request: WorkerInvokeRequest): Promise<WorkerInvokeResult>;
  stopWorker(worker: WorkerHandle): Promise<void>;
  /** Streams logs until the returned stop function is called or the worker ends. */
  streamLogs(worker: WorkerHandle, sink: LogSink): () => void;
  listManaged(): Promise<ManagedWorkerInfo[]>;
  /** Removes a managed worker by backend id (orphan reaping). */
  reap(backendId: string): Promise<void>;
}

export interface RuntimeAdapter {
  family: RuntimeFamily;
  runtimes: readonly Runtime[];
  imageFor(runtime: Runtime): string;
  validateHandler(handler: string): void;
  /** Candidate artifact-relative paths that must exist (any one) for the handler to resolve. */
  handlerFileCandidates(handler: string): string[];
  commandFor(handler: string): string[];
}

export class RuntimeCatalog {
  private readonly byRuntime = new Map<Runtime, RuntimeAdapter>();
  constructor(adapters: readonly RuntimeAdapter[]) {
    for (const a of adapters) for (const r of a.runtimes) this.byRuntime.set(r, a);
  }
  adapterFor(runtime: Runtime): RuntimeAdapter {
    const a = this.byRuntime.get(runtime);
    if (!a) throw new XeroError('RUNTIME_UNSUPPORTED', `runtime ${runtime} is not supported`);
    return a;
  }
  supported(): Runtime[] {
    return [...this.byRuntime.keys()];
  }
}

/** Resolves `XERO_IMAGE_<RUNTIME>` overrides (e.g. XERO_IMAGE_NODEJS22_X) so operators can pin digests or mirror images. */
export function imageOverride(runtime: Runtime, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const key = `XERO_IMAGE_${runtime.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  return env[key] || undefined;
}

export const WORKER_ENDPOINT_PATH = '/2015-03-31/functions/function/invocations';
