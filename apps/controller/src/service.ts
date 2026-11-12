import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  XeroError,
  type ArtifactStore,
  type AwsConnection,
  type Deployment,
  type DeploymentView,
  type FunctionView,
  type EventSource,
  type FunctionRegistry,
  type InvocationRecord,
  type LambdaInvoker,
  type LogLine,
  type LogicalFunction,
  type Logger,
} from '@xero/core';
import type { ExecutionBackend, RuntimeCatalog } from '@xero/execution';
import type { InvocationRequest, InvocationResult, InvocationRouter } from '@xero/invocation';
import type { WorkerPool } from '@xero/scaling';
import type { AwsIdentity } from '@xero/aws-identity';
import {
  parseLambdaArn,
  parseQueueUrl,
  runtimeFamily,
  type AttachEventSourceRequest,
  type AwsConnectionRequest,
  type BindAwsLambdaRequest,
  type DeployLocalRequest,
  type Target,
} from '@xero/specification';
import { newId, systemClock, type Clock, type IdGenerator } from '@xero/shared';
import type { MetricsRegistry } from '@xero/telemetry';
import type { ControllerConfig } from './config.js';
import type { EventSourceManager } from './event-sources.js';

export function deploymentView(d: Deployment): DeploymentView {
  const base = { id: d.id, target: d.target, version: d.version, status: d.status, createdAt: d.createdAt };
  if (d.target === 'local') {
    const c = d.config;
    return {
      ...base,
      details: {
        runtime: c.runtime, handler: c.handler, artifactId: c.artifactId, memoryMb: c.memoryMb, timeoutSec: c.timeoutSec,
        maxConcurrency: c.maxConcurrency, idleTtlSec: c.idleTtlSec, minWarm: c.minWarm ?? 0, environmentKeys: Object.keys(c.environment).sort(), awsRoleArn: c.awsRoleArn ?? null,
      },
    };
  }
  const c = d.config;
  return { ...base, details: { mode: c.mode, arn: c.arn, region: c.region, accountId: c.accountId, verified: c.verified, verifiedAt: c.verifiedAt ?? null, observed: c.observed ?? null } };
}

export interface ServiceDeps {
  config: ControllerConfig;
  registry: FunctionRegistry;
  artifacts: ArtifactStore;
  runtimes: RuntimeCatalog;
  backend: ExecutionBackend;
  /** Writes a consistent snapshot of the registry to the given path. */
  backup: (destination: string) => void;
  router: InvocationRouter;
  pool: WorkerPool;
  identity: AwsIdentity;
  lambda: LambdaInvoker;
  events: EventSourceManager;
  metrics: MetricsRegistry;
  logger: Logger;
  clock?: Clock;
  ids?: IdGenerator;
}

/** All product behaviour lives here; the HTTP layer only translates. */
export class XeroService {
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  constructor(private readonly d: ServiceDeps) {
    this.clock = d.clock ?? systemClock;
    this.ids = d.ids ?? newId;
  }

  // ---------- functions ----------
  private mustGet(name: string): LogicalFunction {
    const fn = this.d.registry.getFunctionByName(name);
    if (!fn) throw new XeroError('FUNCTION_NOT_FOUND', `function "${name}" not found`);
    return fn;
  }

  private view(fn: LogicalFunction): FunctionView {
    const deployments: FunctionView['deployments'] = {};
    for (const target of ['local', 'aws-lambda'] as const) {
      const dep = this.d.registry.getActiveDeployment(fn.id, target);
      if (dep) deployments[target] = deploymentView(dep);
    }
    return { id: fn.id, name: fn.name, description: fn.description, routing: fn.routing, deployments, createdAt: fn.createdAt, updatedAt: fn.updatedAt };
  }

  listFunctions(): FunctionView[] {
    return this.d.registry.listFunctions().map((f) => this.view(f));
  }

  inspect(name: string): {
    function: FunctionView;
    history: DeploymentView[];
    eventSources: Array<EventSource & { running: boolean; warnings: string[] }>;
    recentInvocations: InvocationRecord[];
    workers: { total: number; busy: number; idle: number };
  } {
    const fn = this.mustGet(name);
    return {
      function: this.view(fn),
      history: this.d.registry.listDeployments(fn.id).map(deploymentView),
      eventSources: this.d.registry.listEventSources(fn.id).map((s) => ({ ...s, ...this.eventStatus(s.id) })),
      recentInvocations: this.d.registry.listInvocations(fn.id, 10),
      workers: this.d.pool.stats(),
    };
  }

  private eventStatus(id: string): { running: boolean; warnings: string[] } {
    const s = this.d.events.status(id);
    return { running: s.running, warnings: s.warnings };
  }

  /** Deploys (or updates) the `local` target of a logical function from a directory on the controller host. */
  async deployLocal(name: string, req: Omit<DeployLocalRequest, 'name'>): Promise<{ function: FunctionView; warnings: string[]; artifact: { id: string; sizeBytes: number; fileCount: number } }> {
    const adapter = this.d.runtimes.adapterFor(req.runtime);
    adapter.validateHandler(req.handler);
    const sourcePath = resolve(req.sourcePath);
    const artifact = await this.d.artifacts.ingest(sourcePath);
    const root = this.d.artifacts.pathOf(artifact.id);
    const found = await Promise.all(adapter.handlerFileCandidates(req.handler).map((f) => access(join(root, f), constants.R_OK).then(() => true, () => false)));
    if (!found.some(Boolean)) {
      throw new XeroError('ARTIFACT_INVALID', `handler file for "${req.handler}" not found in the artifact (looked for ${adapter.handlerFileCandidates(req.handler).join(', ')})`);
    }
    const minWarm = req.minWarm ?? 0;
    if (minWarm > (req.maxConcurrency ?? 2)) throw new XeroError('INVALID_REQUEST', 'minWarm cannot exceed maxConcurrency');
    const warnings: string[] = [];
    let fn = this.d.registry.getFunctionByName(name);
    const aws = fn ? this.d.registry.getActiveDeployment(fn.id, 'aws-lambda') : undefined;
    if (aws?.target === 'aws-lambda') warnings.push(...this.compatibility(req.runtime, req.handler, aws.config.observed, 'deploy'));
    if (req.awsRoleArn && !this.d.registry.getAwsConnection()) warnings.push('this deployment names an AWS role but AWS is not connected; invocations will fail until "xero aws connect"');
    if (!fn) fn = this.d.registry.createFunction({ name, description: req.description, routing: { strategy: 'manual', defaultTarget: req.defaultTarget ?? 'local' } });
    else if (req.defaultTarget) {
      this.requireTarget(fn, req.defaultTarget, 'local');
      fn = this.d.registry.updateRouting(fn.id, { strategy: 'manual', defaultTarget: req.defaultTarget });
    }
    const previous = this.d.registry.getActiveDeployment(fn.id, 'local');
    this.d.registry.addDeployment(fn.id, {
      target: 'local',
      config: {
        artifactId: artifact.id, runtime: req.runtime, handler: req.handler, memoryMb: req.memoryMb ?? 128, timeoutSec: req.timeoutSec ?? 3,
        maxConcurrency: req.maxConcurrency ?? 2, idleTtlSec: req.idleTtlSec ?? 60, minWarm, environment: req.environment ?? {}, awsRoleArn: req.awsRoleArn,
      },
    });
    if (previous) await this.d.pool.retireDeployment(previous.id);
    this.d.logger.info('local deployment created', { functionId: fn.id, artifact: artifact.id });
    return { function: this.view(this.mustGet(name)), warnings, artifact };
  }

  /** Requires the future default target to exist or be the one being deployed right now. */
  private requireTarget(fn: LogicalFunction, target: Target, deploying: Target | undefined): void {
    if (target === deploying) return;
    if (!this.d.registry.getActiveDeployment(fn.id, target)) {
      throw new XeroError('TARGET_NOT_DEPLOYED', `cannot make ${target} the default: it has no active deployment`);
    }
  }

  private compatibility(localRuntime: string, localHandler: string, observed: { runtime?: string | undefined; handler?: string | undefined } | undefined, phase: 'deploy' | 'bind'): string[] {
    const out: string[] = [];
    if (!observed) return out;
    if (observed.runtime) {
      const lf = runtimeFamily(localRuntime);
      const af = runtimeFamily(observed.runtime);
      if (lf !== af) {
        throw new XeroError('INCOMPATIBLE_TARGET', `local runtime ${localRuntime} and the native Lambda runtime ${observed.runtime} are different families; they cannot back one logical function (${phase})`, { local: localRuntime, awsLambda: observed.runtime });
      }
      if (localRuntime !== observed.runtime) out.push(`runtime differs between targets: local ${localRuntime}, native Lambda ${observed.runtime}`);
    } else out.push('native Lambda runtime is not reported (container image or custom runtime); compatibility cannot be checked');
    if (observed.handler && observed.handler !== localHandler) out.push(`handler differs between targets: local ${localHandler}, native Lambda ${observed.handler}`);
    return out;
  }

  private assertAccountRegion(accountId: string, region: string, what: string): void {
    const connection = this.d.registry.getAwsConnection();
    const { allowedAccountIds, allowedRegions } = this.d.config;
    if (connection && accountId !== connection.accountId && !allowedAccountIds.includes(accountId)) {
      throw new XeroError('INVALID_REQUEST', `${what} belongs to AWS account ${accountId}, which is not the connected account; allow it explicitly with XERO_ALLOWED_ACCOUNTS`);
    }
    if (!connection && !allowedAccountIds.includes(accountId)) {
      // Unverified bindings are still restricted when an allow-list exists.
      if (allowedAccountIds.length > 0) throw new XeroError('INVALID_REQUEST', `${what} belongs to AWS account ${accountId}, which is not allowed`);
    }
    if (allowedRegions.length > 0 && !allowedRegions.includes(region)) {
      throw new XeroError('INVALID_REQUEST', `${what} is in region ${region}, which is not in XERO_ALLOWED_REGIONS`);
    }
  }

  /** Binds an *existing* native Lambda as the `aws-lambda` deployment of a logical function. Never creates anything in AWS. */
  async bindAwsLambda(name: string, req: BindAwsLambdaRequest): Promise<{ function: FunctionView; warnings: string[] }> {
    const arn = parseLambdaArn(req.arn);
    if (!arn) throw new XeroError('INVALID_REQUEST', 'invalid Lambda function ARN');
    this.assertAccountRegion(arn.accountId, arn.region, 'the Lambda function');
    const warnings: string[] = [];
    let observed;
    if (req.verify) {
      if (!this.d.registry.getAwsConnection()) throw new XeroError('AWS_NOT_CONNECTED', 'verification needs "xero aws connect" (or bind with verify=false to skip, which is recorded as unverified)');
      this.d.metrics.inc('aws_requests_total', { operation: 'lambda:GetFunctionConfiguration' });
      observed = await this.d.lambda.describe(req.arn, arn.region);
    } else warnings.push('binding is UNVERIFIED: the function was not checked with lambda:GetFunctionConfiguration');
    let fn = this.d.registry.getFunctionByName(name);
    const local = fn ? this.d.registry.getActiveDeployment(fn.id, 'local') : undefined;
    if (local?.target === 'local') warnings.push(...this.compatibility(local.config.runtime, local.config.handler, observed, 'bind'));
    if (!fn) fn = this.d.registry.createFunction({ name, description: undefined, routing: { strategy: 'manual', defaultTarget: req.defaultTarget ?? 'aws-lambda' } });
    else if (req.defaultTarget) {
      this.requireTarget(fn, req.defaultTarget, 'aws-lambda');
      this.d.registry.updateRouting(fn.id, { strategy: 'manual', defaultTarget: req.defaultTarget });
    }
    this.d.registry.addDeployment(fn.id, {
      target: 'aws-lambda',
      config: {
        mode: 'existing', arn: req.arn, region: arn.region, accountId: arn.accountId, functionName: arn.functionName, qualifier: arn.qualifier,
        verified: Boolean(observed), verifiedAt: observed ? this.clock.now() : undefined, observed,
      },
    });
    warnings.push('Xero does not control or build the native Lambda code; local and AWS deployments may diverge (see docs/architecture/runtime-compatibility.md)');
    return { function: this.view(this.mustGet(name)), warnings };
  }

  async removeDeployment(name: string, target: Target): Promise<{ function: FunctionView }> {
    const fn = this.mustGet(name);
    const active = this.d.registry.getActiveDeployment(fn.id, target);
    const versions = this.d.registry.listDeployments(fn.id).filter((d) => d.target === target && d.status !== 'removed').map((d) => d.id);
    if (fn.routing.defaultTarget === target && this.d.registry.getActiveDeployment(fn.id, target === 'local' ? 'aws-lambda' : 'local')) {
      throw new XeroError('INVALID_REQUEST', `${target} is the default target; change it first with "functions route"`);
    }
    const { artifactIds } = this.d.registry.removeDeployment(fn.id, target);
    for (const id of versions) await this.d.pool.retireDeployment(id);
    if (active) await this.d.pool.retireDeployment(active.id);
    await this.collectArtifacts(artifactIds);
    return { function: this.view(this.mustGet(name)) };
  }

  async deleteFunction(name: string): Promise<void> {
    const fn = this.mustGet(name);
    for (const s of this.d.registry.listEventSources(fn.id)) await this.d.events.stopSource(s.id);
    const deps = this.d.registry.listDeployments(fn.id);
    const { artifactIds } = this.d.registry.deleteFunction(fn.id);
    for (const d of deps) await this.d.pool.retireDeployment(d.id);
    await this.collectArtifacts(artifactIds);
  }

  private async collectArtifacts(ids: string[]): Promise<void> {
    for (const id of new Set(ids)) {
      if (!this.d.registry.isArtifactReferenced(id)) await this.d.artifacts.remove(id).catch((e: unknown) => this.d.logger.warn('artifact cleanup failed', { artifactId: id, error: e }));
    }
  }

  setRouting(name: string, defaultTarget: Target): FunctionView {
    const fn = this.mustGet(name);
    this.requireTarget(fn, defaultTarget, undefined);
    this.d.registry.updateRouting(fn.id, { strategy: 'manual', defaultTarget });
    return this.view(this.mustGet(name));
  }

  // ---------- invocation ----------
  invoke(req: InvocationRequest): Promise<InvocationResult> {
    return this.d.router.invoke(req);
  }

  logs(name: string, opts: { limit: number; sinceMs?: number | undefined }): LogLine[] {
    return this.d.registry.readLogs(this.mustGet(name).id, opts);
  }

  prometheus(): string {
    return this.d.metrics.renderPrometheus();
  }

  invocations(name: string, limit: number): InvocationRecord[] {
    return this.d.registry.listInvocations(this.mustGet(name).id, limit);
  }

  metricsSnapshot(): { series: ReturnType<MetricsRegistry['snapshot']>; workers: { total: number; busy: number; idle: number } } {
    return { series: this.d.metrics.snapshot(), workers: this.d.pool.stats() };
  }

  // ---------- operations ----------
  /** Pre-pulls the base images of all supported runtimes (or the given ones). */
  async pullImages(runtimes?: string[]): Promise<{ pulled: string[] }> {
    if (!this.d.backend.pullImage) throw new XeroError('BACKEND_UNAVAILABLE', 'this execution backend cannot pre-pull images');
    const wanted = (runtimes?.length ? runtimes : this.d.runtimes.supported()) as Parameters<RuntimeCatalog['adapterFor']>[0][];
    const images = [...new Set(wanted.map((r) => this.d.runtimes.adapterFor(r).imageFor(r)))];
    for (const image of images) await this.d.backend.pullImage(image);
    return { pulled: images };
  }

  /** Consistent registry snapshot under `<home>/backups` (0600). Artifacts are content-addressed and not copied. */
  createBackup(): { path: string } {
    const stamp = new Date(this.clock.now()).toISOString().replace(/[:.]/g, '-');
    const path = join(this.d.config.home, 'backups', `xero-${stamp}.db`);
    this.d.backup(path);
    return { path };
  }

  async ready(): Promise<{ ready: boolean; engine: boolean }> {
    let engine = true;
    try {
      await this.d.backend.ping();
    } catch {
      engine = false;
    }
    let db = true;
    try {
      this.d.registry.listFunctions();
    } catch {
      db = false;
    }
    return { ready: db, engine };
  }

  /** Self-diagnosis for operators. Contains no secrets. */
  async doctor(): Promise<{ ok: boolean; checks: Array<{ name: string; status: 'ok' | 'warn' | 'fail'; detail: string }> }> {
    const checks: Array<{ name: string; status: 'ok' | 'warn' | 'fail'; detail: string }> = [];
    try {
      await this.d.backend.ping();
      checks.push({ name: 'container-engine', status: 'ok', detail: 'reachable' });
    } catch (e) {
      checks.push({ name: 'container-engine', status: 'fail', detail: e instanceof XeroError ? `${e.code}: ${e.message}` : 'unreachable' });
    }
    try {
      const n = this.d.registry.listFunctions().length;
      checks.push({ name: 'database', status: 'ok', detail: `${n} function(s)` });
    } catch {
      checks.push({ name: 'database', status: 'fail', detail: 'registry not readable' });
    }
    const aws = await this.awsStatus();
    checks.push(
      !aws.connected
        ? { name: 'aws', status: 'ok', detail: 'not connected (local-only mode)' }
        : aws.valid
          ? { name: 'aws', status: 'ok', detail: `connected to account ${aws.connection?.accountId}` }
          : { name: 'aws', status: 'warn', detail: `credentials not valid (${aws.error}); local functions are unaffected` },
    );
    const sources = this.d.registry.listEventSources();
    const down = sources.filter((s) => !this.d.events.status(s.id).running);
    checks.push({ name: 'event-sources', status: down.length ? 'warn' : 'ok', detail: `${sources.length - down.length}/${sources.length} running` });
    const w = this.d.pool.stats();
    checks.push({ name: 'workers', status: 'ok', detail: `${w.total} running (${w.busy} busy), limit ${this.d.config.maxWorkers}` });
    return { ok: checks.every((c) => c.status !== 'fail'), checks };
  }

  // ---------- AWS ----------
  getAwsConnection(): AwsConnection | undefined {
    return this.d.registry.getAwsConnection();
  }

  async connectAws(req: AwsConnectionRequest): Promise<{ connection: AwsConnection; warnings: string[] }> {
    const target = { profile: req.profile, region: req.region };
    this.d.metrics.inc('aws_requests_total', { operation: 'sts:GetCallerIdentity' });
    this.d.identity.forget();
    const id = await this.d.identity.verify(target);
    const connection: AwsConnection = { profile: req.profile, region: req.region, accountId: id.accountId, principalArn: id.arn, verifiedAt: this.clock.now() };
    this.d.registry.setAwsConnection(connection);
    await this.d.events.stopAll();
    await this.d.events.startAll();
    return { connection, warnings: id.warnings };
  }

  async awsStatus(): Promise<{ connected: boolean; connection?: AwsConnection; valid?: boolean; error?: string }> {
    const c = this.d.registry.getAwsConnection();
    if (!c) return { connected: false };
    try {
      this.d.metrics.inc('aws_requests_total', { operation: 'sts:GetCallerIdentity' });
      await this.d.identity.verify({ profile: c.profile, region: c.region });
      return { connected: true, connection: c, valid: true };
    } catch (e) {
      return { connected: true, connection: c, valid: false, error: e instanceof XeroError ? e.code : 'ERROR' };
    }
  }

  async disconnectAws(): Promise<void> {
    await this.d.events.stopAll();
    this.d.registry.setAwsConnection(undefined);
    this.d.identity.forget();
  }

  // ---------- event sources ----------
  async attachEventSource(req: AttachEventSourceRequest): Promise<{ eventSource: EventSource; warnings: string[]; queue: { visibilityTimeoutSec: number; hasDeadLetterQueue: boolean; fifo: boolean } }> {
    const fn = this.mustGet(req.functionName);
    const connection = this.d.registry.getAwsConnection();
    if (!connection) throw new XeroError('AWS_NOT_CONNECTED', 'attaching an SQS event source requires "xero aws connect"');
    const q = parseQueueUrl(req.queueUrl);
    if (!q) throw new XeroError('EVENT_SOURCE_INVALID', 'invalid SQS queue URL');
    this.assertAccountRegion(q.accountId, q.region, 'the SQS queue');
    if (!this.d.registry.getActiveDeployment(fn.id, req.target)) throw new XeroError('TARGET_NOT_DEPLOYED', `function has no active ${req.target} deployment`);
    const source: EventSource = {
      id: this.ids('es'), functionId: fn.id, kind: 'sqs', target: req.target, queueUrl: req.queueUrl, region: q.region,
      batchSize: req.batchSize, maxInFlight: req.maxInFlight, visibilityExtensionSec: req.visibilityExtensionSec, createdAt: this.clock.now(),
    };
    if (this.d.registry.listEventSources(fn.id).some((s) => s.queueUrl === req.queueUrl)) throw new XeroError('EVENT_SOURCE_INVALID', 'this queue is already attached to the function');
    const started = await this.d.events.startSource(source); // validates reachability/permissions before persisting
    try {
      this.d.registry.saveEventSource(source);
    } catch (e) {
      await this.d.events.stopSource(source.id);
      throw e;
    }
    return { eventSource: source, warnings: started.warnings, queue: { visibilityTimeoutSec: started.visibilityTimeoutSec, hasDeadLetterQueue: started.hasDeadLetterQueue, fifo: started.fifo } };
  }

  listEventSources(): Array<EventSource & { functionName: string | undefined; running: boolean; warnings: string[]; stats: unknown }> {
    return this.d.registry.listEventSources().map((s) => ({ ...s, functionName: this.d.registry.getFunctionById(s.functionId)?.name, ...this.d.events.status(s.id) }));
  }

  async detachEventSource(id: string): Promise<void> {
    await this.d.events.stopSource(id);
    if (!this.d.registry.deleteEventSource(id)) throw new XeroError('EVENT_SOURCE_NOT_FOUND', 'event source not found');
  }
}
