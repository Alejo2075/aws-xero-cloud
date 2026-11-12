import { readFile } from 'node:fs/promises';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { resolve, sep } from 'node:path';
import { XeroApiError, type XeroClient, type Target } from '@xero/sdk';
import { CliUsageError, defaultName, inferRuntime, loadManifest } from './manifest.js';
import { clean, renderDeployment, renderFunctions, renderInvocations, renderLogs, table } from './render.js';

export interface CliIo {
  client: () => Promise<XeroClient>;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  stdin: () => Promise<string>;
  cwd: string;
}

const USAGE = `xero — your hardware, your Lambdas.

Usage: xero <command> [options]            (add --json for machine-readable output)

  deploy <dir> [--name N] [--runtime R] [--handler H] [--memory MB] [--timeout S] [--concurrency N]
               [--idle-ttl S] [--min-warm N] [--env K=V]... [--role ARN] [--default-target local|aws-lambda]
  update <name> <dir> [same flags as deploy]
  invoke <name> [--payload JSON | --payload-file F | --payload -] [--target local|aws-lambda] [--async] [--trace ID]
  logs <name> [--limit N] [--follow]
  remove <name> [--target local|aws-lambda]
  functions list | inspect <name> | bind <name> --arn ARN [--no-verify] [--default] | unbind <name> --target T
            | route <name> --default-target T | history <name> [--limit N]
  aws connect --region R [--profile P] | status | disconnect
  events attach <name> --source sqs --queue-url URL [--target T] [--batch-size N] [--max-in-flight N]
                       [--visibility-extension S] | list | detach <id>
  tokens create <name> --scope read|invoke|admin | list | revoke <name>
  metrics [--prometheus]
  images pull [RUNTIME...]      pre-pull base images (avoids a slow first cold start)
  backup                        snapshot the registry (restore: xero-controller restore --from FILE)
  doctor                        check engine, database, AWS and event sources
  status

Environment: XERO_URL (default http://127.0.0.1:7777), XERO_TOKEN or XERO_HOME (token file written by the controller).
Exit codes: 0 ok, 1 error, 2 usage, 3 the function returned an error (payload is still printed).`;

type Opts = Record<string, string | boolean | string[] | undefined>;
function parse(args: string[], options: NonNullable<ParseArgsConfig['options']>): { values: Opts; positionals: string[] } {
  try {
    const r = parseArgs({ args, options: { json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, ...options }, allowPositionals: true, strict: true });
    return { values: r.values as Opts, positionals: r.positionals };
  } catch (e) {
    throw new CliUsageError(e instanceof Error ? e.message : String(e));
  }
}

const num = (v: unknown, name: string): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new CliUsageError(`--${name} must be a number`);
  return n;
};
const target = (v: unknown, name = 'target'): Target | undefined => {
  if (v === undefined) return undefined;
  if (v !== 'local' && v !== 'aws-lambda') throw new CliUsageError(`--${name} must be "local" or "aws-lambda"`);
  return v;
};
const need = (v: string | undefined, what: string): string => {
  if (!v) throw new CliUsageError(`missing ${what}`);
  return v;
};
function envPairs(list: unknown): Record<string, string> | undefined {
  if (!Array.isArray(list) || list.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const item of list as string[]) {
    const i = item.indexOf('=');
    if (i <= 0) throw new CliUsageError(`--env expects KEY=VALUE, got "${item}"`);
    out[item.slice(0, i)] = item.slice(i + 1);
  }
  return out;
}

const DEPLOY_OPTIONS = {
  name: { type: 'string' }, runtime: { type: 'string' }, handler: { type: 'string' }, memory: { type: 'string' }, timeout: { type: 'string' },
  concurrency: { type: 'string' }, 'idle-ttl': { type: 'string' }, 'min-warm': { type: 'string' }, env: { type: 'string', multiple: true }, role: { type: 'string' },
  'default-target': { type: 'string' }, description: { type: 'string' },
} as const;

export async function run(argv: string[], io: CliIo): Promise<number> {
  const print = (s: string): void => io.stdout(`${s}\n`);
  try {
    const [command, ...rest] = argv;
    if (!command || command === 'help' || command === '--help' || command === '-h') {
      print(USAGE);
      return command ? 0 : 2;
    }
    const json = (v: unknown): void => print(JSON.stringify(v, null, 2));
    const out = (opts: Opts, value: unknown, human: () => string): void => (opts.json ? json(value) : print(human()));

    switch (command) {
      case 'deploy':
      case 'update': {
        const { values, positionals } = parse(rest, DEPLOY_OPTIONS);
        const updating = command === 'update';
        const dirArg = updating ? positionals[1] : positionals[0];
        const dir = resolve(io.cwd, need(dirArg, 'function directory'));
        const loaded = await loadManifest(dir);
        const m = loaded?.manifest;
        const local = m?.spec.deployments.local;
        const inferred = !m && !values.runtime ? await inferRuntime(dir) : undefined;
        const runtime = (values.runtime as string | undefined) ?? m?.spec.runtime ?? inferred?.runtime;
        const handler = (values.handler as string | undefined) ?? m?.spec.handler ?? inferred?.handler;
        if (!runtime || !handler) throw new CliUsageError('cannot infer runtime/handler: pass --runtime and --handler or add a xero.yaml');
        const name = updating ? need(positionals[0], 'function name') : ((values.name as string | undefined) ?? m?.metadata.name ?? defaultName(dir));
        if (updating) await (await io.client()).inspect(name); // "update" never creates: FUNCTION_NOT_FOUND if it does not exist
        const source = local && local.artifact !== '.' ? resolve(dir, local.artifact) : dir;
        if (source !== dir && !source.startsWith(dir + sep)) throw new CliUsageError('manifest artifact must stay inside the function directory');
        const env = { ...(local?.environment ?? {}), ...(envPairs(values.env) ?? {}) };
        const defaultTarget = target(values['default-target'], 'default-target') ?? m?.spec.routing?.defaultTarget;
        const res = await (await io.client()).deployLocal(name, {
          runtime: runtime as never, handler, sourcePath: source,
          ...(m?.metadata.description || values.description ? { description: (values.description as string | undefined) ?? m?.metadata.description } : {}),
          ...(num(values.memory, 'memory') ?? local?.memoryMb ? { memoryMb: num(values.memory, 'memory') ?? local?.memoryMb } : {}),
          ...(num(values.timeout, 'timeout') ?? local?.timeoutSec ? { timeoutSec: num(values.timeout, 'timeout') ?? local?.timeoutSec } : {}),
          ...(num(values.concurrency, 'concurrency') ?? local?.maxConcurrency ? { maxConcurrency: num(values.concurrency, 'concurrency') ?? local?.maxConcurrency } : {}),
          ...(num(values['idle-ttl'], 'idle-ttl') ?? local?.idleTtlSec !== undefined ? { idleTtlSec: num(values['idle-ttl'], 'idle-ttl') ?? local?.idleTtlSec } : {}),
          ...(num(values['min-warm'], 'min-warm') ?? local?.minWarm ? { minWarm: num(values['min-warm'], 'min-warm') ?? local?.minWarm } : {}),
          ...(Object.keys(env).length ? { environment: env } : {}),
          ...((values.role as string | undefined) ?? local?.awsRoleArn ? { awsRoleArn: (values.role as string | undefined) ?? local?.awsRoleArn } : {}),
          ...(defaultTarget && defaultTarget !== 'aws-lambda' ? { defaultTarget } : {}),
        } as never);
        const warnings = [...res.warnings];
        let result = res.function;
        const awsSpec = m?.spec.deployments['aws-lambda'];
        if (awsSpec) {
          const b = await (await io.client()).bindAwsLambda(name, { arn: awsSpec.arn, ...(defaultTarget === 'aws-lambda' ? { defaultTarget } : {}) });
          warnings.push(...b.warnings);
          result = b.function;
        }
        out(values, { function: result, warnings, artifact: res.artifact }, () => `${updating ? 'Updated' : 'Deployed'} ${name} → local v${result.deployments.local?.version} (artifact ${res.artifact.id.slice(0, 19)}…, ${res.artifact.fileCount} files)${warnings.map((w) => `\n  warning: ${w}`).join('')}`);
        return 0;
      }

      case 'invoke': {
        const { values, positionals } = parse(rest, { payload: { type: 'string' }, 'payload-file': { type: 'string' }, target: { type: 'string' }, async: { type: 'boolean' }, trace: { type: 'string' } });
        const name = need(positionals[0], 'function name');
        let raw = values.payload as string | undefined;
        if (values['payload-file']) raw = await readFile(resolve(io.cwd, values['payload-file'] as string), 'utf8');
        if (raw === '-') raw = await io.stdin();
        let payload: unknown = {};
        if (raw !== undefined) {
          try {
            payload = JSON.parse(raw);
          } catch {
            throw new CliUsageError('payload is not valid JSON');
          }
        }
        const t = target(values.target);
        const r = await (await io.client()).invoke(name, payload, { ...(t ? { target: t } : {}), ...(values.async ? { type: 'Event' as const } : {}), ...(values.trace ? { traceId: values.trace as string } : {}) });
        if (values.json) json({ ...r, raw: undefined });
        else {
          if (r.status !== 'accepted') print(JSON.stringify(r.payload ?? null, null, 2));
          io.stderr(`${r.status} target=${r.target} request=${r.requestId}${r.coldStart === undefined ? '' : r.coldStart ? ' cold-start' : ' warm'}${r.awsRequestId ? ` aws-request=${r.awsRequestId}` : ''}\n`);
        }
        return r.status === 'function-error' ? 3 : 0;
      }

      case 'logs': {
        const { values, positionals } = parse(rest, { limit: { type: 'string' }, follow: { type: 'boolean', short: 'f' } });
        const name = need(positionals[0], 'function name');
        const client = await io.client();
        let logs = await client.logs(name, { limit: num(values.limit, 'limit') ?? 200 });
        if (values.json) json(logs);
        else if (logs.length) print(renderLogs(logs));
        if (values.follow) {
          let since = logs.at(-1)?.at ?? Date.now();
          for (;;) {
            await new Promise((r) => setTimeout(r, 1000));
            logs = (await client.logs(name, { since: since + 1, limit: 500 })).filter((l) => l.at > since);
            if (logs.length) {
              since = logs.at(-1)!.at;
              print(values.json ? JSON.stringify(logs) : renderLogs(logs));
            }
          }
        }
        return 0;
      }

      case 'remove': {
        const { values, positionals } = parse(rest, { target: { type: 'string' } });
        const name = need(positionals[0], 'function name');
        const t = target(values.target);
        const client = await io.client();
        if (t) await client.removeDeployment(name, t);
        else await client.deleteFunction(name);
        out(values, { removed: name, ...(t ? { target: t } : {}) }, () => (t ? `Removed ${t} deployment of ${name}` : `Removed function ${name}`));
        return 0;
      }

      case 'functions': {
        const [sub, ...args] = rest;
        const client = await io.client();
        switch (sub) {
          case 'list': {
            const { values } = parse(args, {});
            const fns = await client.listFunctions();
            out(values, fns, () => renderFunctions(fns));
            return 0;
          }
          case 'inspect': {
            const { values, positionals } = parse(args, {});
            const r = await client.inspect(need(positionals[0], 'function name'));
            out(values, r, () => `${renderDeployment(r.function)}\n\nEvent sources: ${r.eventSources.length ? r.eventSources.map((s) => `${s.id} ${s.queueUrl} → ${s.target} (${s.running ? 'running' : 'stopped'})`).join('; ') : 'none'}\nWorkers: ${r.workers.total} (${r.workers.busy} busy)\n\nRecent invocations:\n${renderInvocations(r.recentInvocations)}`);
            return 0;
          }
          case 'bind': {
            const { values, positionals } = parse(args, { arn: { type: 'string' }, target: { type: 'string' }, 'no-verify': { type: 'boolean' }, default: { type: 'boolean' } });
            const t = target(values.target) ?? 'aws-lambda';
            if (t !== 'aws-lambda') throw new CliUsageError('only --target aws-lambda can be bound; use "deploy" for local');
            const r = await client.bindAwsLambda(need(positionals[0], 'function name'), { arn: need(values.arn as string | undefined, '--arn'), verify: !values['no-verify'], ...(values.default ? { defaultTarget: 'aws-lambda' as const } : {}) });
            out(values, r, () => `Bound ${r.function.name} → ${(r.function.deployments['aws-lambda']?.details.arn as string) ?? ''}${r.warnings.map((w) => `\n  warning: ${w}`).join('')}`);
            return 0;
          }
          case 'unbind': {
            const { values, positionals } = parse(args, { target: { type: 'string' } });
            const t = target(values.target) ?? 'aws-lambda';
            await client.removeDeployment(need(positionals[0], 'function name'), t);
            out(values, { unbound: t }, () => `Removed the ${t} deployment (nothing was changed in AWS)`);
            return 0;
          }
          case 'route': {
            const { values, positionals } = parse(args, { 'default-target': { type: 'string' } });
            const t = target(values['default-target'], 'default-target');
            if (!t) throw new CliUsageError('missing --default-target');
            const f = await client.setRouting(need(positionals[0], 'function name'), t);
            out(values, f, () => `${f.name}: default target is now ${f.routing.defaultTarget}`);
            return 0;
          }
          case 'history': {
            const { values, positionals } = parse(args, { limit: { type: 'string' } });
            const r = await client.invocations(need(positionals[0], 'function name'), num(values.limit, 'limit') ?? 20);
            out(values, r, () => renderInvocations(r));
            return 0;
          }
          default:
            throw new CliUsageError('usage: xero functions list|inspect|bind|unbind|route|history');
        }
      }

      case 'aws': {
        const [sub, ...args] = rest;
        const client = await io.client();
        if (sub === 'connect') {
          const { values } = parse(args, { profile: { type: 'string' }, region: { type: 'string' } });
          const r = await client.connectAws({ region: need(values.region as string | undefined, '--region'), ...(values.profile ? { profile: values.profile as string } : {}) });
          out(values, r, () => `Connected to AWS account ${r.connection.accountId} as ${r.connection.principalArn} (${r.connection.region})\nOnly sts:GetCallerIdentity was called. Xero creates no AWS resources.${r.warnings.map((w) => `\n  warning: ${w}`).join('')}`);
          return 0;
        }
        if (sub === 'status') {
          const { values } = parse(args, {});
          const s = await client.awsStatus();
          out(values, s, () => (s.connected ? `Connected: ${s.connection?.principalArn} (${s.connection?.region}), credentials ${s.valid ? 'valid' : `NOT valid (${s.error})`}` : 'Not connected to AWS (local-only mode).'));
          return 0;
        }
        if (sub === 'disconnect') {
          const { values } = parse(args, {});
          await client.disconnectAws();
          out(values, { connected: false }, () => 'Disconnected from AWS. Event sources are stopped; local functions are unaffected.');
          return 0;
        }
        throw new CliUsageError('usage: xero aws connect|status|disconnect');
      }

      case 'events': {
        const [sub, ...args] = rest;
        const client = await io.client();
        if (sub === 'attach') {
          const { values, positionals } = parse(args, { source: { type: 'string' }, 'queue-url': { type: 'string' }, target: { type: 'string' }, 'batch-size': { type: 'string' }, 'max-in-flight': { type: 'string' }, 'visibility-extension': { type: 'string' } });
          if (values.source !== 'sqs') throw new CliUsageError('--source must be "sqs" (the only event source in v0.1)');
          const t = target(values.target);
          const bs = num(values['batch-size'], 'batch-size');
          const mf = num(values['max-in-flight'], 'max-in-flight');
          const ve = num(values['visibility-extension'], 'visibility-extension');
          const r = await client.attachEventSource({
            functionName: need(positionals[0], 'function name'), source: 'sqs', queueUrl: need(values['queue-url'] as string | undefined, '--queue-url'),
            ...(t ? { target: t } : {}), ...(bs ? { batchSize: bs } : {}), ...(mf ? { maxInFlight: mf } : {}), ...(ve !== undefined ? { visibilityExtensionSec: ve } : {}),
          });
          out(values, r, () => `Attached ${r.eventSource.queueUrl} → ${positionals[0]} (${r.eventSource.target}), id ${r.eventSource.id}\nDelivery is at-least-once: make the handler idempotent. SQS requests are billed by AWS.${r.warnings.map((w) => `\n  warning: ${w}`).join('')}`);
          return 0;
        }
        if (sub === 'list') {
          const { values } = parse(args, {});
          const r = await client.listEventSources();
          out(values, r, () => (r.length ? table(r.map((s) => [s.id, s.functionName ?? '?', s.target, s.running ? 'running' : 'stopped', s.queueUrl]), ['ID', 'FUNCTION', 'TARGET', 'STATE', 'QUEUE']) : 'No event sources.'));
          return 0;
        }
        if (sub === 'detach') {
          const { values, positionals } = parse(args, {});
          await client.detachEventSource(need(positionals[0], 'event source id'));
          out(values, { detached: positionals[0] }, () => 'Detached (the queue and its messages are untouched).');
          return 0;
        }
        throw new CliUsageError('usage: xero events attach|list|detach');
      }

      case 'metrics': {
        const { values } = parse(rest, { prometheus: { type: 'boolean' } });
        const client = await io.client();
        const m = await client.metrics();
        if (values.json) json(m);
        else {
          const fmt = (s: (typeof m.series)[number]): string[] => [s.name, Object.entries(s.labels).map(([k, v]) => `${k}=${v}`).join(','), String(s.value ?? `${s.count} obs, avg ${s.count ? Math.round((s.sum ?? 0) / s.count) : 0}`)];
          print(table(m.series.map(fmt), ['METRIC', 'LABELS', 'VALUE']));
          print(`\nworkers: ${m.workers.total} total, ${m.workers.busy} busy, ${m.workers.idle} idle`);
        }
        return 0;
      }

      case 'tokens': {
        const [sub, ...args] = rest;
        const client = await io.client();
        if (sub === 'create') {
          const { values, positionals } = parse(args, { scope: { type: 'string' } });
          const scope = values.scope;
          if (scope !== 'read' && scope !== 'invoke' && scope !== 'admin') throw new CliUsageError('--scope must be read, invoke or admin');
          const r = await client.createToken(need(positionals[0], 'token name'), scope);
          out(values, r, () => `${r.token}\n\nStore this token now: it is shown once and only its hash is kept. Scope: ${scope}. Use it as XERO_TOKEN.`);
          return 0;
        }
        if (sub === 'list') {
          const { values } = parse(args, {});
          const r = await client.listTokens();
          out(values, r, () => (r.length ? table(r.map((t) => [t.name, t.scope, t.revokedAt ? 'revoked' : 'active', new Date(t.createdAt).toISOString().slice(0, 19)]), ['NAME', 'SCOPE', 'STATE', 'CREATED']) : 'No tokens (only the master token in the Xero home exists).'));
          return 0;
        }
        if (sub === 'revoke') {
          const { values, positionals } = parse(args, {});
          await client.revokeToken(need(positionals[0], 'token name'));
          out(values, { revoked: positionals[0] }, () => 'Revoked.');
          return 0;
        }
        throw new CliUsageError('usage: xero tokens create|list|revoke');
      }

      case 'images': {
        const [sub, ...args] = rest;
        if (sub !== 'pull') throw new CliUsageError('usage: xero images pull [RUNTIME...]');
        const { values, positionals } = parse(args, {});
        const r = await (await io.client()).pullImages(positionals.length ? positionals : undefined);
        out(values, r, () => `Pulled:\n${r.pulled.map((i) => `  ${i}`).join('\n')}`);
        return 0;
      }

      case 'backup': {
        const { values } = parse(rest, {});
        const r = await (await io.client()).createBackup();
        out(values, r, () => `Backup written to ${r.path}\nArtifacts are content-addressed and are not included. Restore (controller stopped): xero-controller restore --from ${r.path}`);
        return 0;
      }

      case 'doctor': {
        const { values } = parse(rest, {});
        const r = await (await io.client()).doctor();
        out(values, r, () => r.checks.map((c) => `${c.status === 'ok' ? 'ok  ' : c.status === 'warn' ? 'WARN' : 'FAIL'}  ${clean(c.name).padEnd(17)} ${clean(c.detail)}`).join('\n'));
        return r.ok ? 0 : 1;
      }

      case 'status': {
        const { values } = parse(rest, {});
        const client = await io.client();
        const health = await client.health();
        const aws = await client.awsStatus();
        const fns = await client.listFunctions();
        out(values, { controller: health, aws, functions: fns.length }, () => `Controller ${health.version}: ${health.status}\nFunctions: ${fns.length}\nAWS: ${aws.connected ? `connected (${aws.connection?.accountId})` : 'not connected (local-only)'}`);
        return 0;
      }

      default:
        io.stderr(`unknown command "${command}"\n\n${USAGE}\n`);
        return 2;
    }
  } catch (e) {
    if (e instanceof CliUsageError) {
      io.stderr(`error: ${e.message}\n`);
      return 2;
    }
    if (e instanceof XeroApiError) {
      io.stderr(`error [${e.code}]: ${clean(e.message)}${e.requestId ? ` (request ${clean(e.requestId)})` : ''}\n`);
      return 1;
    }
    io.stderr(`error: ${clean(e instanceof Error ? e.message : String(e))}\n`);
    return 1;
  }
}
