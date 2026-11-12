import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  XeroError,
  type AwsConnection,
  type Deployment,
  type EventSource,
  type FunctionRegistry,
  type InvocationRecord,
  type LogLine,
  type LogicalFunction,
  type NewDeployment,
  type ApiToken,
  type TokenScope,
  type TokenStore,
} from '@xero/core';
import { systemClock, newId, type Clock, type IdGenerator } from '@xero/shared';
import type { Routing, Target } from '@xero/specification';
import { MIGRATIONS, type Migration } from './migrations.js';

export interface RegistryOptions {
  clock?: Clock;
  ids?: IdGenerator;
  /** Max log lines retained per function. */
  maxLogLines?: number;
  /** Max invocation records retained per function. */
  maxInvocations?: number;
  migrations?: readonly Migration[];
}

type Row = Record<string, SQLInputValue | null | undefined> & Record<string, unknown>;
const str = (v: unknown): string => String(v);
const optStr = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : String(v));
const num = (v: unknown): number => Number(v);

export class SqliteRegistry implements FunctionRegistry, TokenStore {
  private readonly db: DatabaseSync;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly maxLogLines: number;
  private readonly maxInvocations: number;

  constructor(path: string, options: RegistryOptions = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.clock = options.clock ?? systemClock;
    this.ids = options.ids ?? newId;
    this.maxLogLines = options.maxLogLines ?? 5000;
    this.maxInvocations = options.maxInvocations ?? 2000;
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate(options.migrations ?? MIGRATIONS);
  }

  close(): void {
    this.db.close();
  }

  /** Consistent online snapshot (`VACUUM INTO`). The destination must not exist. */
  backupTo(destination: string): void {
    if (existsSync(destination)) throw new XeroError('INVALID_REQUEST', 'backup destination already exists');
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    this.db.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`);
    chmodSync(destination, 0o600);
  }

  get schemaVersion(): number {
    return num((this.db.prepare('SELECT COALESCE(MAX(version),0) AS v FROM schema_migrations').get() as Row).v);
  }

  private migrate(migrations: readonly Migration[]): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT;');
    const current = this.schemaVersion;
    const latest = migrations.reduce((m, x) => Math.max(m, x.version), 0);
    if (current > latest) {
      throw new XeroError('STATE_INCOMPATIBLE', `database schema v${current} is newer than this Xero build understands (v${latest})`);
    }
    for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
      if (m.version <= current) continue;
      this.tx(() => {
        this.db.exec(m.sql);
        this.db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?,?,?)').run(m.version, m.name, this.clock.now());
      });
    }
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ---- functions ----
  private toFunction(r: Row): LogicalFunction {
    return {
      id: str(r.id),
      name: str(r.name),
      description: optStr(r.description),
      routing: JSON.parse(str(r.routing_json)) as Routing,
      createdAt: num(r.created_at),
      updatedAt: num(r.updated_at),
    };
  }

  createFunction(input: { name: string; description: string | undefined; routing: Routing }): LogicalFunction {
    const now = this.clock.now();
    const id = this.ids('fn');
    try {
      this.db
        .prepare('INSERT INTO functions (id,name,description,routing_json,created_at,updated_at) VALUES (?,?,?,?,?,?)')
        .run(id, input.name, input.description ?? null, JSON.stringify(input.routing), now, now);
    } catch (e) {
      if (String((e as Error).message).includes('UNIQUE')) throw new XeroError('FUNCTION_EXISTS', `function "${input.name}" already exists`);
      throw e;
    }
    return { id, name: input.name, description: input.description, routing: input.routing, createdAt: now, updatedAt: now };
  }

  getFunctionByName(name: string): LogicalFunction | undefined {
    const r = this.db.prepare('SELECT * FROM functions WHERE name = ?').get(name) as Row | undefined;
    return r ? this.toFunction(r) : undefined;
  }
  getFunctionById(id: string): LogicalFunction | undefined {
    const r = this.db.prepare('SELECT * FROM functions WHERE id = ?').get(id) as Row | undefined;
    return r ? this.toFunction(r) : undefined;
  }
  listFunctions(): LogicalFunction[] {
    return (this.db.prepare('SELECT * FROM functions ORDER BY name').all() as Row[]).map((r) => this.toFunction(r));
  }
  updateRouting(functionId: string, routing: Routing): LogicalFunction {
    const now = this.clock.now();
    const res = this.db.prepare('UPDATE functions SET routing_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(routing), now, functionId);
    if (res.changes === 0) throw new XeroError('FUNCTION_NOT_FOUND', 'function not found');
    return this.getFunctionById(functionId)!;
  }
  deleteFunction(functionId: string): { artifactIds: string[] } {
    return this.tx(() => {
      const artifactIds = (this.db.prepare('SELECT DISTINCT artifact_id FROM deployments WHERE function_id = ? AND artifact_id IS NOT NULL').all(functionId) as Row[]).map((r) => str(r.artifact_id));
      const res = this.db.prepare('DELETE FROM functions WHERE id = ?').run(functionId);
      if (res.changes === 0) throw new XeroError('FUNCTION_NOT_FOUND', 'function not found');
      return { artifactIds };
    });
  }

  // ---- deployments ----
  private toDeployment(r: Row): Deployment {
    return {
      id: str(r.id),
      functionId: str(r.function_id),
      target: str(r.target),
      version: num(r.version),
      status: str(r.status),
      createdAt: num(r.created_at),
      config: JSON.parse(str(r.config_json)),
    } as Deployment;
  }

  addDeployment(functionId: string, input: NewDeployment): Deployment {
    return this.tx(() => {
      if (!this.getFunctionById(functionId)) throw new XeroError('FUNCTION_NOT_FOUND', 'function not found');
      const max = num((this.db.prepare('SELECT COALESCE(MAX(version),0) AS v FROM deployments WHERE function_id = ? AND target = ?').get(functionId, input.target) as Row).v);
      this.db.prepare("UPDATE deployments SET status = 'superseded' WHERE function_id = ? AND target = ? AND status = 'active'").run(functionId, input.target);
      const id = this.ids('dep');
      const now = this.clock.now();
      const artifactId = input.target === 'local' ? input.config.artifactId : null;
      this.db
        .prepare('INSERT INTO deployments (id,function_id,target,version,status,config_json,artifact_id,created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, functionId, input.target, max + 1, 'active', JSON.stringify(input.config), artifactId, now);
      this.db.prepare('UPDATE functions SET updated_at = ? WHERE id = ?').run(now, functionId);
      return { id, functionId, version: max + 1, status: 'active', createdAt: now, ...input } as Deployment;
    });
  }
  getActiveDeployment(functionId: string, target: Target): Deployment | undefined {
    const r = this.db.prepare("SELECT * FROM deployments WHERE function_id = ? AND target = ? AND status = 'active'").get(functionId, target) as Row | undefined;
    return r ? this.toDeployment(r) : undefined;
  }
  getDeploymentById(id: string): Deployment | undefined {
    const r = this.db.prepare('SELECT * FROM deployments WHERE id = ?').get(id) as Row | undefined;
    return r ? this.toDeployment(r) : undefined;
  }
  listDeployments(functionId: string): Deployment[] {
    return (this.db.prepare('SELECT * FROM deployments WHERE function_id = ? ORDER BY target, version DESC').all(functionId) as Row[]).map((r) => this.toDeployment(r));
  }
  removeDeployment(functionId: string, target: Target): { artifactIds: string[] } {
    return this.tx(() => {
      const rows = this.db.prepare("SELECT id, artifact_id FROM deployments WHERE function_id = ? AND target = ? AND status != 'removed'").all(functionId, target) as Row[];
      if (rows.length === 0) throw new XeroError('TARGET_NOT_DEPLOYED', `function has no ${target} deployment`);
      this.db.prepare("UPDATE deployments SET status = 'removed' WHERE function_id = ? AND target = ?").run(functionId, target);
      return { artifactIds: rows.map((r) => optStr(r.artifact_id)).filter((x): x is string => x !== undefined) };
    });
  }
  isArtifactReferenced(artifactId: string): boolean {
    // Superseded versions keep artifacts (rollback/inspection); removed deployments and deleted functions release them.
    return this.db.prepare("SELECT 1 AS x FROM deployments WHERE artifact_id = ? AND status != 'removed' LIMIT 1").get(artifactId) !== undefined;
  }

  // ---- invocations ----
  recordInvocation(r: InvocationRecord): void {
    this.tx(() => {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO invocations (attempt_id,request_id,function_id,function_name,deployment_id,target,invocation_type,source,status,error_code,cold_start,aws_request_id,started_at,duration_ms,payload_bytes,response_bytes,trace_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(r.attemptId, r.requestId, r.functionId, r.functionName, r.deploymentId ?? null, r.target, r.invocationType, r.source, r.status, r.errorCode ?? null, r.coldStart === undefined ? null : r.coldStart ? 1 : 0, r.awsRequestId ?? null, r.startedAt, Math.round(r.durationMs), r.payloadBytes, r.responseBytes, r.traceId ?? null);
      this.db
        .prepare('DELETE FROM invocations WHERE function_id = ? AND attempt_id NOT IN (SELECT attempt_id FROM invocations WHERE function_id = ? ORDER BY started_at DESC LIMIT ?)')
        .run(r.functionId, r.functionId, this.maxInvocations);
    });
  }
  listInvocations(functionId: string, limit: number): InvocationRecord[] {
    return (this.db.prepare('SELECT * FROM invocations WHERE function_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?').all(functionId, limit) as Row[]).map((r) => ({
      requestId: str(r.request_id),
      attemptId: str(r.attempt_id),
      functionId: str(r.function_id),
      functionName: str(r.function_name),
      deploymentId: optStr(r.deployment_id),
      target: str(r.target) as Target,
      invocationType: str(r.invocation_type) as InvocationRecord['invocationType'],
      source: str(r.source) as InvocationRecord['source'],
      status: str(r.status) as InvocationRecord['status'],
      errorCode: optStr(r.error_code),
      coldStart: r.cold_start === null ? undefined : num(r.cold_start) === 1,
      awsRequestId: optStr(r.aws_request_id),
      startedAt: num(r.started_at),
      durationMs: num(r.duration_ms),
      payloadBytes: num(r.payload_bytes),
      responseBytes: num(r.response_bytes),
      traceId: optStr(r.trace_id),
    }));
  }

  // ---- logs ----
  appendLogs(lines: readonly LogLine[]): void {
    if (lines.length === 0) return;
    this.tx(() => {
      const ins = this.db.prepare('INSERT INTO logs (function_id,deployment_id,request_id,stream,at,message) VALUES (?,?,?,?,?,?)');
      const touched = new Set<string>();
      for (const l of lines) {
        ins.run(l.functionId, l.deploymentId, l.requestId ?? null, l.stream, l.at, l.message.slice(0, 8192));
        touched.add(l.functionId);
      }
      for (const fid of touched) {
        this.db.prepare('DELETE FROM logs WHERE function_id = ? AND id <= (SELECT COALESCE(MAX(id),0) FROM logs WHERE function_id = ?) - ?').run(fid, fid, this.maxLogLines);
      }
    });
  }
  readLogs(functionId: string, opts: { limit: number; sinceMs?: number | undefined }): LogLine[] {
    const rows = this.db
      .prepare('SELECT * FROM (SELECT * FROM logs WHERE function_id = ? AND at >= ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC')
      .all(functionId, opts.sinceMs ?? 0, opts.limit) as Row[];
    return rows.map((r) => ({
      functionId: str(r.function_id),
      deploymentId: str(r.deployment_id),
      requestId: optStr(r.request_id),
      stream: str(r.stream) as LogLine['stream'],
      at: num(r.at),
      message: str(r.message),
    }));
  }

  // ---- event sources ----
  saveEventSource(s: EventSource): void {
    try {
      this.db
        .prepare('INSERT INTO event_sources (id,function_id,kind,target,queue_url,region,batch_size,max_in_flight,visibility_extension_sec,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(s.id, s.functionId, s.kind, s.target, s.queueUrl, s.region, s.batchSize, s.maxInFlight, s.visibilityExtensionSec, s.createdAt);
    } catch (e) {
      if (String((e as Error).message).includes('UNIQUE')) throw new XeroError('EVENT_SOURCE_INVALID', 'this queue is already attached to the function');
      throw e;
    }
  }
  listEventSources(functionId?: string): EventSource[] {
    const rows = (functionId ? this.db.prepare('SELECT * FROM event_sources WHERE function_id = ? ORDER BY created_at').all(functionId) : this.db.prepare('SELECT * FROM event_sources ORDER BY created_at').all()) as Row[];
    return rows.map((r) => ({
      id: str(r.id),
      functionId: str(r.function_id),
      kind: 'sqs',
      target: str(r.target) as Target,
      queueUrl: str(r.queue_url),
      region: str(r.region),
      batchSize: num(r.batch_size),
      maxInFlight: num(r.max_in_flight),
      visibilityExtensionSec: num(r.visibility_extension_sec),
      createdAt: num(r.created_at),
    }));
  }
  deleteEventSource(id: string): boolean {
    return this.db.prepare('DELETE FROM event_sources WHERE id = ?').run(id).changes > 0;
  }

  // ---- api tokens ----
  private toToken(r: Row): ApiToken {
    return { id: str(r.id), name: str(r.name), scope: str(r.scope) as TokenScope, createdAt: num(r.created_at), revokedAt: r.revoked_at === null ? undefined : num(r.revoked_at) };
  }
  createToken(input: { name: string; scope: TokenScope; hash: string }): ApiToken {
    const id = this.ids('tok');
    const now = this.clock.now();
    try {
      this.db.prepare('INSERT INTO api_tokens (id,name,scope,hash,created_at) VALUES (?,?,?,?,?)').run(id, input.name, input.scope, input.hash, now);
    } catch (e) {
      if (String((e as Error).message).includes('UNIQUE')) throw new XeroError('INVALID_REQUEST', `a token named "${input.name}" already exists`);
      throw e;
    }
    return { id, name: input.name, scope: input.scope, createdAt: now, revokedAt: undefined };
  }
  findActiveByHash(hash: string): ApiToken | undefined {
    const r = this.db.prepare('SELECT * FROM api_tokens WHERE hash = ? AND revoked_at IS NULL').get(hash) as Row | undefined;
    return r ? this.toToken(r) : undefined;
  }
  listTokens(): ApiToken[] {
    return (this.db.prepare('SELECT * FROM api_tokens ORDER BY created_at').all() as Row[]).map((r) => this.toToken(r));
  }
  revokeToken(name: string): boolean {
    return this.db.prepare('UPDATE api_tokens SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL').run(this.clock.now(), name).changes > 0;
  }

  // ---- aws connection ----
  getAwsConnection(): AwsConnection | undefined {
    const r = this.db.prepare("SELECT value FROM kv WHERE key = 'aws_connection'").get() as Row | undefined;
    return r ? (JSON.parse(str(r.value)) as AwsConnection) : undefined;
  }
  setAwsConnection(connection: AwsConnection | undefined): void {
    if (!connection) this.db.prepare("DELETE FROM kv WHERE key = 'aws_connection'").run();
    else this.db.prepare("INSERT INTO kv (key,value) VALUES ('aws_connection',?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(connection));
  }
}
