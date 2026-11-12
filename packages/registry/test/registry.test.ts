import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { XeroError, type LocalConfig, type AwsLambdaConfig, type InvocationRecord } from '@xero/core';
import { SqliteRegistry } from '../src/index.js';

const local = (artifactId: string): LocalConfig => ({ artifactId, runtime: 'nodejs22.x', handler: 'index.handler', memoryMb: 128, timeoutSec: 3, maxConcurrency: 2, idleTtlSec: 60, environment: {}, awsRoleArn: undefined });
const lambda: AwsLambdaConfig = { mode: 'existing', arn: 'arn:aws:lambda:us-east-1:123456789012:function:h:live', region: 'us-east-1', accountId: '123456789012', functionName: 'h', qualifier: 'live', verified: false, verifiedAt: undefined, observed: undefined };
const routing = { strategy: 'manual', defaultTarget: 'local' } as const;

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('SqliteRegistry', () => {
  it('stores one logical function with independent local and aws-lambda deployments', () => {
    const r = new SqliteRegistry(':memory:');
    const fn = r.createFunction({ name: 'hello', description: undefined, routing });
    const a = r.addDeployment(fn.id, { target: 'local', config: local('sha256:a') });
    const b = r.addDeployment(fn.id, { target: 'aws-lambda', config: lambda });
    expect(a.version).toBe(1);
    expect(b.version).toBe(1);
    expect(r.getActiveDeployment(fn.id, 'local')?.id).toBe(a.id);
    expect(r.getActiveDeployment(fn.id, 'aws-lambda')?.id).toBe(b.id);
    expect(fn.id).not.toContain(lambda.arn);
  });

  it('supersedes previous active deployment and increments version per target', () => {
    const r = new SqliteRegistry(':memory:');
    const fn = r.createFunction({ name: 'f', description: 'd', routing });
    const v1 = r.addDeployment(fn.id, { target: 'local', config: local('sha256:a') });
    const v2 = r.addDeployment(fn.id, { target: 'local', config: local('sha256:b') });
    expect(v2.version).toBe(2);
    expect(r.getDeploymentById(v1.id)?.status).toBe('superseded');
    expect(r.getActiveDeployment(fn.id, 'local')?.id).toBe(v2.id);
    expect(r.isArtifactReferenced('sha256:a')).toBe(true);
    r.removeDeployment(fn.id, 'local');
    expect(r.isArtifactReferenced('sha256:a')).toBe(false);
    expect(() => r.removeDeployment(fn.id, 'local')).toThrow(XeroError);
  });

  it('rejects duplicate names with a stable code', () => {
    const r = new SqliteRegistry(':memory:');
    r.createFunction({ name: 'x', description: undefined, routing });
    expect(() => r.createFunction({ name: 'x', description: undefined, routing })).toThrowError(expect.objectContaining({ code: 'FUNCTION_EXISTS' }));
  });

  it('survives restart (metadata is persisted)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xero-reg-')); dirs.push(dir);
    const path = join(dir, 'x.db');
    const r1 = new SqliteRegistry(path);
    const fn = r1.createFunction({ name: 'persist', description: undefined, routing: { strategy: 'manual', defaultTarget: 'aws-lambda' } });
    r1.addDeployment(fn.id, { target: 'local', config: local('sha256:z') });
    r1.setAwsConnection({ profile: 'p', region: 'us-east-1', accountId: '123456789012', principalArn: 'arn:aws:iam::123456789012:user/u', verifiedAt: 1 });
    r1.close();
    const r2 = new SqliteRegistry(path);
    expect(r2.getFunctionByName('persist')?.routing.defaultTarget).toBe('aws-lambda');
    expect(r2.getActiveDeployment(fn.id, 'local')?.config).toMatchObject({ artifactId: 'sha256:z' });
    expect(r2.getAwsConnection()?.region).toBe('us-east-1');
    expect(r2.schemaVersion).toBe(2);
  });

  it('refuses a database from a newer schema', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xero-reg-')); dirs.push(dir);
    const path = join(dir, 'x.db');
    new SqliteRegistry(path, { migrations: [{ version: 1, name: 'a', sql: 'CREATE TABLE a (x INTEGER);' }, { version: 2, name: 'b', sql: 'CREATE TABLE b (x INTEGER);' }] }).close();
    expect(() => new SqliteRegistry(path, { migrations: [{ version: 1, name: 'a', sql: 'CREATE TABLE a (x INTEGER);' }] })).toThrowError(expect.objectContaining({ code: 'STATE_INCOMPATIBLE' }));
  });

  it('records invocations (no payloads) and trims history', () => {
    const r = new SqliteRegistry(':memory:', { maxInvocations: 2 });
    const fn = r.createFunction({ name: 'f', description: undefined, routing });
    const base: InvocationRecord = { requestId: 'r', attemptId: 'a', functionId: fn.id, functionName: 'f', deploymentId: undefined, target: 'local', invocationType: 'RequestResponse', source: 'api', status: 'succeeded', errorCode: undefined, coldStart: true, awsRequestId: undefined, startedAt: 1, durationMs: 5, payloadBytes: 2, responseBytes: 3, traceId: undefined };
    for (let i = 0; i < 4; i++) r.recordInvocation({ ...base, attemptId: `a${i}`, startedAt: i });
    const list = r.listInvocations(fn.id, 10);
    expect(list.map((x) => x.attemptId)).toEqual(['a3', 'a2']);
    expect(list[0]?.coldStart).toBe(true);
  });

  it('keeps bounded logs and cascades on function delete', () => {
    const r = new SqliteRegistry(':memory:', { maxLogLines: 3 });
    const fn = r.createFunction({ name: 'f', description: undefined, routing });
    const dep = r.addDeployment(fn.id, { target: 'local', config: local('sha256:a') });
    r.appendLogs(Array.from({ length: 6 }, (_, i) => ({ functionId: fn.id, deploymentId: dep.id, requestId: 'r', stream: 'stdout' as const, at: i, message: `m${i}` })));
    expect(r.readLogs(fn.id, { limit: 100 }).map((l) => l.message)).toEqual(['m3', 'm4', 'm5']);
    expect(r.deleteFunction(fn.id).artifactIds).toEqual(['sha256:a']);
    expect(r.readLogs(fn.id, { limit: 10 })).toEqual([]);
    expect(r.getDeploymentById(dep.id)).toBeUndefined();
  });

  it('manages event sources', () => {
    const r = new SqliteRegistry(':memory:');
    const fn = r.createFunction({ name: 'f', description: undefined, routing });
    const s = { id: 'es_1', functionId: fn.id, kind: 'sqs' as const, target: 'local' as const, queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/q', region: 'us-east-1', batchSize: 10, maxInFlight: 1, visibilityExtensionSec: 0, createdAt: 1 };
    r.saveEventSource(s);
    expect(() => r.saveEventSource({ ...s, id: 'es_2' })).toThrowError(expect.objectContaining({ code: 'EVENT_SOURCE_INVALID' }));
    expect(r.listEventSources(fn.id)).toHaveLength(1);
    expect(r.deleteEventSource('es_1')).toBe(true);
  });

  it('creates consistent online backups that open as a registry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xero-reg-')); dirs.push(dir);
    const r = new SqliteRegistry(join(dir, 'live.db'));
    const fn = r.createFunction({ name: 'snap', description: undefined, routing });
    r.addDeployment(fn.id, { target: 'local', config: local('sha256:s') });
    const dest = join(dir, "it's here", 'b.db'); // quote in path must not break the statement
    r.backupTo(dest);
    expect(() => r.backupTo(dest)).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    r.createFunction({ name: 'later', description: undefined, routing });
    const b = new SqliteRegistry(dest);
    expect(b.listFunctions().map((f) => f.name)).toEqual(['snap']); // snapshot is point-in-time
    b.close();
    r.close();
  });
});
