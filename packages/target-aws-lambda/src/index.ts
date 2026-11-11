import { GetFunctionConfigurationCommand, InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import type { AwsCredentialIdentityProvider } from '@aws-sdk/types';
import {
  XeroError,
  type LambdaInvokeRequest,
  type LambdaInvokeResult,
  type LambdaInvoker,
  type ObservedLambdaConfig,
} from '@xero/core';
import { MAX_PAYLOAD_BYTES } from '@xero/shared';

export interface LambdaTargetOptions {
  /** Resolved per call so a changed `aws connect` takes effect without restarting. Undefined = not connected. */
  credentials: () => AwsCredentialIdentityProvider | undefined;
  clientFactory?: (region: string, credentials: AwsCredentialIdentityProvider) => LambdaClient;
}

/** Errors that prove the request never reached Lambda (so the invocation did not run). */
const NOT_SENT = new Set(['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'CredentialsProviderError']);

export function mapLambdaError(e: unknown, operation: string, mayHaveExecuted: boolean): XeroError {
  if (e instanceof XeroError) return e;
  const err = e as { name?: string; code?: string; $metadata?: { httpStatusCode?: number; requestId?: string; attempts?: number }; $retryAfterSeconds?: number; retryAfterSeconds?: number };
  const name = err.name ?? '';
  const status = err.$metadata?.httpStatusCode;
  const meta = { awsError: name || err.code || 'unknown', ...(err.$metadata?.requestId ? { awsRequestId: err.$metadata.requestId } : {}) };
  if (['TooManyRequestsException', 'ThrottlingException', 'Throttled', 'ThrottledException', 'ProvisionedThroughputExceededException'].includes(name) || status === 429) {
    return new XeroError('AWS_THROTTLED', 'AWS Lambda throttled the request', { ...meta, retryAfterSeconds: err.retryAfterSeconds ?? err.$retryAfterSeconds ?? null });
  }
  if (name === 'ResourceNotFoundException') return new XeroError('AWS_TARGET_NOT_FOUND', 'the bound Lambda function or qualifier does not exist', meta);
  if (['AccessDeniedException', 'AccessDenied'].includes(name)) return new XeroError('AWS_ACCESS_DENIED', `AWS denied ${operation}; the connected identity lacks permission`, meta);
  if (['UnrecognizedClientException', 'ExpiredTokenException', 'InvalidSignatureException', 'CredentialsProviderError'].includes(name)) {
    return new XeroError('AWS_CREDENTIALS_ERROR', 'AWS credentials are missing, expired or invalid; re-authenticate', meta);
  }
  if (name === 'RequestTooLargeException') return new XeroError('PAYLOAD_TOO_LARGE', 'payload exceeds the Lambda invocation limit', meta);
  if (['InvalidRequestContentException', 'InvalidParameterValueException', 'UnsupportedMediaTypeException'].includes(name)) return new XeroError('PAYLOAD_INVALID', 'Lambda rejected the request payload', meta);
  if (status !== undefined && status >= 400 && status < 500) return new XeroError('AWS_REQUEST_FAILED', `Lambda rejected ${operation}`, { ...meta, httpStatus: status });
  // Lambda answered with a 5xx (e.g. ServiceException, EC2/ENI errors): it responded, but execution state is not guaranteed.
  if (status !== undefined && status >= 500) {
    return new XeroError(mayHaveExecuted ? 'UNKNOWN_OUTCOME' : 'AWS_REQUEST_FAILED', `Lambda service error during ${operation}`, { ...meta, httpStatus: status });
  }
  // No HTTP response at all.
  const code = err.code ?? name;
  if (NOT_SENT.has(code) || NOT_SENT.has(name)) return new XeroError('AWS_REQUEST_FAILED', `could not reach AWS Lambda (${operation}); the request was not sent`, meta);
  return new XeroError(mayHaveExecuted ? 'UNKNOWN_OUTCOME' : 'AWS_REQUEST_FAILED', `connection to AWS Lambda failed during ${operation}; the outcome is unknown`, meta, { cause: e });
}

/**
 * Invokes an existing native Lambda with the real Invoke API. SDK retries are disabled: a hidden retry of a possibly
 * executed, non-idempotent invocation would be a silent duplicate.
 */
export class LambdaTargetAdapter implements LambdaInvoker {
  private readonly clients = new Map<string, { client: LambdaClient; provider: AwsCredentialIdentityProvider }>();
  constructor(private readonly options: LambdaTargetOptions) {}

  private client(region: string): LambdaClient {
    const provider = this.options.credentials();
    if (!provider) throw new XeroError('AWS_NOT_CONNECTED', 'no AWS connection; run "xero aws connect"');
    const cached = this.clients.get(region);
    if (cached && cached.provider === provider) return cached.client;
    const client = this.options.clientFactory?.(region, provider) ?? new LambdaClient({ region, credentials: provider, maxAttempts: 1 });
    this.clients.set(region, { client, provider });
    return client;
  }

  async invoke(req: LambdaInvokeRequest): Promise<LambdaInvokeResult> {
    if (req.payload.byteLength > MAX_PAYLOAD_BYTES) throw new XeroError('PAYLOAD_TOO_LARGE', 'payload exceeds 6 MiB');
    const client = this.client(req.region);
    const command = new InvokeCommand({
      FunctionName: req.arn,
      InvocationType: req.invocationType,
      LogType: 'None',
      Payload: req.payload,
    });
    if (req.traceId) {
      const traceId = req.traceId;
      command.middlewareStack.add(
        (next) => async (args) => {
          const request = args.request as { headers?: Record<string, string> };
          if (request.headers) request.headers['X-Amzn-Trace-Id'] = traceId;
          return next(args);
        },
        { step: 'build', name: 'xeroTraceHeader' },
      );
    }
    try {
      const out = await client.send(command, req.signal ? { abortSignal: req.signal } : undefined);
      return {
        statusCode: out.StatusCode ?? 0,
        functionError: out.FunctionError,
        executedVersion: out.ExecutedVersion,
        awsRequestId: out.$metadata.requestId,
        payload: out.Payload ?? new Uint8Array(),
      };
    } catch (e) {
      throw mapLambdaError(e, 'lambda:InvokeFunction', true);
    }
  }

  /** Read-only discovery used by `functions bind` (lambda:GetFunctionConfiguration). */
  async describe(arn: string, region: string): Promise<ObservedLambdaConfig> {
    try {
      const out = await this.client(region).send(new GetFunctionConfigurationCommand({ FunctionName: arn }));
      return {
        runtime: out.Runtime,
        handler: out.Handler,
        timeoutSec: out.Timeout,
        memoryMb: out.MemorySize,
        codeSha256: out.CodeSha256,
        version: out.Version,
        lastModified: out.LastModified,
      };
    } catch (e) {
      throw mapLambdaError(e, 'lambda:GetFunctionConfiguration', false);
    }
  }
}
