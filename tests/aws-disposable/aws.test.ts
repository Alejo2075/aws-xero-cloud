import { SQSClient, SendMessageCommand, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeExecutionBackend } from '@xero/execution';
import { createController, type Controller } from '@xero/controller';
import { XeroClient } from '@xero/sdk';
import { silentLogger } from '@xero/telemetry';
import { forceRemove } from '../integration/harness.js';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const enabled = process.env.XERO_AWS_DISPOSABLE === '1';
const e = process.env;
const profile = e.XERO_TEST_AWS_PROFILE;
const region = e.XERO_TEST_AWS_REGION;
const account = e.XERO_TEST_ACCOUNT_ID;
const lambdaArn = e.XERO_TEST_LAMBDA_ARN;
const roleArn = e.XERO_TEST_ROLE_ARN;
const queueUrl = e.XERO_TEST_QUEUE_URL;
const configured = enabled && Boolean(profile && region && account);

// Local workers are faked: this suite verifies the *AWS* edges (STS, Lambda Invoke, SQS), not Docker.
describe.skipIf(!configured)('REAL AWS (disposable account) — opt-in', () => {
  let c: Controller;
  let client: XeroClient;
  let home: string;
  const backend = new FakeExecutionBackend();

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'xero-aws-'));
    c = await createController({ config: { home, port: 0 }, backend, logger: silentLogger }, {});
    client = new XeroClient({ baseUrl: c.url, token: c.token });
    const r = await client.connectAws({ profile: profile!, region: region! });
    if (r.connection.accountId !== account) {
      await c.close();
      throw new Error(`ABORT: connected to account ${r.connection.accountId}, expected the disposable account ${account}`);
    }
  }, 60_000);
  afterAll(async () => {
    await c?.close();
    if (home) forceRemove(home);
  });

  it('identity: connect verified the account via sts:GetCallerIdentity', async () => {
    expect(await client.awsStatus()).toMatchObject({ connected: true, valid: true });
  });

  it.skipIf(!lambdaArn)('binds and invokes an EXISTING native Lambda with the real Invoke API', async () => {
    const bound = await client.bindAwsLambda('aws-echo', { arn: lambdaArn! });
    expect(bound.function.deployments['aws-lambda']!.details.verified).toBe(true);
    const r = await client.invoke<{ ping: string }>('aws-echo', { ping: 'pong' });
    expect(r).toMatchObject({ status: 'succeeded', target: 'aws-lambda', payload: { ping: 'pong' } });
    expect(r.awsRequestId).toBeTruthy();
    const async = await client.invoke('aws-echo', { ping: 'async' }, { type: 'Event' });
    expect(async.status).toBe('accepted');
  }, 60_000);

  it.skipIf(!roleArn)('issues temporary credentials for an existing role (never the controller identity)', async () => {
    const dir = join(home, 'fn');
    mkdirSync(dir);
    writeFileSync(join(dir, 'index.js'), 'x');
    await client.deployLocal('with-role', { runtime: 'nodejs22.x', handler: 'index.handler', sourcePath: dir, awsRoleArn: roleArn! });
    await client.invoke('with-role', {});
    const env = backend.started.at(-1)!.environment;
    expect(env.AWS_ACCESS_KEY_ID).toMatch(/^ASIA/); // STS temporary key id, not a long-lived AKIA key
    expect(env.AWS_SESSION_TOKEN).toBeTruthy();
    const check = await fromNodeProviderChain({ profile: profile! })();
    expect(env.AWS_ACCESS_KEY_ID).not.toBe(check.accessKeyId);
  }, 60_000);

  it.skipIf(!queueUrl)('consumes a real SQS message, then deletes it only after the handler succeeded', async () => {
    const dir = join(home, 'q');
    mkdirSync(dir);
    writeFileSync(join(dir, 'index.js'), 'x');
    await client.deployLocal('queue-fn', { runtime: 'nodejs22.x', handler: 'index.handler', sourcePath: dir });
    const seen: string[] = [];
    backend.handler = (_s, r) => { seen.push(new TextDecoder().decode(r.payload)); return { outcome: 'ok', payload: new TextEncoder().encode('null') }; };
    await client.attachEventSource({ functionName: 'queue-fn', source: 'sqs', queueUrl: queueUrl! });
    const sqs = new SQSClient({ region: region!, credentials: fromNodeProviderChain({ profile: profile! }) });
    const marker = `xero-test-${Date.now()}`;
    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl!, MessageBody: JSON.stringify({ marker }) }));
    const end = Date.now() + 45_000;
    while (!seen.some((s) => s.includes(marker)) && Date.now() < end) await new Promise((r) => setTimeout(r, 500));
    expect(seen.some((s) => s.includes(marker))).toBe(true);
    await new Promise((r) => setTimeout(r, 3000)); // allow the delete to land
    const attrs = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl!, AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] }));
    expect(Number(attrs.Attributes?.ApproximateNumberOfMessages ?? 0) + Number(attrs.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0)).toBe(0); // cleanup check
  }, 90_000);
});
