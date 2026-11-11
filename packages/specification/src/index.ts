import { z } from 'zod';

export const API_VERSION = 'xero.dev/v1alpha1' as const;

export const RUNTIMES = ['nodejs20.x', 'nodejs22.x', 'python3.12', 'python3.13'] as const;
export type Runtime = (typeof RUNTIMES)[number];
export type RuntimeFamily = 'nodejs' | 'python';
export const TARGETS = ['local', 'aws-lambda'] as const;
export type Target = (typeof TARGETS)[number];

export function runtimeFamily(runtime: string): RuntimeFamily | undefined {
  if (runtime.startsWith('nodejs')) return 'nodejs';
  if (runtime.startsWith('python')) return 'python';
  return undefined;
}

export const functionNameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-_]{0,63}$/, 'invalid function name');
export const runtimeSchema = z.enum(RUNTIMES);
export const targetSchema = z.enum(TARGETS);
export const handlerSchema = z
  .string()
  .max(128)
  .regex(/^[A-Za-z0-9_./-]+\.[A-Za-z_$][A-Za-z0-9_$.]*$/, 'handler must look like "file.export"')
  .refine((h) => !h.includes('..') && !h.startsWith('/'), 'handler must not traverse paths');

const RESERVED_ENV = /^(AWS_|XERO_|_)/i;
export const environmentSchema = z
  .record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'invalid environment variable name'), z.string().max(4096))
  .superRefine((env, ctx) => {
    let total = 0;
    for (const [k, v] of Object.entries(env)) {
      if (RESERVED_ENV.test(k)) ctx.addIssue({ code: 'custom', message: `environment variable ${k} is reserved` });
      total += k.length + v.length;
    }
    if (total > 4096) ctx.addIssue({ code: 'custom', message: 'environment exceeds 4 KiB' });
  });

export const roleArnSchema = z.string().regex(/^arn:aws(?:-[a-z]+)*:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/, 'invalid IAM role ARN');

const LAMBDA_ARN = /^arn:(aws(?:-[a-z]+)*):lambda:([a-z]{2}(?:-[a-z]+)+-\d):(\d{12}):function:([A-Za-z0-9-_]{1,64})(?::([A-Za-z0-9-_$]{1,128}))?$/;
export const lambdaArnSchema = z.string().regex(LAMBDA_ARN, 'invalid Lambda function ARN');
export interface ParsedLambdaArn {
  partition: string;
  region: string;
  accountId: string;
  functionName: string;
  qualifier: string | undefined;
}
export function parseLambdaArn(arn: string): ParsedLambdaArn | undefined {
  const m = LAMBDA_ARN.exec(arn);
  if (!m) return undefined;
  return { partition: m[1]!, region: m[2]!, accountId: m[3]!, functionName: m[4]!, qualifier: m[5] };
}

const QUEUE_URL = /^https:\/\/sqs\.([a-z]{2}(?:-[a-z]+)+-\d)\.amazonaws\.com(?:\.cn)?\/(\d{12})\/([A-Za-z0-9-_]{1,80}(?:\.fifo)?)$/;
export const queueUrlSchema = z.string().regex(QUEUE_URL, 'invalid SQS queue URL');
export function parseQueueUrl(url: string): { region: string; accountId: string; queueName: string } | undefined {
  const m = QUEUE_URL.exec(url);
  return m ? { region: m[1]!, accountId: m[2]!, queueName: m[3]! } : undefined;
}

export const localDeploymentSpecSchema = z
  .object({
    artifact: z.string().min(1).default('.'),
    memoryMb: z.number().int().min(128).max(3008).default(128),
    timeoutSec: z.number().int().min(1).max(900).default(3),
    maxConcurrency: z.number().int().min(1).max(100).default(2),
    idleTtlSec: z.number().int().min(0).max(3600).default(60),
    environment: environmentSchema.default({}),
    awsRoleArn: roleArnSchema.optional(),
  })
  .strict();
export type LocalDeploymentSpec = z.infer<typeof localDeploymentSpecSchema>;

export const awsLambdaDeploymentSpecSchema = z.object({ mode: z.literal('existing'), arn: lambdaArnSchema }).strict();
export type AwsLambdaDeploymentSpec = z.infer<typeof awsLambdaDeploymentSpecSchema>;

export const routingSchema = z.object({ strategy: z.literal('manual').default('manual'), defaultTarget: targetSchema.default('local') }).strict();
export type Routing = z.infer<typeof routingSchema>;

export const manifestSchema = z
  .object({
    apiVersion: z.literal(API_VERSION),
    kind: z.literal('Function'),
    metadata: z.object({ name: functionNameSchema, description: z.string().max(256).optional() }).strict(),
    spec: z
      .object({
        runtime: runtimeSchema,
        handler: handlerSchema,
        deployments: z
          .object({ local: localDeploymentSpecSchema.optional(), 'aws-lambda': awsLambdaDeploymentSpecSchema.optional() })
          .strict()
          .default({}),
        routing: routingSchema.optional(),
      })
      .strict(),
  })
  .strict();
export type FunctionManifest = z.infer<typeof manifestSchema>;

export const invocationTypeSchema = z.enum(['RequestResponse', 'Event']);
export type InvocationType = z.infer<typeof invocationTypeSchema>;

export const deployLocalRequestSchema = z
  .object({
    name: functionNameSchema,
    runtime: runtimeSchema,
    handler: handlerSchema,
    sourcePath: z.string().min(1),
    description: z.string().max(256).optional(),
    memoryMb: localDeploymentSpecSchema.shape.memoryMb.optional(),
    timeoutSec: localDeploymentSpecSchema.shape.timeoutSec.optional(),
    maxConcurrency: localDeploymentSpecSchema.shape.maxConcurrency.optional(),
    idleTtlSec: localDeploymentSpecSchema.shape.idleTtlSec.optional(),
    environment: environmentSchema.optional(),
    awsRoleArn: roleArnSchema.optional(),
    defaultTarget: targetSchema.optional(),
  })
  .strict();
export type DeployLocalRequest = z.infer<typeof deployLocalRequestSchema>;

export const bindAwsLambdaRequestSchema = z
  .object({ arn: lambdaArnSchema, verify: z.boolean().default(true), defaultTarget: targetSchema.optional() })
  .strict();
export type BindAwsLambdaRequest = z.infer<typeof bindAwsLambdaRequestSchema>;

export const attachEventSourceRequestSchema = z
  .object({
    functionName: functionNameSchema,
    source: z.literal('sqs'),
    queueUrl: queueUrlSchema,
    target: targetSchema.default('local'),
    batchSize: z.number().int().min(1).max(10).default(10),
    maxInFlight: z.number().int().min(1).max(10).default(1),
    visibilityExtensionSec: z.number().int().min(0).max(43200).default(0),
  })
  .strict();
export type AttachEventSourceRequest = z.infer<typeof attachEventSourceRequestSchema>;

export const awsConnectionRequestSchema = z
  .object({ profile: z.string().min(1).max(128).optional(), region: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/) })
  .strict();
export type AwsConnectionRequest = z.infer<typeof awsConnectionRequestSchema>;
