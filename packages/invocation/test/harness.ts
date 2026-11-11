import { XeroError, type ArtifactStore, type AwsLambdaConfig, type CredentialIssuer, type FunctionRegistry, type LambdaInvoker, type LambdaInvokeRequest, type LambdaInvokeResult, type LocalConfig } from '@xero/core';
import { FakeExecutionBackend, RuntimeCatalog, type RuntimeAdapter } from '@xero/execution';
import { SqliteRegistry } from '@xero/registry';
import { MetricsRegistry } from '@xero/telemetry';
import { ConcurrencyScheduler } from '@xero/scheduler';
import { WorkerPool } from '@xero/scaling';
import { AwsLambdaTargetExecutor, InvocationRouter, LocalTargetExecutor } from '../src/index.js';

export const stubAdapter: RuntimeAdapter = {
  family: 'nodejs',
  runtimes: ['nodejs22.x', 'nodejs20.x'],
  imageFor: (r) => `img-${r}`,
  validateHandler: () => undefined,
  handlerFileCandidates: (h) => [`${h.split('.')[0]}.js`],
  commandFor: (h) => [h],
};

export const artifacts: ArtifactStore = {
  ingest: async () => ({ id: 'sha256:' + 'a'.repeat(64), sizeBytes: 1, fileCount: 1 }),
  pathOf: (id) => `/store/${id.slice(7, 15)}`,
  remove: async () => undefined,
};

export class FakeLambda implements LambdaInvoker {
  calls: LambdaInvokeRequest[] = [];
  behavior: (r: LambdaInvokeRequest) => Promise<LambdaInvokeResult> | LambdaInvokeResult = (r) => ({
    statusCode: r.invocationType === 'Event' ? 202 : 200, functionError: undefined, executedVersion: '7', awsRequestId: 'aws-req-1', payload: new TextEncoder().encode('{"from":"lambda"}'),
  });
  async invoke(r: LambdaInvokeRequest): Promise<LambdaInvokeResult> {
    this.calls.push(r);
    return this.behavior(r);
  }
  async describe(): Promise<never> {
    throw new XeroError('INTERNAL', 'not used');
  }
}

export const localConfig = (over: Partial<LocalConfig> = {}): LocalConfig => ({
  artifactId: 'sha256:' + 'a'.repeat(64), runtime: 'nodejs22.x', handler: 'index.handler', memoryMb: 128, timeoutSec: 2,
  maxConcurrency: 2, idleTtlSec: 60, environment: { TABLE: 'orders' }, awsRoleArn: undefined, ...over,
});
export const lambdaConfig: AwsLambdaConfig = {
  mode: 'existing', arn: 'arn:aws:lambda:us-east-1:123456789012:function:hello:live', region: 'us-east-1', accountId: '123456789012',
  functionName: 'hello', qualifier: 'live', verified: true, verifiedAt: 1, observed: undefined,
};

export function harness(opts: { maxConcurrent?: number; queueLimit?: number; maxWorkers?: number; issuer?: CredentialIssuer } = {}) {
  const registry: FunctionRegistry & { close(): void } = new SqliteRegistry(':memory:');
  const backend = new FakeExecutionBackend();
  const metrics = new MetricsRegistry();
  const secrets: string[] = [];
  const scheduler = new ConcurrencyScheduler({ maxConcurrent: opts.maxConcurrent ?? 8, queueLimit: opts.queueLimit ?? 4, metrics });
  const pool = new WorkerPool({ backend, maxWorkers: opts.maxWorkers ?? 8, metrics });
  const lambda = new FakeLambda();
  const local = new LocalTargetExecutor({ registry, artifacts, runtimes: new RuntimeCatalog([stubAdapter]), scheduler, pool, credentials: opts.issuer, metrics, onSecret: (s) => secrets.push(s) });
  const aws = new AwsLambdaTargetExecutor({ registry, invoker: () => lambda, metrics });
  const router = new InvocationRouter({ registry, executors: { local, 'aws-lambda': aws }, metrics });
  return { registry, backend, metrics, scheduler, pool, lambda, router, secrets };
}

export const enc = (v: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(v));
export const dec = (b: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(b));
