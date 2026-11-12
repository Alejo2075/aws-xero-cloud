import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { XeroError, isXeroError } from '@xero/core';
import {
  attachEventSourceRequestSchema,
  awsConnectionRequestSchema,
  bindAwsLambdaRequestSchema,
  deployLocalRequestSchema,
  functionNameSchema,
  invocationTypeSchema,
  targetSchema,
} from '@xero/specification';
import { MAX_PAYLOAD_BYTES, newId } from '@xero/shared';
import type { Logger } from '@xero/core';
import type { TokenStore } from '@xero/core';
import { hashToken, RateLimiter, requiredScope, scopeAllows } from './access.js';
import { tokenMatches } from './auth.js';
import type { XeroService } from './service.js';

export const API_VERSION_STRING = '0.1.0';
const MGMT_BODY_LIMIT = 1024 * 1024;
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

class HttpError extends XeroError {}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > limit) throw new XeroError('PAYLOAD_TOO_LARGE', `request body exceeds ${limit} bytes`);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > limit) throw new XeroError('PAYLOAD_TOO_LARGE', `request body exceeds ${limit} bytes`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson<S extends z.ZodType>(req: IncomingMessage, schema: S): Promise<z.infer<S>> {
  const raw = await readBody(req, MGMT_BODY_LIMIT);
  let doc: unknown;
  try {
    doc = raw.length === 0 ? {} : JSON.parse(raw.toString('utf8'));
  } catch {
    throw new XeroError('INVALID_REQUEST', 'request body is not valid JSON');
  }
  const parsed = schema.safeParse(doc);
  if (!parsed.success) {
    throw new XeroError('INVALID_REQUEST', 'request validation failed', { issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  }
  return parsed.data;
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store', ...headers });
  res.end(text);
}

const nameParam = (v: string | undefined): string => {
  const r = functionNameSchema.safeParse(decodeURIComponent(v ?? ''));
  if (!r.success) throw new XeroError('INVALID_REQUEST', 'invalid function name');
  return r.data;
};
const intParam = (v: string | null, d: number, min: number, max: number): number => {
  const n = v === null ? d : Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new XeroError('INVALID_REQUEST', `query parameter must be an integer between ${min} and ${max}`);
  return n;
};

const deployBody = deployLocalRequestSchema.omit({ name: true });
const routingBody = z.object({ defaultTarget: targetSchema }).strict();
const attachBody = attachEventSourceRequestSchema;

type Handler = (ctx: { req: IncomingMessage; res: ServerResponse; url: URL; params: string[]; requestId: string }) => Promise<void>;
interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

export interface HttpOptions {
  service: XeroService;
  /** Master (admin) token from `<home>/token`. */
  token: string;
  tokens: TokenStore;
  rateLimitRps?: number;
  logger: Logger;
}

export function createHttpServer({ service, token, tokens, rateLimitRps = 0, logger }: HttpOptions): Server {
  const limiter = new RateLimiter(rateLimitRps, Math.max(1, rateLimitRps * 2), { now: () => Date.now() });
  const routes: Route[] = [];
  const on = (method: string, path: string, handler: Handler): void => {
    routes.push({ method, pattern: new RegExp(`^${path.replace(/:[a-z]+/g, '([^/]+)')}$`), handler });
  };
  const ok = (res: ServerResponse, body: unknown, status = 200): void => send(res, status, body);

  on('GET', '/v1/functions', async ({ res }) => ok(res, { functions: service.listFunctions() }));
  on('GET', '/v1/functions/:name', async ({ res, params }) => ok(res, service.inspect(nameParam(params[0]))));
  on('DELETE', '/v1/functions/:name', async ({ res, params }) => {
    await service.deleteFunction(nameParam(params[0]));
    ok(res, { deleted: true });
  });
  on('POST', '/v1/functions/:name/deployments/local', async ({ req, res, params }) => {
    ok(res, await service.deployLocal(nameParam(params[0]), await readJson(req, deployBody)), 201);
  });
  on('PUT', '/v1/functions/:name/deployments/aws-lambda', async ({ req, res, params }) => {
    ok(res, await service.bindAwsLambda(nameParam(params[0]), await readJson(req, bindAwsLambdaRequestSchema)), 201);
  });
  on('DELETE', '/v1/functions/:name/deployments/:target', async ({ res, params }) => {
    const target = targetSchema.safeParse(params[1]);
    if (!target.success) throw new XeroError('INVALID_REQUEST', 'target must be local or aws-lambda');
    ok(res, await service.removeDeployment(nameParam(params[0]), target.data));
  });
  on('PATCH', '/v1/functions/:name/routing', async ({ req, res, params }) => {
    const body = await readJson(req, routingBody);
    ok(res, { function: service.setRouting(nameParam(params[0]), body.defaultTarget) });
  });
  on('GET', '/v1/functions/:name/logs', async ({ res, url, params }) => {
    const since = url.searchParams.get('since');
    ok(res, { logs: service.logs(nameParam(params[0]), { limit: intParam(url.searchParams.get('limit'), 200, 1, 5000), sinceMs: since ? intParam(since, 0, 0, Number.MAX_SAFE_INTEGER) : undefined }) });
  });
  on('GET', '/v1/functions/:name/invocations', async ({ res, url, params }) => {
    ok(res, { invocations: service.invocations(nameParam(params[0]), intParam(url.searchParams.get('limit'), 20, 1, 500)) });
  });

  on('POST', '/v1/invoke/:name', async ({ req, res, url, params, requestId }) => {
    const name = nameParam(params[0]);
    const targetParam = url.searchParams.get('target');
    const target = targetParam === null ? undefined : targetSchema.safeParse(targetParam);
    if (target && !target.success) throw new XeroError('INVALID_REQUEST', 'target must be local or aws-lambda');
    const typeParam = url.searchParams.get('type');
    const type = typeParam === null ? undefined : invocationTypeSchema.safeParse(typeParam);
    if (type && !type.success) throw new XeroError('INVALID_REQUEST', 'type must be RequestResponse or Event');
    const payload = await readBody(req, MAX_PAYLOAD_BYTES + 1024);
    const abort = new AbortController();
    res.once('close', () => { if (!res.writableEnded) abort.abort(); }); // client went away: stop waiting (and fence local worker)
    const trace = req.headers['x-amzn-trace-id'];
    const result = await service.invoke({
      functionName: name,
      payload,
      target: target?.data,
      invocationType: type?.data,
      requestId: requestId,
      traceId: typeof trace === 'string' ? trace.slice(0, 256) : undefined,
      signal: abort.signal,
    });
    const headers: Record<string, string> = {
      'x-xero-request-id': result.requestId, 'x-xero-attempt-id': result.attemptId, 'x-xero-function-id': result.functionId,
      'x-xero-deployment-id': result.deploymentId, 'x-xero-target': result.target, 'x-xero-status': result.status,
    };
    if (result.coldStart !== undefined) headers['x-xero-cold-start'] = String(result.coldStart);
    if (result.awsRequestId) headers['x-xero-aws-request-id'] = result.awsRequestId;
    if (result.executedVersion) headers['x-xero-executed-version'] = result.executedVersion;
    if (result.functionError) headers['x-xero-function-error'] = result.functionError;
    const body = Buffer.from(result.payload);
    // Like Lambda, a function error is HTTP 200 with a header; async acceptance is 202.
    res.writeHead(result.status === 'accepted' ? 202 : 200, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store', ...headers });
    res.end(body);
  });

  on('GET', '/v1/metrics', async ({ res, url }) => {
    if (url.searchParams.get('format') === 'prometheus') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      res.end(service.prometheus());
    } else ok(res, service.metricsSnapshot());
  });

  on('POST', '/v1/images/pull', async ({ req, res }) => ok(res, await service.pullImages((await readJson(req, z.object({ runtimes: z.array(z.string()).max(16).optional() }).strict())).runtimes)));
  on('POST', '/v1/backups', async ({ res }) => ok(res, service.createBackup(), 201));
  on('GET', '/v1/doctor', async ({ res }) => ok(res, await service.doctor()));

  const tokenBody = z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9-_]{0,31}$/), scope: z.enum(['read', 'invoke', 'admin']) }).strict();
  on('GET', '/v1/tokens', async ({ res }) => ok(res, { tokens: service.listTokens() }));
  on('POST', '/v1/tokens', async ({ req, res }) => {
    const b = await readJson(req, tokenBody);
    ok(res, service.createToken(b.name, b.scope), 201);
  });
  on('DELETE', '/v1/tokens/:name', async ({ res, params }) => {
    service.revokeToken(decodeURIComponent(params[0] ?? ''));
    ok(res, { revoked: true });
  });

  on('GET', '/v1/aws/connection', async ({ res }) => ok(res, await service.awsStatus()));
  on('PUT', '/v1/aws/connection', async ({ req, res }) => ok(res, await service.connectAws(await readJson(req, awsConnectionRequestSchema))));
  on('DELETE', '/v1/aws/connection', async ({ res }) => {
    await service.disconnectAws();
    ok(res, { connected: false });
  });

  on('GET', '/v1/events', async ({ res }) => ok(res, { eventSources: service.listEventSources() }));
  on('POST', '/v1/events', async ({ req, res }) => ok(res, await service.attachEventSource(await readJson(req, attachBody)), 201));
  on('DELETE', '/v1/events/:id', async ({ res, params }) => {
    await service.detachEventSource(decodeURIComponent(params[0] ?? ''));
    ok(res, { deleted: true });
  });

  return createServer((req, res) => {
    void (async () => {
      const incoming = req.headers['x-xero-request-id'];
      const requestId = typeof incoming === 'string' && /^[A-Za-z0-9_.-]{8,128}$/.test(incoming) ? incoming : newId('req');
      try {
        // DNS-rebinding and browser-CSRF defences for a loopback API.
        if (!LOOPBACK_HOST.test(req.headers.host ?? '')) throw new HttpError('UNAUTHENTICATED', 'unexpected Host header');
        if (req.headers.origin !== undefined) throw new HttpError('UNAUTHENTICATED', 'browser-originated requests are not accepted');
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (req.method === 'GET' && url.pathname === '/v1/health') return send(res, 200, { status: 'ok', version: API_VERSION_STRING });
        if (req.method === 'GET' && url.pathname === '/v1/ready') {
          const r = await service.ready();
          return send(res, r.ready ? 200 : 503, r);
        }
        let principal: { id: string; scope: 'read' | 'invoke' | 'admin' };
        if (tokenMatches(token, req.headers.authorization)) principal = { id: 'master', scope: 'admin' };
        else {
          const presented = /^Bearer (xero_[a-z]+_[0-9a-f]{48})$/.exec(req.headers.authorization ?? '')?.[1];
          const found = presented ? tokens.findActiveByHash(hashToken(presented)) : undefined;
          if (!found) throw new XeroError('UNAUTHENTICATED', 'missing or invalid bearer token');
          principal = { id: found.id, scope: found.scope };
        }
        const wait = limiter.take(principal.id);
        if (wait > 0) throw new XeroError('RATE_LIMITED', 'too many requests', { retryAfterSeconds: wait });
        const needed = requiredScope(req.method ?? 'GET', url.pathname);
        if (!scopeAllows(principal.scope, needed)) throw new XeroError('FORBIDDEN', `this token cannot perform this action (needs ${needed} scope)`, { needed });
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = r.pattern.exec(url.pathname);
          if (!m) continue;
          return await r.handler({ req, res, url, params: m.slice(1), requestId });
        }
        throw new XeroError('NOT_FOUND', `no route for ${req.method} ${url.pathname}`);
      } catch (e) {
        const err = isXeroError(e) ? e : new XeroError('INTERNAL', 'internal error', undefined, { cause: e });
        if (!isXeroError(e)) logger.error('unhandled request error', { requestId, error: e });
        if (res.headersSent) return void res.end();
        const extra: Record<string, string> = { 'x-xero-request-id': requestId };
        if (err.code === 'AWS_THROTTLED' || err.code === 'CAPACITY_EXHAUSTED') extra['retry-after'] = '1';
        if (err.code === 'RATE_LIMITED') extra['retry-after'] = String(err.details?.retryAfterSeconds ?? 1);
        send(res, err.httpStatus, { error: { ...err.toJSON(), requestId } }, extra);
      }
    })();
  });
}
