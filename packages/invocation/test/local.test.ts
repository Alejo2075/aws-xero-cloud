import { describe, expect, it } from 'vitest';
import { XeroError, type CredentialIssuer } from '@xero/core';
import { enc, harness, localConfig } from './harness.js';

const routing = { strategy: 'manual', defaultTarget: 'local' } as const;
const connect = (h: ReturnType<typeof harness>) => h.registry.setAwsConnection({ profile: 'p', region: 'eu-west-1', accountId: '123456789012', principalArn: 'arn:aws:iam::123456789012:user/u', verifiedAt: 1 });
function deploy(h: ReturnType<typeof harness>, over = {}) {
  const fn = h.registry.createFunction({ name: 'f', description: undefined, routing });
  const dep = h.registry.addDeployment(fn.id, { target: 'local', config: localConfig(over) });
  return { fn, dep };
}

describe('LocalTargetExecutor', () => {
  it('cold start then warm reuse; reports coldStart on the result and metrics', async () => {
    const h = harness();
    deploy(h);
    const a = await h.router.invoke({ functionName: 'f', payload: enc({}) });
    const b = await h.router.invoke({ functionName: 'f', payload: enc({}) });
    expect([a.coldStart, b.coldStart]).toEqual([true, false]);
    expect(h.backend.started).toHaveLength(1);
    expect(h.metrics.counter('cold_starts_total')).toBe(1);
    expect(h.metrics.counter('warm_hits_total')).toBe(1);
  });

  it('builds a hardened worker spec from the deployment', async () => {
    const h = harness();
    deploy(h, { memoryMb: 512, timeoutSec: 7, environment: { TABLE: 'orders' } });
    await h.router.invoke({ functionName: 'f', payload: enc({}) });
    const spec = h.backend.started[0]!;
    expect(spec).toMatchObject({ image: 'img-nodejs22.x', command: ['index.handler'], memoryMb: 512, timeoutSec: 7, functionName: 'f' });
    expect(spec.artifactPath).toBe('/store/aaaaaaaa');
    expect(spec.environment).toEqual({ TABLE: 'orders' }); // not connected: no AWS variables at all
  });

  it('timeout fences the worker, is reported as timeout and the worker is not reused', async () => {
    const h = harness();
    const { fn } = deploy(h, { timeoutSec: 1 });
    h.backend.handler = () => new Promise(() => undefined);
    await expect(h.router.invoke({ functionName: 'f', payload: enc({}) })).rejects.toMatchObject({ code: 'INVOCATION_TIMEOUT' });
    expect(h.registry.listInvocations(fn.id, 1)[0]!.status).toBe('timeout');
    expect(h.backend.alive.size).toBe(0);
    expect(h.pool.stats().total).toBe(0);
    expect(h.scheduler.stats().running).toBe(0);
    h.backend.handler = (_s, r) => ({ outcome: 'ok', payload: r.payload });
    expect((await h.router.invoke({ functionName: 'f', payload: enc({}) })).coldStart).toBe(true);
  }, 10_000);

  it('worker crash does not break other functions or leak leases', async () => {
    const h = harness();
    deploy(h);
    h.backend.handler = () => { throw new XeroError('WORKER_CRASHED', 'boom'); };
    await expect(h.router.invoke({ functionName: 'f', payload: enc({}) })).rejects.toMatchObject({ code: 'WORKER_CRASHED' });
    expect(h.scheduler.stats().running).toBe(0);
    expect(h.pool.stats().total).toBe(0);
    h.backend.handler = (_s, r) => ({ outcome: 'ok', payload: r.payload });
    await expect(h.router.invoke({ functionName: 'f', payload: enc({}) })).resolves.toMatchObject({ status: 'succeeded' });
  });

  it('bounds concurrency per function, queues, then rejects with CAPACITY_EXHAUSTED', async () => {
    const h = harness({ queueLimit: 1 });
    deploy(h, { maxConcurrency: 1, timeoutSec: 5 });
    const releases: Array<() => void> = [];
    h.backend.handler = () => new Promise((r) => releases.push(() => r({ outcome: 'ok', payload: enc({}) })));
    const first = h.router.invoke({ functionName: 'f', payload: enc({}) });
    await new Promise((r) => setTimeout(r, 20));
    const second = h.router.invoke({ functionName: 'f', payload: enc({}) });
    await new Promise((r) => setTimeout(r, 20));
    await expect(h.router.invoke({ functionName: 'f', payload: enc({}) })).rejects.toMatchObject({ code: 'CAPACITY_EXHAUSTED' });
    expect(h.metrics.counter('capacity_rejections_total')).toBe(1);
    expect(h.backend.started).toHaveLength(1);
    releases[0]!();
    await first;
    await new Promise((r) => setTimeout(r, 20));
    releases[1]!();
    await expect(second).resolves.toMatchObject({ status: 'succeeded' });
    expect(h.backend.started).toHaveLength(1); // the warm worker served the queued request
  });

  describe('AWS credentials boundary', () => {
    const issuer: CredentialIssuer & { calls: unknown[] } = {
      calls: [],
      async issue(r) {
        this.calls.push(r);
        return { accessKeyId: 'ASIAEXAMPLEEXAMPLE', secretAccessKey: 'secretsecretsecret', sessionToken: 'tokentokentoken', expiresAt: Date.now() + 3600_000 };
      },
    };

    it('injects temporary role credentials only when the deployment names a role', async () => {
      const h = harness({ issuer });
      connect(h);
      deploy(h, { awsRoleArn: 'arn:aws:iam::123456789012:role/xero-f' });
      await h.router.invoke({ functionName: 'f', payload: enc({}) });
      const env = h.backend.started[0]!.environment;
      expect(env).toMatchObject({ AWS_ACCESS_KEY_ID: 'ASIAEXAMPLEEXAMPLE', AWS_SESSION_TOKEN: 'tokentokentoken', AWS_REGION: 'eu-west-1' });
      expect(issuer.calls[0]).toMatchObject({ roleArn: 'arn:aws:iam::123456789012:role/xero-f', region: 'eu-west-1', durationSec: 3600 });
      expect(h.secrets).toEqual(['ASIAEXAMPLEEXAMPLE', 'secretsecretsecret', 'tokentokentoken']); // registered for log redaction
    });

    it('gives no credentials to functions without a role, even when AWS is connected', async () => {
      const h = harness({ issuer });
      connect(h);
      deploy(h);
      await h.router.invoke({ functionName: 'f', payload: enc({}) });
      const env = h.backend.started[0]!.environment;
      expect(Object.keys(env).filter((k) => /KEY|TOKEN|SECRET/.test(k))).toEqual([]);
      expect(env.AWS_REGION).toBe('eu-west-1');
    });

    it('fails clearly when a role is configured but AWS is not connected', async () => {
      const h = harness({ issuer });
      deploy(h, { awsRoleArn: 'arn:aws:iam::123456789012:role/xero-f' });
      await expect(h.router.invoke({ functionName: 'f', payload: enc({}) })).rejects.toMatchObject({ code: 'AWS_NOT_CONNECTED' });
      expect(h.backend.started).toHaveLength(0);
    });

    it('recycles the worker before credentials expire', async () => {
      let now = Date.now();
      const short: CredentialIssuer = { issue: async () => ({ accessKeyId: 'ASIAEXAMPLEEXAMPLE', secretAccessKey: 'secretsecretsecret', sessionToken: 'tokentokentoken', expiresAt: now + 3600_000 }) };
      const h = harness({ issuer: short });
      connect(h);
      deploy(h, { awsRoleArn: 'arn:aws:iam::123456789012:role/xero-f' });
      await h.router.invoke({ functionName: 'f', payload: enc({}) });
      expect(h.backend.started).toHaveLength(1);
      // The pool uses the real clock: age the pooled worker's credentials instead of faking time.
      for (const w of h.pool.list()) w.credentialsExpireAt = now + 60_000;
      now += 0;
      const again = await h.router.invoke({ functionName: 'f', payload: enc({}) });
      expect(again.coldStart).toBe(true);
      expect(h.backend.started).toHaveLength(2);
    });
  });

  it('local functions keep working when the AWS control plane is unreachable', async () => {
    const h = harness();
    deploy(h);
    h.lambda.behavior = () => { throw new XeroError('AWS_REQUEST_FAILED', 'network down'); };
    await expect(h.router.invoke({ functionName: 'f', payload: enc({}) })).resolves.toMatchObject({ status: 'succeeded', target: 'local' });
  });
});
