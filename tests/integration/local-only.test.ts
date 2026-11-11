import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEnv, type Env } from './harness.js';

let env: Env;
beforeEach(async () => {
  for (const k of Object.keys(process.env)) if (k.startsWith('AWS_')) delete process.env[k];
  env = await createEnv();
});
afterEach(async () => { await env.close(); });

describe('local-only usage needs no AWS', () => {
  it('deploys and invokes with no AWS connection, credentials or network', async () => {
    env.lambda.offline = true;
    env.identity.failVerify = undefined;
    await env.client.deployLocal('offline', { runtime: 'nodejs22.x', handler: 'index.handler', sourcePath: env.source({ 'index.js': 'x' }) });
    const r = await env.client.invoke('offline', { n: 1 });
    expect(r).toMatchObject({ status: 'succeeded', target: 'local' });
    expect(env.identity.verifyCalls).toHaveLength(0); // never contacted STS
    expect(env.lambda.calls).toHaveLength(0);
    const spec = env.backend.started[0]!;
    expect(Object.keys(spec.environment).filter((k) => k.startsWith('AWS_'))).toEqual([]); // not even a region
    expect(await env.client.awsStatus()).toEqual({ connected: false });
  });

  it('local functions keep working when AWS becomes unreachable, even after connecting', async () => {
    await env.client.deployLocal('resilient', { runtime: 'nodejs22.x', handler: 'index.handler', sourcePath: env.source({ 'index.js': 'x' }) });
    await env.client.connectAws({ region: 'us-east-1' });
    await env.client.bindAwsLambda('resilient', { arn: 'arn:aws:lambda:us-east-1:123456789012:function:resilient:live' });
    env.lambda.offline = true; // simulated AWS outage
    env.identity.failVerify = new (await import('@xero/core')).XeroError('AWS_REQUEST_FAILED', 'down');
    await expect(env.client.invoke('resilient', {}, { target: 'aws-lambda' })).rejects.toMatchObject({ code: 'AWS_REQUEST_FAILED' });
    await expect(env.client.invoke('resilient', {}, { target: 'local' })).resolves.toMatchObject({ status: 'succeeded' });
    expect((await env.client.awsStatus())).toMatchObject({ connected: true, valid: false });
  });

  it('a function that names an IAM role fails clearly (and only it) without a connection', async () => {
    await env.client.deployLocal('needs-role', { runtime: 'nodejs22.x', handler: 'index.handler', sourcePath: env.source({ 'index.js': 'x' }), awsRoleArn: 'arn:aws:iam::123456789012:role/xero-needs-role' });
    await env.client.deployLocal('plain', { runtime: 'nodejs22.x', handler: 'index.handler', sourcePath: env.source({ 'index.js': 'y' }) });
    await expect(env.client.invoke('needs-role', {})).rejects.toMatchObject({ code: 'AWS_NOT_CONNECTED' });
    await expect(env.client.invoke('plain', {})).resolves.toMatchObject({ status: 'succeeded' });
  });
});
