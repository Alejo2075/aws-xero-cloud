import type { InvocationType, Target } from '@xero/specification';
import type {
  ApiToken,
  TokenScope,
  ArtifactRef,
  AwsConnection,
  Deployment,
  EventSource,
  InvocationRecord,
  LogLine,
  LogicalFunction,
  NewDeployment,
  ObservedLambdaConfig,
} from './domain.js';
import type { Routing } from '@xero/specification';

/** Persistence port. Implemented by `@xero/registry`. */
export interface FunctionRegistry {
  createFunction(input: { name: string; description: string | undefined; routing: Routing }): LogicalFunction;
  getFunctionByName(name: string): LogicalFunction | undefined;
  getFunctionById(id: string): LogicalFunction | undefined;
  listFunctions(): LogicalFunction[];
  updateRouting(functionId: string, routing: Routing): LogicalFunction;
  deleteFunction(functionId: string): { artifactIds: string[] };

  /** Adds a deployment; supersedes the previous active deployment of the same target atomically. */
  addDeployment(functionId: string, input: NewDeployment): Deployment;
  getActiveDeployment(functionId: string, target: Target): Deployment | undefined;
  getDeploymentById(id: string): Deployment | undefined;
  listDeployments(functionId: string): Deployment[];
  removeDeployment(functionId: string, target: Target): { artifactIds: string[] };
  isArtifactReferenced(artifactId: string): boolean;

  recordInvocation(record: InvocationRecord): void;
  listInvocations(functionId: string, limit: number): InvocationRecord[];

  appendLogs(lines: readonly LogLine[]): void;
  readLogs(functionId: string, opts: { limit: number; sinceMs?: number | undefined }): LogLine[];

  saveEventSource(source: EventSource): void;
  listEventSources(functionId?: string): EventSource[];
  deleteEventSource(id: string): boolean;

  getAwsConnection(): AwsConnection | undefined;
  setAwsConnection(connection: AwsConnection | undefined): void;
}

/** Persistence of scoped API tokens. Only SHA-256 hashes are stored; the plaintext is shown once at creation. */
export interface TokenStore {
  createToken(input: { name: string; scope: TokenScope; hash: string }): ApiToken;
  findActiveByHash(hash: string): ApiToken | undefined;
  listTokens(): ApiToken[];
  /** Revokes by name. Returns false when no active token has that name. */
  revokeToken(name: string): boolean;
}

/** Content-addressed immutable artifact storage. Implemented by `@xero/artifacts`. */
export interface ArtifactStore {
  ingest(sourceDir: string): Promise<ArtifactRef>;
  pathOf(artifactId: string): string;
  remove(artifactId: string): Promise<void>;
}

export interface LambdaInvokeRequest {
  arn: string;
  region: string;
  payload: Uint8Array;
  invocationType: InvocationType;
  signal?: AbortSignal | undefined;
  traceId?: string | undefined;
}
export interface LambdaInvokeResult {
  statusCode: number;
  functionError: string | undefined;
  executedVersion: string | undefined;
  awsRequestId: string | undefined;
  payload: Uint8Array;
}

/** Port for invoking an existing native AWS Lambda. Implemented by `@xero/target-aws-lambda`. */
export interface LambdaInvoker {
  invoke(request: LambdaInvokeRequest): Promise<LambdaInvokeResult>;
  describe(arn: string, region: string): Promise<ObservedLambdaConfig>;
}

export interface IssuedCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  /** epoch ms */
  expiresAt: number;
}

/** Issues short-lived credentials for function workers. Never returns controller credentials. */
export interface CredentialIssuer {
  issue(request: { roleArn: string; sessionName: string; durationSec: number; region: string }): Promise<IssuedCredentials>;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export interface Metrics {
  inc(name: string, labels?: Record<string, string>, by?: number): void;
  gauge(name: string, value: number, labels?: Record<string, string>): void;
  observe(name: string, value: number, labels?: Record<string, string>): void;
}
