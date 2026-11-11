import {
  XeroError,
  isXeroError,
  type FunctionRegistry,
  type InvocationRecord,
  type InvocationStatus,
  type Logger,
  type Metrics,
} from '@xero/core';
import { MAX_PAYLOAD_BYTES, newId, systemClock, type Clock, type IdGenerator } from '@xero/shared';
import type { Target } from '@xero/specification';
import type { ExecOutcome, InvocationRequest, InvocationResult, TargetExecutor } from './types.js';

export interface RouterOptions {
  registry: FunctionRegistry;
  executors: Record<Target, TargetExecutor>;
  clock?: Clock;
  ids?: IdGenerator;
  metrics?: Metrics | undefined;
  logger?: Logger | undefined;
}

const REJECTED = new Set(['CAPACITY_EXHAUSTED', 'AWS_THROTTLED', 'AWS_ACCESS_DENIED', 'AWS_NOT_CONNECTED', 'AWS_TARGET_NOT_FOUND', 'TARGET_NOT_DEPLOYED', 'PAYLOAD_TOO_LARGE', 'PAYLOAD_INVALID', 'INCOMPATIBLE_TARGET']);

function statusForError(code: string): InvocationStatus {
  if (code === 'INVOCATION_TIMEOUT') return 'timeout';
  if (code === 'UNKNOWN_OUTCOME') return 'unknown-outcome';
  if (REJECTED.has(code)) return 'rejected';
  return 'failed';
}

/**
 * Resolves logical function -> exactly one target for this attempt (explicit or static default), executes, and
 * records the attempt. There is no fallback, failover or retry: a failed or unknown attempt is reported, never replayed.
 */
export class InvocationRouter {
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  constructor(private readonly o: RouterOptions) {
    this.clock = o.clock ?? systemClock;
    this.ids = o.ids ?? newId;
  }

  async invoke(req: InvocationRequest): Promise<InvocationResult> {
    const { registry } = this.o;
    const fn = registry.getFunctionByName(req.functionName);
    if (!fn) throw new XeroError('FUNCTION_NOT_FOUND', `function "${req.functionName}" not found`);

    const requestId = req.requestId ?? this.ids('req');
    const attemptId = this.ids('att');
    const startedAt = this.clock.now();
    const target = req.target ?? fn.routing.defaultTarget;
    const invocationType = req.invocationType ?? 'RequestResponse';
    const payload = req.payload.byteLength === 0 ? new TextEncoder().encode('{}') : req.payload;
    const log = this.o.logger?.child({ requestId, attemptId, functionId: fn.id, target });

    const base: InvocationRecord = {
      requestId, attemptId, functionId: fn.id, functionName: fn.name, deploymentId: undefined, target, invocationType,
      source: req.source ?? 'api', status: 'failed', errorCode: undefined, coldStart: undefined, awsRequestId: undefined,
      startedAt, durationMs: 0, payloadBytes: payload.byteLength, responseBytes: 0, traceId: req.traceId,
    };
    const finish = (patch: Partial<InvocationRecord>): void => {
      const rec = { ...base, ...patch, durationMs: this.clock.now() - startedAt };
      try {
        registry.recordInvocation(rec);
      } catch (e) {
        log?.error('failed to record invocation', { error: e });
      }
      this.o.metrics?.inc('invocations_total', { target, outcome: rec.status });
      this.o.metrics?.observe('invocation_duration_ms', rec.durationMs, { target });
      if (rec.coldStart !== undefined) log?.info('invocation finished', { status: rec.status, coldStart: rec.coldStart, durationMs: rec.durationMs, deploymentId: rec.deploymentId, errorCode: rec.errorCode });
      else log?.info('invocation finished', { status: rec.status, durationMs: rec.durationMs, deploymentId: rec.deploymentId, errorCode: rec.errorCode });
    };
    const fail = (e: unknown, deploymentId?: string): never => {
      const err = isXeroError(e) ? e : new XeroError('INTERNAL', 'internal error', undefined, { cause: e });
      if (!isXeroError(e)) log?.error('unexpected invocation error', { error: e });
      finish({ status: statusForError(err.code), errorCode: err.code, deploymentId });
      throw err;
    };

    try {
      if (payload.byteLength > MAX_PAYLOAD_BYTES) throw new XeroError('PAYLOAD_TOO_LARGE', 'request payload exceeds 6 MiB');
      try {
        JSON.parse(new TextDecoder().decode(payload));
      } catch {
        throw new XeroError('PAYLOAD_INVALID', 'payload must be valid JSON');
      }
    } catch (e) {
      return fail(e);
    }

    const deployment = registry.getActiveDeployment(fn.id, target);
    if (!deployment) {
      return fail(new XeroError('TARGET_NOT_DEPLOYED', `function "${fn.name}" has no active ${target} deployment`, { target, defaultTarget: fn.routing.defaultTarget }));
    }

    let result;
    try {
      result = await this.o.executors[target].execute({
        fn, deployment, requestId, attemptId, payload, invocationType, traceId: req.traceId, signal: req.signal,
      });
    } catch (e) {
      return fail(e, deployment.id);
    }

    const record = (o: ExecOutcome): Partial<InvocationRecord> => ({
      deploymentId: deployment.id, status: o.status, coldStart: o.coldStart, awsRequestId: o.awsRequestId, responseBytes: o.payload.byteLength,
      errorCode: o.functionError,
    });
    if (result.settled) {
      // Asynchronous acceptance: answer now, record the real outcome when it settles.
      finish({ ...record(result), status: 'accepted' });
      result.settled.then(
        (o) => this.o.registry.recordInvocation({ ...base, ...record(o), attemptId: `${attemptId}.run`, durationMs: this.clock.now() - startedAt }),
        (e: unknown) => {
          const code = isXeroError(e) ? e.code : 'INTERNAL';
          this.o.registry.recordInvocation({ ...base, deploymentId: deployment.id, attemptId: `${attemptId}.run`, status: statusForError(code), errorCode: code, durationMs: this.clock.now() - startedAt });
          this.o.metrics?.inc('invocations_total', { target, outcome: statusForError(code) });
        },
      );
    } else finish(record(result));

    return {
      requestId, attemptId, functionId: fn.id, functionName: fn.name, deploymentId: deployment.id, target,
      status: result.status, payload: result.payload, functionError: result.functionError, coldStart: result.coldStart,
      awsRequestId: result.awsRequestId, executedVersion: result.executedVersion, durationMs: this.clock.now() - startedAt,
    };
  }
}
