import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { XeroError } from '@xero/core';
import { createEnv, waitFor, type Env } from './harness.js';

let env: Env;
beforeEach(async () => { env = await createEnv(); });
afterEach(async () => { await env.close(); });
const src = () => env.source({ 'index.js': 'x' });

describe('xero aws connect', () => {
  it('verifies the selected profile/region and stores only the non-secret identity', async () => {
    const r = await env.client.connectAws({ profile: 'development', region: 'us-east-1' });
    expect(r.connection).toMatchObject({ profile: 'development', region: 'us-east-1', accountId: '123456789012', principalArn: 'arn:aws:iam::123456789012:user/dev' });
    expect(env.identity.verifyCalls).toEqual([{ profile: 'development', region: 'us-east-1' }]);
    const status = await env.client.awsStatus();
    expect(status).toMatchObject({ connected: true, valid: true });
    expect(JSON.stringify(status)).not.toContain('secret');
  });

  it('reports verification failures with stable codes and does not store the connection', async () => {
    env.identity.failVerify = new XeroError('AWS_CREDENTIALS_ERROR', 'expired');
    await expect(env.client.connectAws({ region: 'us-east-1' })).rejects.toMatchObject({ code: 'AWS_CREDENTIALS_ERROR' });
    expect((await env.client.awsStatus()).connected).toBe(false);
    await expect(env.client.connectAws({ region: 'not a region' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('disconnect removes the connection', async () => {
    await env.client.connectAws({ region: 'us-east-1' });
    await env.client.disconnectAws();
    expect((await env.client.awsStatus()).connected).toBe(false);
  });
});

describe('Mode A — local handler gets scoped temporary credentials', () => {
  it('assumes the function role (never the controller identity) and injects only temporary credentials', async () => {
    await env.client.connectAws({ profile: 'development', region: 'eu-west-1' });
    await env.client.deployLocal('orders', { runtime: 'nodejs22.x', handler: 'index.handler', sourcePath: src(), environment: { TABLE_NAME: 'orders' }, awsRoleArn: 'arn:aws:iam::123456789012:role/xero-orders' });
    await env.client.invoke('orders', {});
    expect(env.identity.issued).toEqual([{ roleArn: 'arn:aws:iam::123456789012:role/xero-orders', sessionName: 'xero-orders', durationSec: 3600, region: 'eu-west-1' }]);
    const e = env.backend.started[0]!.environment;
    expect(e).toMatchObject({ AWS_ACCESS_KEY_ID: 'ASIATEMPEXAMPLE0001', AWS_SESSION_TOKEN: 'temp-session-token-value-456', AWS_REGION: 'eu-west-1', TABLE_NAME: 'orders' });
    expect(JSON.stringify(e)).not.toContain('CONTROLLERKEY');
    expect(JSON.stringify(e)).not.toContain('controller-secret');
  });

  it('redacts injected credentials from stored function logs', async () => {
    await env.client.connectAws({ region: 'us-east-1' });
    await env.client.deployLocal('leaky', { runtime: 'nodejs22.x', handler: 'index.handler', sourcePath: src(), awsRoleArn: 'arn:aws:iam::123456789012:role/xero-leaky' });
    await env.client.invoke('leaky', {});
    const id = [...env.backend.alive.keys()][0]!;
    env.backend.emitLog(id, 'stdout', 'token is temp-session-token-value-456 and key ASIATEMPEXAMPLE0001');
    const logs = await waitFor(() => env.client.logs('leaky'), (l) => l.length > 0);
    expect(logs[0]!.message).toBe('token is [REDACTED] and key [REDACTED]');
  });

  it('does not issue credentials for functions without a role', async () => {
    await env.client.connectAws({ region: 'us-east-1' });
    await env.client.deployLocal('norole', { runtime: 'nodejs22.x', handler: 'index.handler', sourcePath: src() });
    await env.client.invoke('norole', {});
    expect(env.identity.issued).toEqual([]);
  });
});
