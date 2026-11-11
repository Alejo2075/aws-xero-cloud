import { afterEach, describe, expect, it } from 'vitest';
import { createEnv, type Env } from './harness.js';

let env: Env | undefined;
afterEach(async () => { await env?.close(); env = undefined; });

describe('controller restart', () => {
  it('keeps functions, deployments, routing, AWS connection and invocation history', async () => {
    env = await createEnv();
    const src = env.source({ 'index.js': 'exports.handler = async (e) => e;' });
    await env.client.deployLocal('persist', { runtime: 'nodejs22.x', handler: 'index.handler', sourcePath: src, timeoutSec: 9 });
    await env.client.connectAws({ profile: 'development', region: 'us-east-1' });
    await env.client.bindAwsLambda('persist', { arn: 'arn:aws:lambda:us-east-1:123456789012:function:persist:live', defaultTarget: 'aws-lambda' });
    await env.client.invoke('persist', {}, { target: 'local' });
    const token = env.controller.token;

    await env.restart();

    expect(env.controller.token).toBe(token); // API token is stable across restarts
    const inspect = await env.client.inspect('persist');
    expect(inspect.function.routing.defaultTarget).toBe('aws-lambda');
    expect(inspect.function.deployments.local).toMatchObject({ version: 1, details: { timeoutSec: 9 } });
    expect(inspect.function.deployments['aws-lambda']).toMatchObject({ details: { arn: 'arn:aws:lambda:us-east-1:123456789012:function:persist:live', verified: true } });
    expect(inspect.recentInvocations).toHaveLength(1);
    expect((await env.client.awsStatus()).connection).toMatchObject({ region: 'us-east-1', profile: 'development' });

    // The immutable artifact is still usable after the restart.
    const res = await env.client.invoke('persist', { again: true }, { target: 'local' });
    expect(res.status).toBe('succeeded');
    expect(res.coldStart).toBe(true); // workers do not survive a restart
  });

  it('reaps workers orphaned by a previous run', async () => {
    env = await createEnv();
    const ghost = await env.backend.startWorker({ workerId: 'ghost', functionId: 'f', deploymentId: 'd', functionName: 'g', image: 'i', command: ['h'], artifactPath: '/x', memoryMb: 128, timeoutSec: 1, environment: {} });
    expect(env.backend.alive.has(ghost.backendId)).toBe(true);
    await env.restart();
    expect(env.backend.alive.has(ghost.backendId)).toBe(false);
  });
});
