import { GetFunctionConfigurationCommand, InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { LambdaTargetAdapter } from '../src/index.js';

const lambda = mockClient(LambdaClient);
const creds = async () => ({ accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 's' });
const adapter = (connected = true) => new LambdaTargetAdapter({ credentials: () => (connected ? creds : undefined) });
const ARN = 'arn:aws:lambda:us-east-1:123456789012:function:hello:live';
const enc = (s: string) => new TextEncoder().encode(s);
const req = (over = {}) => ({ arn: ARN, region: 'us-east-1', payload: enc('{"name":"Ada"}'), invocationType: 'RequestResponse' as const, ...over });
const awsErr = (name: string, status?: number, extra: object = {}) => Object.assign(new Error(name), { name, ...(status ? { $metadata: { httpStatusCode: status, requestId: 'req-1' } } : {}), ...extra });

beforeEach(() => lambda.reset());

describe('Invoke request formation', () => {
  it('sends the qualified ARN, InvocationType, payload and no log tail', async () => {
    lambda.on(InvokeCommand).resolves({ StatusCode: 200, Payload: enc('{"ok":true}') as never, ExecutedVersion: '12', $metadata: { requestId: 'aws-1' } });
    const r = await adapter().invoke(req());
    const input = lambda.commandCalls(InvokeCommand)[0]!.args[0].input;
    expect(input).toMatchObject({ FunctionName: ARN, InvocationType: 'RequestResponse', LogType: 'None' });
    expect(Buffer.from(input.Payload as Uint8Array).toString()).toBe('{"name":"Ada"}');
    expect(r).toMatchObject({ statusCode: 200, functionError: undefined, executedVersion: '12', awsRequestId: 'aws-1' });
    expect(new TextDecoder().decode(r.payload)).toBe('{"ok":true}');
  });

  it('supports async invocation (Event) acceptance semantics', async () => {
    lambda.on(InvokeCommand).resolves({ StatusCode: 202, $metadata: {} });
    const r = await adapter().invoke(req({ invocationType: 'Event' }));
    expect(lambda.commandCalls(InvokeCommand)[0]!.args[0].input.InvocationType).toBe('Event');
    expect(r.statusCode).toBe(202);
    expect(r.payload.byteLength).toBe(0);
  });

  it('disables SDK retries and targets the ARN region', async () => {
    let seen: { region: string } | undefined;
    const a = new LambdaTargetAdapter({
      credentials: () => creds,
      clientFactory: (region, credentials) => { seen = { region }; return new LambdaClient({ region, credentials, maxAttempts: 1 }); },
    });
    lambda.on(InvokeCommand).resolves({ StatusCode: 200, $metadata: {} });
    await a.invoke(req({ region: 'eu-west-3' }));
    expect(seen).toEqual({ region: 'eu-west-3' });
  });

  it('refuses oversized payloads and unconnected use before calling AWS', async () => {
    await expect(adapter().invoke(req({ payload: new Uint8Array(6 * 1024 * 1024 + 1) }))).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    await expect(adapter(false).invoke(req())).rejects.toMatchObject({ code: 'AWS_NOT_CONNECTED' });
    expect(lambda.calls()).toHaveLength(0);
  });
});

describe('FunctionError is preserved, never hidden', () => {
  it('returns 200 + FunctionError as data', async () => {
    lambda.on(InvokeCommand).resolves({ StatusCode: 200, FunctionError: 'Unhandled', Payload: enc('{"errorMessage":"boom"}') as never, $metadata: {} });
    const r = await adapter().invoke(req());
    expect(r.statusCode).toBe(200);
    expect(r.functionError).toBe('Unhandled');
  });
});

describe('API error mapping', () => {
  const cases: Array<[string, Error, string]> = [
    ['throttling', awsErr('TooManyRequestsException', 429, { retryAfterSeconds: 3 }), 'AWS_THROTTLED'],
    ['throttling by status', awsErr('SomethingElse', 429), 'AWS_THROTTLED'],
    ['denied', awsErr('AccessDeniedException', 403), 'AWS_ACCESS_DENIED'],
    ['missing function', awsErr('ResourceNotFoundException', 404), 'AWS_TARGET_NOT_FOUND'],
    ['expired token', awsErr('ExpiredTokenException', 403), 'AWS_CREDENTIALS_ERROR'],
    ['too large', awsErr('RequestTooLargeException', 413), 'PAYLOAD_TOO_LARGE'],
    ['bad payload', awsErr('InvalidRequestContentException', 400), 'PAYLOAD_INVALID'],
    ['service 5xx', awsErr('ServiceException', 500), 'UNKNOWN_OUTCOME'],
    ['connection reset after dispatch', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), 'UNKNOWN_OUTCOME'],
    ['timeout', awsErr('TimeoutError'), 'UNKNOWN_OUTCOME'],
    ['dns failure (never sent)', Object.assign(new Error('x'), { code: 'ENOTFOUND' }), 'AWS_REQUEST_FAILED'],
    ['connection refused (never sent)', Object.assign(new Error('x'), { code: 'ECONNREFUSED' }), 'AWS_REQUEST_FAILED'],
  ];
  it.each(cases)('%s -> %s', async (_n, error, code) => {
    lambda.on(InvokeCommand).rejects(error);
    await expect(adapter().invoke(req())).rejects.toMatchObject({ code });
  });

  it('exposes retry-after and request id without leaking raw messages', async () => {
    lambda.on(InvokeCommand).rejects(awsErr('TooManyRequestsException', 429, { retryAfterSeconds: 3, message: 'arn:aws:... SECRET' }));
    const e = await adapter().invoke(req()).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'AWS_THROTTLED', details: { retryAfterSeconds: 3, awsRequestId: 'req-1' } });
    expect(JSON.stringify(e)).not.toContain('SECRET');
  });
});

describe('describe (read-only discovery)', () => {
  it('maps GetFunctionConfiguration to observed config', async () => {
    lambda.on(GetFunctionConfigurationCommand).resolves({ Runtime: 'nodejs22.x', Handler: 'index.handler', Timeout: 10, MemorySize: 256, CodeSha256: 'abc=', Version: '3', LastModified: '2026-01-01T00:00:00.000+0000' });
    const o = await adapter().describe(ARN, 'us-east-1');
    expect(lambda.commandCalls(GetFunctionConfigurationCommand)[0]!.args[0].input).toEqual({ FunctionName: ARN });
    expect(o).toMatchObject({ runtime: 'nodejs22.x', handler: 'index.handler', timeoutSec: 10, memoryMb: 256, codeSha256: 'abc=', version: '3' });
  });
  it('discovery failures are never UNKNOWN_OUTCOME', async () => {
    lambda.on(GetFunctionConfigurationCommand).rejects(Object.assign(new Error('x'), { code: 'ECONNRESET' }));
    await expect(adapter().describe(ARN, 'us-east-1')).rejects.toMatchObject({ code: 'AWS_REQUEST_FAILED' });
    lambda.reset();
    lambda.on(GetFunctionConfigurationCommand).rejects(awsErr('AccessDeniedException', 403));
    await expect(adapter().describe(ARN, 'us-east-1')).rejects.toMatchObject({ code: 'AWS_ACCESS_DENIED' });
  });
});
