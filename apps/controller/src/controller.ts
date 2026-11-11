import { join } from 'node:path';
import { XeroError, type EventSource, type LambdaInvoker, type Logger } from '@xero/core';
import { DirectoryArtifactStore } from '@xero/artifacts';
import { DockerBackend } from '@xero/executor-docker';
import { RuntimeCatalog, type ExecutionBackend } from '@xero/execution';
import { AwsLambdaTargetExecutor, InvocationRouter, LocalTargetExecutor } from '@xero/invocation';
import { SqliteRegistry } from '@xero/registry';
import { nodeRuntime } from '@xero/runtime-node';
import { pythonRuntime } from '@xero/runtime-python';
import { WorkerPool } from '@xero/scaling';
import { ConcurrencyScheduler } from '@xero/scheduler';
import { MetricsRegistry, Redactor, createLogger } from '@xero/telemetry';
import { AwsIdentity } from '@xero/aws-identity';
import { LambdaTargetAdapter } from '@xero/target-aws-lambda';
import { AwsSqsClient, type SqsPort } from '@xero/event-source-sqs';
import type { Server } from 'node:http';
import { ensureToken } from './auth.js';
import { loadConfig, type ControllerConfig } from './config.js';
import { EventSourceManager } from './event-sources.js';
import { createHttpServer } from './http.js';
import { LogWriter } from './log-writer.js';
import { XeroService } from './service.js';

export interface ControllerOverrides {
  config?: Partial<ControllerConfig>;
  backend?: ExecutionBackend;
  logger?: Logger;
  identity?: AwsIdentity;
  lambdaInvoker?: LambdaInvoker;
  sqsPortFactory?: (source: EventSource) => SqsPort;
}

export interface Controller {
  service: XeroService;
  config: ControllerConfig;
  token: string;
  server: Server;
  url: string;
  registry: SqliteRegistry;
  metrics: MetricsRegistry;
  close(): Promise<void>;
}

/** Composition root. Everything environment-specific (Docker, AWS SDK) is injectable for tests. */
export async function createController(overrides: ControllerOverrides = {}, env: NodeJS.ProcessEnv = process.env): Promise<Controller> {
  const config = loadConfig(env, overrides.config);
  const redactor = new Redactor();
  const logger = overrides.logger ?? createLogger({ level: config.logLevel, redactor });
  const metrics = new MetricsRegistry();
  const token = await ensureToken(config.home);

  const registry = new SqliteRegistry(join(config.home, 'xero.db'));
  const artifacts = new DirectoryArtifactStore(join(config.home, 'artifacts'));
  const runtimes = new RuntimeCatalog([nodeRuntime, pythonRuntime]);
  const backend = overrides.backend ?? new DockerBackend({ binary: config.dockerBinary });

  const logWriter = new LogWriter(registry, redactor, { now: () => Date.now() }, logger);
  const scheduler = new ConcurrencyScheduler({ maxConcurrent: config.maxWorkers, queueLimit: config.queueLimit, metrics });
  const pool = new WorkerPool({ backend, maxWorkers: config.maxWorkers, metrics, logger: logger.child({ component: 'pool' }), onLog: (w, stream, line, at) => logWriter.push(w, stream, line, at) });

  // AWS pieces are created eagerly but never contact AWS until the operator connects and uses them.
  const identity = overrides.identity ?? new AwsIdentity({
    currentTarget: () => {
      const c = registry.getAwsConnection();
      return c ? { profile: c.profile, region: c.region } : undefined;
    },
  });
  const lambda = overrides.lambdaInvoker ?? new LambdaTargetAdapter({
    credentials: () => {
      const c = registry.getAwsConnection();
      return c ? identity.controllerCredentials({ profile: c.profile, region: c.region }) : undefined;
    },
  });

  const local = new LocalTargetExecutor({ registry, artifacts, runtimes, scheduler, pool, credentials: identity, metrics, logger, onSecret: (s) => redactor.addSecret(s) });
  const aws = new AwsLambdaTargetExecutor({ registry, invoker: () => lambda, metrics });
  const router = new InvocationRouter({ registry, executors: { local, 'aws-lambda': aws }, metrics, logger: logger.child({ component: 'invocation' }) });

  const events = new EventSourceManager({
    registry, router, logger, metrics,
    portFactory: overrides.sqsPortFactory ?? ((source) => {
      const c = registry.getAwsConnection();
      if (!c) throw new XeroError('AWS_NOT_CONNECTED', 'AWS is not connected');
      return new AwsSqsClient(source.queueUrl, source.region, identity.controllerCredentials({ profile: c.profile, region: c.region }));
    }),
  });

  const service = new XeroService({ config, registry, artifacts, runtimes, router, pool, identity, lambda, events, metrics, logger });

  // Reap workers orphaned by a previous controller run (best effort; a stopped engine must not block startup).
  try {
    for (const w of await backend.listManaged()) await backend.reap(w.backendId);
  } catch (e) {
    logger.warn('container engine not available at startup; local invocations will fail until it is running', { code: e instanceof XeroError ? e.code : 'ERROR' });
  }

  pool.start();
  logWriter.start();
  const server = createHttpServer({ service, token, logger: logger.child({ component: 'http' }) });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : config.port;
  const host = config.host.includes(':') ? `[${config.host}]` : config.host;
  const url = `http://${host}:${port}`;
  // AWS-origin event sources resume only when a connection exists; failures retry in the background.
  if (registry.getAwsConnection()) void events.startAll();
  logger.info('controller listening', { url, home: config.home });

  let closed = false;
  return {
    service, config, token, server, url, registry, metrics,
    async close() {
      if (closed) return;
      closed = true;
      await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); });
      await events.stopAll();
      await pool.stopAll();
      logWriter.stop();
      registry.close();
    },
  };
}
