import { connect } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { XeroError } from '@xero/core';
import {
  WORKER_ENDPOINT_PATH,
  type ExecutionBackend,
  type LogSink,
  type ManagedWorkerInfo,
  type WorkerHandle,
  type WorkerInvokeRequest,
  type WorkerInvokeResult,
  type WorkerSpec,
} from '@xero/execution';
import { MAX_PAYLOAD_BYTES, sleep, systemClock, type Clock } from '@xero/shared';
import { defaultSpawner, execRunner, type CommandRunner, type ProcessSpawner } from './cli.js';

export interface DockerBackendOptions {
  binary?: string;
  runner?: CommandRunner;
  spawner?: ProcessSpawner;
  clock?: Clock;
  /** Max time to wait for the runtime interface to accept connections. */
  startTimeoutMs?: number;
  pidsLimit?: number;
  tmpfsSizeMb?: number;
  /** Container uid:gid. Non-root by default. */
  user?: string;
  fetchImpl?: typeof fetch;
}

export const LABEL_MANAGED = 'xero.managed';
const RUNTIME_PORT = 8080;

/** Pure function so the hardening flags are unit-testable without a Docker daemon. */
export function buildRunArgs(spec: WorkerSpec, opts: { pidsLimit: number; tmpfsSizeMb: number; user: string; envFile?: string | undefined }): string[] {
  const cpus = Math.min(2, Math.max(0.1, spec.memoryMb / 1769)).toFixed(2);
  const args = [
    'run', '-d',
    '--name', `xero-${spec.workerId}`,
    '--label', `${LABEL_MANAGED}=true`,
    '--label', `xero.worker=${spec.workerId}`,
    '--label', `xero.function=${spec.functionId}`,
    '--label', `xero.deployment=${spec.deploymentId}`,
    '--read-only',
    '--tmpfs', `/tmp:rw,nosuid,size=${opts.tmpfsSizeMb}m`,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', String(opts.pidsLimit),
    '--memory', `${spec.memoryMb}m`,
    '--memory-swap', `${spec.memoryMb}m`,
    '--cpus', cpus,
    '--user', opts.user,
    '--publish', `127.0.0.1::${RUNTIME_PORT}`,
    '--volume', `${spec.artifactPath}:/var/task:ro`,
    '--env', 'HOME=/tmp',
    '--env', `AWS_LAMBDA_FUNCTION_NAME=${spec.functionName}`,
    '--env', `AWS_LAMBDA_FUNCTION_MEMORY_SIZE=${spec.memoryMb}`,
    '--env', `AWS_LAMBDA_FUNCTION_TIMEOUT=${spec.timeoutSec}`,
    '--env', 'AWS_LAMBDA_FUNCTION_VERSION=$LATEST',
    '--env', 'AWS_EXECUTION_ENV=Xero_Local',
  ];
  // Function variables (possibly secrets) travel in a 0600 env-file: not in argv (visible via ps) and never in the
  // docker client's own environment (a user-chosen name such as DOCKER_HOST or LD_PRELOAD must not affect the host CLI).
  if (opts.envFile) args.push('--env-file', opts.envFile);
  args.push(spec.image, ...spec.command);
  return args;
}

export class DockerBackend implements ExecutionBackend {
  private readonly binary: string;
  private readonly run: CommandRunner;
  private readonly spawner: ProcessSpawner;
  private readonly clock: Clock;
  private readonly startTimeoutMs: number;
  private readonly pidsLimit: number;
  private readonly tmpfsSizeMb: number;
  private readonly user: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DockerBackendOptions = {}) {
    this.binary = options.binary ?? 'docker';
    this.run = options.runner ?? execRunner;
    this.spawner = options.spawner ?? defaultSpawner;
    this.clock = options.clock ?? systemClock;
    this.startTimeoutMs = options.startTimeoutMs ?? 20_000;
    this.pidsLimit = options.pidsLimit ?? 256;
    this.tmpfsSizeMb = options.tmpfsSizeMb ?? 512;
    this.user = options.user ?? '1000:1000';
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async docker(args: readonly string[], env?: Record<string, string>, timeoutMs?: number) {
    try {
      return await this.run(this.binary, args, { env, timeoutMs });
    } catch (e) {
      throw new XeroError('BACKEND_UNAVAILABLE', `cannot execute "${this.binary}": is a Docker-compatible engine installed?`, undefined, { cause: e });
    }
  }

  async ping(): Promise<void> {
    const r = await this.docker(['version', '--format', '{{.Server.Version}}'], undefined, 10_000);
    if (r.code !== 0) throw new XeroError('BACKEND_UNAVAILABLE', 'container engine is not reachable (is the Docker daemon running?)', { stderr: r.stderr.slice(0, 300) });
  }

  async startWorker(spec: WorkerSpec): Promise<WorkerHandle> {
    const envDir = await mkdtemp(join(tmpdir(), 'xero-env-'));
    let run;
    try {
      const envFile = join(envDir, 'env');
      await writeFile(envFile, serializeEnvFile(spec.environment), { mode: 0o600 });
      const args = buildRunArgs(spec, { pidsLimit: this.pidsLimit, tmpfsSizeMb: this.tmpfsSizeMb, user: this.user, envFile });
      run = await this.docker(args, undefined, 120_000); // first run may pull the image
    } finally {
      await rm(envDir, { recursive: true, force: true });
    }
    if (run.code !== 0) {
      if (/Cannot connect to the Docker daemon|docker daemon running|error during connect|connection refused/i.test(run.stderr)) {
        throw new XeroError('BACKEND_UNAVAILABLE', 'container engine is not reachable (is the Docker daemon running?)');
      }
      throw new XeroError('WORKER_START_FAILED', 'failed to start worker container', { stderr: run.stderr.trim().slice(0, 500) });
    }
    const backendId = run.stdout.trim().split('\n').pop() ?? '';
    const handle: WorkerHandle = { workerId: spec.workerId, backendId, endpoint: '', startedAt: this.clock.now() };
    try {
      const port = await this.docker(['port', backendId, `${RUNTIME_PORT}/tcp`], undefined, 10_000);
      const m = /127\.0\.0\.1:(\d+)/.exec(port.stdout);
      if (port.code !== 0 || !m) throw new XeroError('WORKER_START_FAILED', 'could not resolve worker port');
      handle.endpoint = `http://127.0.0.1:${m[1]}`;
      await this.waitReady(handle, Number(m[1]));
      return handle;
    } catch (e) {
      const logs = await this.docker(['logs', '--tail', '20', backendId], undefined, 10_000).catch(() => undefined);
      await this.stopWorker(handle).catch(() => undefined);
      if (e instanceof XeroError) {
        throw new XeroError(e.code, e.message, { ...e.details, ...(logs ? { logTail: (logs.stdout + logs.stderr).slice(-500) } : {}) });
      }
      throw e;
    }
  }

  private async waitReady(handle: WorkerHandle, port: number): Promise<void> {
    const deadline = this.clock.now() + this.startTimeoutMs;
    while (this.clock.now() < deadline) {
      if (await this.probe(port)) return;
      const state = await this.state(handle.backendId);
      if (state && !state.Running) throw new XeroError('WORKER_START_FAILED', 'worker exited during startup', { exitCode: state.ExitCode ?? null });
      await sleep(100);
    }
    throw new XeroError('WORKER_START_FAILED', 'worker did not become ready in time');
  }

  /** docker-proxy accepts then drops connections while the backend is down; a socket that stays open means ready. */
  private probe(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = connect({ host: '127.0.0.1', port });
      const finish = (ok: boolean): void => {
        socket.destroy();
        resolve(ok);
      };
      socket.once('error', () => finish(false));
      socket.once('close', () => finish(false));
      socket.once('connect', () => setTimeout(() => finish(true), 150));
    });
  }

  private async state(backendId: string): Promise<{ Running: boolean; OOMKilled?: boolean; ExitCode?: number } | undefined> {
    const r = await this.docker(['inspect', '--format', '{{json .State}}', backendId], undefined, 10_000);
    if (r.code !== 0) return undefined;
    try {
      return JSON.parse(r.stdout) as { Running: boolean; OOMKilled?: boolean; ExitCode?: number };
    } catch {
      return undefined;
    }
  }

  async invoke(worker: WorkerHandle, request: WorkerInvokeRequest): Promise<WorkerInvokeResult> {
    const controller = new AbortController();
    const remaining = request.deadlineAt - this.clock.now();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, Math.max(0, remaining));
    const onAbort = (): void => controller.abort();
    request.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await this.fetchImpl(`${worker.endpoint}${WORKER_ENDPOINT_PATH}`, {
        method: 'POST',
        body: request.payload as Uint8Array<ArrayBuffer>,
        headers: { 'content-type': 'application/json', 'x-xero-request-id': request.requestId },
        signal: controller.signal,
      });
      const body = new Uint8Array(await res.arrayBuffer());
      if (body.byteLength > MAX_PAYLOAD_BYTES) throw new XeroError('PAYLOAD_TOO_LARGE', 'function response exceeds 6 MiB');
      return { outcome: classify(res.headers.get('x-amz-function-error'), res.status, body), payload: body };
    } catch (e) {
      if (e instanceof XeroError) throw e;
      if (timedOut) {
        // Fence: the worker may still be executing. Kill it so a late side effect cannot overlap a retry.
        await this.stopWorker(worker).catch(() => undefined);
        throw new XeroError('INVOCATION_TIMEOUT', 'invocation exceeded its timeout; worker was terminated');
      }
      if (request.signal?.aborted) {
        await this.stopWorker(worker).catch(() => undefined);
        throw new XeroError('INVOCATION_TIMEOUT', 'invocation was cancelled; worker was terminated');
      }
      const state = await this.state(worker.backendId);
      if (state?.OOMKilled) throw new XeroError('WORKER_OOM', 'worker was killed for exceeding its memory limit');
      throw new XeroError('WORKER_CRASHED', 'worker crashed or became unreachable', { exitCode: state?.ExitCode ?? null }, { cause: e });
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
    }
  }

  async stopWorker(worker: WorkerHandle): Promise<void> {
    await this.docker(['rm', '--force', '--volumes', worker.backendId], undefined, 30_000);
  }

  streamLogs(worker: WorkerHandle, sink: LogSink): () => void {
    const proc = this.spawner(this.binary, ['logs', '--follow', '--timestamps', worker.backendId]);
    const attach = (stream: 'stdout' | 'stderr', readable: NodeJS.ReadableStream): void => {
      let buf = '';
      readable.setEncoding('utf8');
      readable.on('data', (chunk: string) => {
        buf += chunk;
        let idx: number;
        while ((idx = buf.indexOf('\n')) >= 0) {
          emit(buf.slice(0, idx));
          buf = buf.slice(idx + 1);
        }
      });
      readable.on('end', () => buf && emit(buf));
      const emit = (raw: string): void => {
        const m = /^(\d{4}-\d{2}-\d{2}T[^\s]+)\s(.*)$/.exec(raw);
        const at = m ? Date.parse(m[1]!) : this.clock.now();
        sink(stream, (m ? m[2]! : raw).replace(/\r$/, ''), Number.isNaN(at) ? this.clock.now() : at);
      };
    };
    attach('stdout', proc.stdout);
    attach('stderr', proc.stderr);
    return () => proc.kill();
  }

  async listManaged(): Promise<ManagedWorkerInfo[]> {
    const r = await this.docker(['ps', '-a', '--filter', `label=${LABEL_MANAGED}=true`, '--format', '{{.ID}}\t{{.Label "xero.worker"}}\t{{.State}}'], undefined, 15_000);
    if (r.code !== 0) throw new XeroError('BACKEND_UNAVAILABLE', 'cannot list workers', { stderr: r.stderr.slice(0, 300) });
    return r.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [backendId = '', workerId = '', state = ''] = line.split('\t');
        return { backendId, workerId, running: state === 'running' };
      });
  }

  async reap(backendId: string): Promise<void> {
    await this.docker(['rm', '--force', '--volumes', backendId], undefined, 30_000);
  }
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Docker --env-file format: KEY=VALUE per line, no quoting. Rejects anything that cannot be represented safely. */
export function serializeEnvFile(env: Readonly<Record<string, string>>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (!ENV_NAME.test(k)) throw new XeroError('INVALID_REQUEST', `invalid environment variable name "${k}"`);
    if (/[\r\n\0]/.test(v)) throw new XeroError('INVALID_REQUEST', `environment variable ${k} contains a newline or NUL`);
    lines.push(`${k}=${v}`);
  }
  return `${lines.join('\n')}\n`;
}

function classify(header: string | null, status: number, body: Uint8Array): 'ok' | 'function-error' {
  if (header) return 'function-error';
  if (status >= 500) return 'function-error';
  // The RIE returns HTTP 200 with an {errorType, errorMessage} document when the handler throws.
  if (body.byteLength > 0 && body.byteLength < 64 * 1024 && body[0] === 0x7b) {
    try {
      const doc = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
      if (typeof doc.errorType === 'string' && typeof doc.errorMessage === 'string') return 'function-error';
    } catch {
      /* not JSON */
    }
  }
  return 'ok';
}
