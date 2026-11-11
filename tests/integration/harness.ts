import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { XeroError, type EventSource, type IssuedCredentials, type LambdaInvokeRequest, type LambdaInvokeResult, type LambdaInvoker, type ObservedLambdaConfig } from '@xero/core';
import { FakeExecutionBackend } from '@xero/execution';
import { AwsIdentity, type ConnectionTarget, type VerifiedIdentity } from '@xero/aws-identity';
import { createController, type Controller } from '@xero/controller';
import { XeroClient } from '@xero/sdk';
import { silentLogger } from '@xero/telemetry';
import type { SqsPort } from '@xero/event-source-sqs';

/** Artifact stores are read-only by design; restore write bits before deleting a test directory. */
export function forceRemove(dir: string): void {
  const walk = (p: string): void => {
    let st;
    try { st = lstatSync(p); } catch { return; }
    if (!st.isDirectory()) return;
    chmodSync(p, 0o755);
    for (const n of readdirSync(p)) walk(`${p}/${n}`);
  };
  walk(dir);
  rmSync(dir, { recursive: true, force: true });
}

export class StubIdentity extends AwsIdentity {
  verifyCalls: ConnectionTarget[] = [];
  issued: Array<{ roleArn: string; sessionName: string }> = [];
  account = '123456789012';
  failVerify: XeroError | undefined;
  constructor() {
    super({ providerFactory: () => async () => ({ accessKeyId: 'CONTROLLERKEYNEVERINJECTED', secretAccessKey: 'controller-secret-never-injected' }) });
  }
  override async verify(target: ConnectionTarget): Promise<VerifiedIdentity> {
    this.verifyCalls.push(target);
    if (this.failVerify) throw this.failVerify;
    return { accountId: this.account, arn: `arn:aws:iam::${this.account}:user/dev`, userId: 'AIDA', warnings: [] };
  }
  override async issue(r: { roleArn: string; sessionName: string; durationSec: number; region: string }): Promise<IssuedCredentials> {
    this.issued.push(r);
    return { accessKeyId: 'ASIATEMPEXAMPLE0001', secretAccessKey: 'temp-secret-value-123', sessionToken: 'temp-session-token-value-456', expiresAt: Date.now() + 3600_000 };
  }
}

export class StubLambda implements LambdaInvoker {
  calls: LambdaInvokeRequest[] = [];
  describeCalls: string[] = [];
  observed: ObservedLambdaConfig = { runtime: 'nodejs22.x', handler: 'index.handler', timeoutSec: 10, memoryMb: 128, codeSha256: 'sha', version: '3', lastModified: 'x' };
  offline = false;
  response: (r: LambdaInvokeRequest) => LambdaInvokeResult = (r) => ({ statusCode: r.invocationType === 'Event' ? 202 : 200, functionError: undefined, executedVersion: '3', awsRequestId: 'aws-req-42', payload: new TextEncoder().encode('{"source":"native-lambda"}') });
  async invoke(r: LambdaInvokeRequest): Promise<LambdaInvokeResult> {
    if (this.offline) throw new XeroError('AWS_REQUEST_FAILED', 'AWS unreachable');
    this.calls.push(r);
    return this.response(r);
  }
  async describe(arn: string): Promise<ObservedLambdaConfig> {
    if (this.offline) throw new XeroError('AWS_REQUEST_FAILED', 'AWS unreachable');
    this.describeCalls.push(arn);
    return this.observed;
  }
}

export interface Env {
  controller: Controller;
  client: XeroClient;
  backend: FakeExecutionBackend;
  identity: StubIdentity;
  lambda: StubLambda;
  home: string;
  work: string;
  sqs: Map<string, SqsPort>;
  /** Creates a function source directory containing the given files. */
  source(files: Record<string, string>): string;
  restart(): Promise<void>;
  close(): Promise<void>;
}

export async function createEnv(opts: { home?: string; config?: Record<string, unknown>; sqs?: Map<string, SqsPort> } = {}): Promise<Env> {
  const work = mkdtempSync(join(tmpdir(), 'xero-it-'));
  const home = opts.home ?? join(work, 'home');
  const backend = new FakeExecutionBackend();
  const identity = new StubIdentity();
  const lambda = new StubLambda();
  const sqs = opts.sqs ?? new Map<string, SqsPort>();
  const env = {} as Env;
  const boot = async (): Promise<void> => {
    const controller = await createController(
      { config: { home, port: 0, ...opts.config }, backend, identity, lambdaInvoker: lambda, logger: silentLogger, sqsPortFactory: (s: EventSource) => sqs.get(s.queueUrl)! },
      {},
    );
    env.controller = controller;
    env.client = new XeroClient({ baseUrl: controller.url, token: controller.token });
  };
  await boot();
  let n = 0;
  Object.assign(env, {
    backend, identity, lambda, home, work, sqs,
    source(files: Record<string, string>): string {
      const dir = join(work, `src-${++n}`);
      mkdirSync(dir, { recursive: true });
      for (const [name, content] of Object.entries(files)) {
        mkdirSync(join(dir, name, '..'), { recursive: true });
        writeFileSync(join(dir, name), content);
      }
      return dir;
    },
    async restart() {
      await env.controller.close();
      await boot();
    },
    async close() {
      await env.controller.close();
      forceRemove(work);
    },
  });
  return env;
}

export async function waitFor<T>(fn: () => T | Promise<T>, pred: (v: T) => boolean, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (pred(v)) return v;
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}
