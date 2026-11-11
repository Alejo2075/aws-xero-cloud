import { XeroError, type AwsLambdaDeployment, type FunctionRegistry, type LambdaInvoker, type Metrics } from '@xero/core';
import type { ExecContext, ExecResult, TargetExecutor } from './types.js';

export interface AwsLambdaExecutorOptions {
  registry: FunctionRegistry;
  /** Resolved lazily so purely local installations never construct an AWS client. */
  invoker: () => LambdaInvoker;
  metrics?: Metrics | undefined;
}

/**
 * Invokes the bound, existing native Lambda through the real Invoke API. AWS semantics are preserved:
 * FunctionError is surfaced as a function-error status, never hidden behind a success code.
 */
export class AwsLambdaTargetExecutor implements TargetExecutor {
  constructor(private readonly o: AwsLambdaExecutorOptions) {}

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const dep = ctx.deployment as AwsLambdaDeployment;
    if (!this.o.registry.getAwsConnection()) {
      throw new XeroError('AWS_NOT_CONNECTED', 'invoking an aws-lambda target requires "xero aws connect"');
    }
    this.o.metrics?.inc('aws_requests_total', { operation: 'lambda:Invoke', function: ctx.fn.name });
    const res = await this.o.invoker().invoke({
      arn: dep.config.arn,
      region: dep.config.region,
      payload: ctx.payload,
      invocationType: ctx.invocationType,
      signal: ctx.signal,
      traceId: ctx.traceId,
    });
    const accepted = ctx.invocationType === 'Event';
    return {
      status: accepted ? 'accepted' : res.functionError ? 'function-error' : 'succeeded',
      payload: res.payload,
      coldStart: undefined,
      awsRequestId: res.awsRequestId,
      executedVersion: res.executedVersion,
      functionError: res.functionError,
    };
  }
}
