import type { InvocationType, Target } from '@xero/specification';
import type { Deployment, InvocationSource, InvocationStatus, LogicalFunction } from '@xero/core';

export interface InvocationRequest {
  functionName: string;
  payload: Uint8Array;
  /** Explicit target; falls back to the logical function's static default. */
  target?: Target | undefined;
  invocationType?: InvocationType | undefined;
  source?: InvocationSource | undefined;
  requestId?: string | undefined;
  traceId?: string | undefined;
  signal?: AbortSignal | undefined;
}

export interface InvocationResult {
  requestId: string;
  attemptId: string;
  functionId: string;
  functionName: string;
  deploymentId: string;
  target: Target;
  status: Extract<InvocationStatus, 'succeeded' | 'function-error' | 'accepted'>;
  /** Handler result (or error document when status is function-error). Empty for async acceptance. */
  payload: Uint8Array;
  functionError: string | undefined;
  coldStart: boolean | undefined;
  awsRequestId: string | undefined;
  executedVersion: string | undefined;
  durationMs: number;
}

export interface ExecContext {
  fn: LogicalFunction;
  deployment: Deployment;
  requestId: string;
  attemptId: string;
  payload: Uint8Array;
  invocationType: InvocationType;
  traceId: string | undefined;
  signal: AbortSignal | undefined;
}

export interface ExecOutcome {
  status: 'succeeded' | 'function-error' | 'accepted';
  payload: Uint8Array;
  coldStart: boolean | undefined;
  awsRequestId: string | undefined;
  executedVersion: string | undefined;
  functionError: string | undefined;
}

/** `settled` is present for asynchronous acceptance: the caller is answered now, the final outcome is recorded later. */
export interface ExecResult extends ExecOutcome {
  settled?: Promise<ExecOutcome>;
}

export interface TargetExecutor {
  execute(ctx: ExecContext): Promise<ExecResult>;
}
