import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  ApiToken,
  AwsConnection,
  DeploymentView,
  ErrorCode,
  EventSource,
  FunctionView,
  InvocationRecord,
  LogLine,
} from '@xero/core';
import type {
  AttachEventSourceRequest,
  AwsConnectionRequest,
  BindAwsLambdaRequest,
  DeployLocalRequest,
  InvocationType,
  Target,
} from '@xero/specification';

export type { ApiToken, DeploymentView, FunctionView, InvocationRecord, LogLine, EventSource, AwsConnection, Target, InvocationType };

export class XeroApiError extends Error {
  override readonly name = 'XeroApiError';
  constructor(
    readonly code: ErrorCode | 'NETWORK',
    message: string,
    readonly status: number,
    readonly requestId: string | undefined,
    readonly details: Record<string, unknown> | undefined,
  ) {
    super(message);
  }
}

export interface XeroClientOptions {
  baseUrl?: string;
  token: string;
  fetch?: typeof fetch;
}

export interface InvokeOptions {
  target?: Target;
  type?: InvocationType;
  requestId?: string;
  traceId?: string;
  signal?: AbortSignal;
}

export interface InvokeResult<T = unknown> {
  status: 'succeeded' | 'function-error' | 'accepted';
  target: Target;
  requestId: string;
  attemptId: string;
  functionId: string;
  deploymentId: string;
  coldStart: boolean | undefined;
  awsRequestId: string | undefined;
  executedVersion: string | undefined;
  functionError: string | undefined;
  /** Parsed JSON result (or error document when status is function-error). undefined for async acceptance. */
  payload: T | undefined;
  raw: Uint8Array;
}

export interface DeployResult {
  function: FunctionView;
  warnings: string[];
  artifact: { id: string; sizeBytes: number; fileCount: number };
}
export interface InspectResult {
  function: FunctionView;
  history: DeploymentView[];
  eventSources: Array<EventSource & { running: boolean; warnings: string[] }>;
  recentInvocations: InvocationRecord[];
  workers: { total: number; busy: number; idle: number };
}
export interface AwsStatus {
  connected: boolean;
  connection?: AwsConnection;
  valid?: boolean;
  error?: string;
}

const DEFAULT_URL = 'http://127.0.0.1:7777';

/** Typed client for the Xero controller API. It is also what the CLI uses. */
export class XeroClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: XeroClientOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_URL).replace(/\/+$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** Reads XERO_URL and XERO_TOKEN, falling back to `<XERO_HOME or ~/.xero>/token` written by the controller. */
  static async fromEnvironment(env: NodeJS.ProcessEnv = process.env): Promise<XeroClient> {
    const token = env.XERO_TOKEN?.trim() || (await readFile(join(env.XERO_HOME ?? join(homedir(), '.xero'), 'token'), 'utf8').then((t) => t.trim(), () => undefined));
    if (!token) throw new XeroApiError('UNAUTHENTICATED', 'no API token found: set XERO_TOKEN or start the controller so it creates <XERO_HOME>/token', 0, undefined, undefined);
    return new XeroClient({ baseUrl: env.XERO_URL ?? DEFAULT_URL, token });
  }

  private async request(method: string, path: string, init: { body?: string | Uint8Array<ArrayBuffer> | undefined; headers?: Record<string, string>; signal?: AbortSignal | undefined } = {}): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.token}`, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...init.headers },
        ...(init.body !== undefined ? { body: init.body } : {}),
        ...(init.signal ? { signal: init.signal } : {}),
      });
    } catch (e) {
      throw new XeroApiError('NETWORK', `cannot reach the Xero controller at ${this.baseUrl} (is it running?)`, 0, undefined, { cause: String(e) });
    }
    if (res.ok) return res;
    let doc: { error?: { code?: ErrorCode; message?: string; requestId?: string; details?: Record<string, unknown> } } = {};
    try {
      doc = (await res.json()) as typeof doc;
    } catch {
      /* non-JSON error */
    }
    throw new XeroApiError(doc.error?.code ?? 'INTERNAL', doc.error?.message ?? `HTTP ${res.status}`, res.status, doc.error?.requestId ?? res.headers.get('x-xero-request-id') ?? undefined, doc.error?.details);
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.request(method, path, { body: body === undefined ? undefined : JSON.stringify(body) });
    return (await res.json()) as T;
  }

  async health(): Promise<{ status: string; version: string }> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/health`).catch(() => undefined);
    if (!res?.ok) throw new XeroApiError('NETWORK', `cannot reach the Xero controller at ${this.baseUrl}`, 0, undefined, undefined);
    return (await res.json()) as { status: string; version: string };
  }

  // functions
  async listFunctions(): Promise<FunctionView[]> {
    return (await this.json<{ functions: FunctionView[] }>('GET', '/v1/functions')).functions;
  }
  inspect(name: string): Promise<InspectResult> {
    return this.json('GET', `/v1/functions/${encodeURIComponent(name)}`);
  }
  deployLocal(name: string, request: Omit<DeployLocalRequest, 'name'>): Promise<DeployResult> {
    return this.json('POST', `/v1/functions/${encodeURIComponent(name)}/deployments/local`, request);
  }
  bindAwsLambda(name: string, request: { arn: string; verify?: boolean; defaultTarget?: Target }): Promise<{ function: FunctionView; warnings: string[] }> {
    const body: Partial<BindAwsLambdaRequest> = { arn: request.arn, verify: request.verify ?? true, ...(request.defaultTarget ? { defaultTarget: request.defaultTarget } : {}) };
    return this.json('PUT', `/v1/functions/${encodeURIComponent(name)}/deployments/aws-lambda`, body);
  }
  removeDeployment(name: string, target: Target): Promise<{ function: FunctionView }> {
    return this.json('DELETE', `/v1/functions/${encodeURIComponent(name)}/deployments/${target}`);
  }
  async deleteFunction(name: string): Promise<void> {
    await this.json('DELETE', `/v1/functions/${encodeURIComponent(name)}`);
  }
  async setRouting(name: string, defaultTarget: Target): Promise<FunctionView> {
    return (await this.json<{ function: FunctionView }>('PATCH', `/v1/functions/${encodeURIComponent(name)}/routing`, { defaultTarget })).function;
  }
  async logs(name: string, opts: { limit?: number; since?: number } = {}): Promise<LogLine[]> {
    const q = new URLSearchParams();
    if (opts.limit) q.set('limit', String(opts.limit));
    if (opts.since !== undefined) q.set('since', String(opts.since));
    return (await this.json<{ logs: LogLine[] }>('GET', `/v1/functions/${encodeURIComponent(name)}/logs?${q}`)).logs;
  }
  async invocations(name: string, limit = 20): Promise<InvocationRecord[]> {
    return (await this.json<{ invocations: InvocationRecord[] }>('GET', `/v1/functions/${encodeURIComponent(name)}/invocations?limit=${limit}`)).invocations;
  }

  // invocation (separate from management)
  async invoke<T = unknown>(name: string, payload: unknown = {}, options: InvokeOptions = {}): Promise<InvokeResult<T>> {
    const q = new URLSearchParams();
    if (options.target) q.set('target', options.target);
    if (options.type) q.set('type', options.type);
    const body = payload instanceof Uint8Array ? (payload as Uint8Array<ArrayBuffer>) : JSON.stringify(payload);
    const headers: Record<string, string> = {};
    if (options.requestId) headers['x-xero-request-id'] = options.requestId;
    if (options.traceId) headers['x-amzn-trace-id'] = options.traceId;
    const res = await this.request('POST', `/v1/invoke/${encodeURIComponent(name)}?${q}`, { body, headers, signal: options.signal });
    const raw = new Uint8Array(await res.arrayBuffer());
    const h = res.headers;
    let parsed: T | undefined;
    if (raw.byteLength > 0) {
      try {
        parsed = JSON.parse(new TextDecoder().decode(raw)) as T;
      } catch {
        parsed = undefined;
      }
    }
    const cold = h.get('x-xero-cold-start');
    return {
      status: h.get('x-xero-status') as InvokeResult['status'],
      target: h.get('x-xero-target') as Target,
      requestId: h.get('x-xero-request-id') ?? '',
      attemptId: h.get('x-xero-attempt-id') ?? '',
      functionId: h.get('x-xero-function-id') ?? '',
      deploymentId: h.get('x-xero-deployment-id') ?? '',
      coldStart: cold === null ? undefined : cold === 'true',
      awsRequestId: h.get('x-xero-aws-request-id') ?? undefined,
      executedVersion: h.get('x-xero-executed-version') ?? undefined,
      functionError: h.get('x-xero-function-error') ?? undefined,
      payload: parsed,
      raw,
    };
  }

  // observability
  metrics(): Promise<{ series: Array<{ kind: string; name: string; labels: Record<string, string>; value?: number; count?: number; sum?: number; max?: number }>; workers: { total: number; busy: number; idle: number } }> {
    return this.json('GET', '/v1/metrics');
  }

  // access control
  createToken(name: string, scope: 'read' | 'invoke' | 'admin'): Promise<{ token: string; record: ApiToken }> {
    return this.json('POST', '/v1/tokens', { name, scope });
  }
  async listTokens(): Promise<ApiToken[]> {
    return (await this.json<{ tokens: ApiToken[] }>('GET', '/v1/tokens')).tokens;
  }
  async revokeToken(name: string): Promise<void> {
    await this.json('DELETE', `/v1/tokens/${encodeURIComponent(name)}`);
  }

  // operations
  pullImages(runtimes?: string[]): Promise<{ pulled: string[] }> {
    return this.json('POST', '/v1/images/pull', runtimes ? { runtimes } : {});
  }
  createBackup(): Promise<{ path: string }> {
    return this.json('POST', '/v1/backups', {});
  }
  doctor(): Promise<{ ok: boolean; checks: Array<{ name: string; status: 'ok' | 'warn' | 'fail'; detail: string }> }> {
    return this.json('GET', '/v1/doctor');
  }

  // AWS (opt-in)
  awsStatus(): Promise<AwsStatus> {
    return this.json('GET', '/v1/aws/connection');
  }
  connectAws(request: AwsConnectionRequest): Promise<{ connection: AwsConnection; warnings: string[] }> {
    return this.json('PUT', '/v1/aws/connection', request);
  }
  async disconnectAws(): Promise<void> {
    await this.json('DELETE', '/v1/aws/connection');
  }

  // event sources
  async listEventSources(): Promise<Array<EventSource & { functionName?: string; running: boolean; warnings: string[] }>> {
    return (await this.json<{ eventSources: Array<EventSource & { functionName?: string; running: boolean; warnings: string[] }> }>('GET', '/v1/events')).eventSources;
  }
  attachEventSource(request: Omit<AttachEventSourceRequest, 'target' | 'batchSize' | 'maxInFlight' | 'visibilityExtensionSec'> & Partial<Pick<AttachEventSourceRequest, 'target' | 'batchSize' | 'maxInFlight' | 'visibilityExtensionSec'>>): Promise<{ eventSource: EventSource; warnings: string[]; queue: { visibilityTimeoutSec: number; hasDeadLetterQueue: boolean; fifo: boolean } }> {
    return this.json('POST', '/v1/events', request);
  }
  async detachEventSource(id: string): Promise<void> {
    await this.json('DELETE', `/v1/events/${encodeURIComponent(id)}`);
  }
}
