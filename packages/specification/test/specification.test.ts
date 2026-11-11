import { describe, expect, it } from 'vitest';
import {
  attachEventSourceRequestSchema,
  deployLocalRequestSchema,
  environmentSchema,
  handlerSchema,
  manifestSchema,
  parseLambdaArn,
  parseQueueUrl,
  roleArnSchema,
  runtimeFamily,
} from '../src/index.js';

describe('lambda ARN', () => {
  it('parses qualified and unqualified ARNs', () => {
    expect(parseLambdaArn('arn:aws:lambda:us-east-1:123456789012:function:hello:live')).toEqual({
      partition: 'aws', region: 'us-east-1', accountId: '123456789012', functionName: 'hello', qualifier: 'live',
    });
    expect(parseLambdaArn('arn:aws:lambda:eu-west-2:123456789012:function:hello')?.qualifier).toBeUndefined();
  });
  it('rejects look-alikes', () => {
    for (const bad of ['', 'arn:aws:lambda:us-east-1:123:function:x', 'arn:aws:s3:::bucket', 'http://169.254.169.254/', 'arn:aws:lambda:us-east-1:123456789012:layer:x:1'])
      expect(parseLambdaArn(bad)).toBeUndefined();
  });
});

describe('queue url', () => {
  it('accepts AWS SQS urls only', () => {
    expect(parseQueueUrl('https://sqs.us-east-1.amazonaws.com/123456789012/orders')).toEqual({ region: 'us-east-1', accountId: '123456789012', queueName: 'orders' });
    expect(parseQueueUrl('https://sqs.us-east-1.amazonaws.com/123456789012/orders.fifo')?.queueName).toBe('orders.fifo');
    expect(parseQueueUrl('http://localhost:9324/000000000000/q')).toBeUndefined();
    expect(parseQueueUrl('https://evil.example.com/123456789012/orders')).toBeUndefined();
  });
});

describe('handler / env / role', () => {
  it('validates handlers', () => {
    expect(handlerSchema.safeParse('index.handler').success).toBe(true);
    expect(handlerSchema.safeParse('src/app.main').success).toBe(true);
    expect(handlerSchema.safeParse('../x.handler').success).toBe(false);
    expect(handlerSchema.safeParse('nodots').success).toBe(false);
  });
  it('rejects reserved env names', () => {
    expect(environmentSchema.safeParse({ TABLE: 'x' }).success).toBe(true);
    expect(environmentSchema.safeParse({ AWS_ACCESS_KEY_ID: 'x' }).success).toBe(false);
    expect(environmentSchema.safeParse({ XERO_HOME: 'x' }).success).toBe(false);
    expect(environmentSchema.safeParse({ '1BAD': 'x' }).success).toBe(false);
  });
  it('validates role arns', () => {
    expect(roleArnSchema.safeParse('arn:aws:iam::123456789012:role/xero-fn').success).toBe(true);
    expect(roleArnSchema.safeParse('arn:aws:iam::123456789012:user/bob').success).toBe(false);
  });
});

describe('manifest', () => {
  it('applies defaults and is strict', () => {
    const m = manifestSchema.parse({
      apiVersion: 'xero.dev/v1alpha1', kind: 'Function', metadata: { name: 'p' },
      spec: { runtime: 'nodejs22.x', handler: 'index.handler', deployments: { local: {} } },
    });
    expect(m.spec.deployments.local).toMatchObject({ memoryMb: 128, timeoutSec: 3, maxConcurrency: 2, idleTtlSec: 60, artifact: '.' });
    expect(() => manifestSchema.parse({ ...m, extra: 1 })).toThrow();
  });
  it('rejects unsupported runtimes', () => {
    expect(deployLocalRequestSchema.safeParse({ name: 'a', runtime: 'ruby3.3', handler: 'a.b', sourcePath: '/x' }).success).toBe(false);
  });
});

describe('misc', () => {
  it('runtime family', () => {
    expect(runtimeFamily('nodejs22.x')).toBe('nodejs');
    expect(runtimeFamily('python3.13')).toBe('python');
    expect(runtimeFamily('java21')).toBeUndefined();
  });
  it('event source defaults', () => {
    const r = attachEventSourceRequestSchema.parse({ functionName: 'a', source: 'sqs', queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/q' });
    expect(r).toMatchObject({ target: 'local', batchSize: 10, maxInFlight: 1 });
  });
});
