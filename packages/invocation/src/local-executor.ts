import { XeroError, type ArtifactStore, type CredentialIssuer, type FunctionRegistry, type LocalDeployment, type Logger, type Metrics } from '@xero/core';
import type { ExecutionBackend, RuntimeCatalog, WorkerSpec } from '@xero/execution';
import { systemClock, type Clock } from '@xero/shared';
import type { ConcurrencyScheduler } from '@xero/scheduler';
import type { WorkerPool } from '@xero/scaling';
import type { ExecContext, ExecOutcome, ExecResult, TargetExecutor } from './types.js';

export interface LocalExecutorOptions {
  registry: FunctionRegistry;
  artifacts: ArtifactStore;
  runtimes: RuntimeCatalog;
  scheduler: ConcurrencyScheduler;
  pool: WorkerPool;
  backend?: ExecutionBackend;
  credentials?: CredentialIssuer | undefined;
  clock?: Clock;
  metrics?: Metrics | undefined;
  logger?: Logger | undefined;
  /** Notified of each injected secret so log redaction can scrub it. */
  onSecret?: ((secret: string) => void) | undefined;
  maxQueueWaitMs?: number;
  credentialSessionSec?: number;
}

/** Executes on a Xero worker. Holds a scheduler lease for the whole invocation. */
export class LocalTargetExecutor implements TargetExecutor {
  private readonly clock: Clock;
  constructor(private readonly o: LocalExecutorOptions) {
    this.clock = o.clock ?? systemClock;
  }

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const dep = ctx.deployment as LocalDeployment;
    const cfg = dep.config;
    const queueWait = Math.min(cfg.timeoutSec * 1000, this.o.maxQueueWaitMs ?? 30_000);
    const lease = await this.o.scheduler.acquire(dep.id, cfg.maxConcurrency, { deadlineAt: this.clock.now() + queueWait, signal: ctx.signal });
    const run = async (): Promise<ExecOutcome> => {
      try {
        return await this.runOnWorker(ctx, dep);
      } finally {
        lease.release();
      }
    };
    if (ctx.invocationType === 'Event') {
      // Capacity is reserved (lease held) before acceptance; the run continues in the background.
      const settled = run();
      settled.catch(() => undefined);
      return { status: 'accepted', payload: new Uint8Array(), coldStart: undefined, awsRequestId: undefined, executedVersion: undefined, functionError: undefined, settled };
    }
    return run();
  }

  private async runOnWorker(ctx: ExecContext, dep: LocalDeployment): Promise<ExecOutcome> {
    const cfg = dep.config;
    const { worker, cold } = await this.o.pool.checkout({
      deploymentId: dep.id,
      functionId: dep.functionId,
      idleTtlMs: cfg.idleTtlSec * 1000,
      minWarm: cfg.minWarm ?? 0,
      build: (workerId) => this.buildSpec(ctx, dep, workerId),
    });
    let healthy = true;
    worker.lastRequestId = ctx.requestId; // set before dispatch so log lines emitted during the run are attributed to it
    try {
      const result = await this.o.pool.backendFor().invoke(worker.handle, {
        requestId: ctx.requestId,
        payload: ctx.payload,
        deadlineAt: this.clock.now() + cfg.timeoutSec * 1000,
        signal: ctx.signal,
      });
      return {
        status: result.outcome === 'ok' ? 'succeeded' : 'function-error',
        payload: result.payload,
        coldStart: cold,
        awsRequestId: undefined,
        executedVersion: String(dep.version),
        functionError: result.outcome === 'ok' ? undefined : 'Unhandled',
      };
    } catch (e) {
      healthy = false; // timeouts, crashes and OOM kills never return a worker to the warm pool
      throw e;
    } finally {
      await this.o.pool.checkin(worker, { healthy, requestId: ctx.requestId });
    }
  }

  private async buildSpec(ctx: ExecContext, dep: LocalDeployment, workerId: string): Promise<{ spec: WorkerSpec; credentialsExpireAt?: number | undefined }> {
    const cfg = dep.config;
    const adapter = this.o.runtimes.adapterFor(cfg.runtime);
    const env: Record<string, string> = { ...cfg.environment };
    let expiresAt: number | undefined;
    const connection = this.o.registry.getAwsConnection();
    if (connection) {
      env.AWS_REGION = connection.region;
      env.AWS_DEFAULT_REGION = connection.region;
    }
    if (cfg.awsRoleArn) {
      if (!connection || !this.o.credentials) {
        throw new XeroError('AWS_NOT_CONNECTED', 'this deployment assumes an AWS role; run "xero aws connect" first');
      }
      const sessionName = `xero-${ctx.fn.name}`.replace(/[^\w+=,.@-]/g, '-').slice(0, 64);
      const c = await this.o.credentials.issue({ roleArn: cfg.awsRoleArn, sessionName, durationSec: this.o.credentialSessionSec ?? 3600, region: connection.region });
      this.o.metrics?.inc('aws_requests_total', { operation: 'sts:AssumeRole' });
      for (const s of [c.accessKeyId, c.secretAccessKey, c.sessionToken]) this.o.onSecret?.(s);
      env.AWS_ACCESS_KEY_ID = c.accessKeyId;
      env.AWS_SECRET_ACCESS_KEY = c.secretAccessKey;
      env.AWS_SESSION_TOKEN = c.sessionToken;
      expiresAt = c.expiresAt;
    }
    return {
      credentialsExpireAt: expiresAt,
      spec: {
        workerId,
        functionId: dep.functionId,
        deploymentId: dep.id,
        functionName: ctx.fn.name,
        image: adapter.imageFor(cfg.runtime),
        command: adapter.commandFor(cfg.handler),
        artifactPath: this.o.artifacts.pathOf(cfg.artifactId),
        memoryMb: cfg.memoryMb,
        timeoutSec: cfg.timeoutSec,
        environment: env,
      },
    };
  }
}
