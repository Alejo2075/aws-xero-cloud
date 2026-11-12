import type { InvocationType, Routing, Runtime, Target } from '@xero/specification';

export interface LogicalFunction {
  id: string;
  name: string;
  description: string | undefined;
  routing: Routing;
  createdAt: number;
  updatedAt: number;
}

export type DeploymentStatus = 'active' | 'superseded' | 'removed';

export interface LocalConfig {
  artifactId: string;
  runtime: Runtime;
  handler: string;
  memoryMb: number;
  timeoutSec: number;
  maxConcurrency: number;
  idleTtlSec: number;
  /** Workers kept alive past the idle TTL (absent in records created before v0.1.1 = 0). */
  minWarm?: number | undefined;
  environment: Readonly<Record<string, string>>;
  awsRoleArn: string | undefined;
}

export interface ObservedLambdaConfig {
  runtime: string | undefined;
  handler: string | undefined;
  timeoutSec: number | undefined;
  memoryMb: number | undefined;
  codeSha256: string | undefined;
  version: string | undefined;
  lastModified: string | undefined;
}

export interface AwsLambdaConfig {
  mode: 'existing';
  arn: string;
  region: string;
  accountId: string;
  functionName: string;
  qualifier: string | undefined;
  verified: boolean;
  verifiedAt: number | undefined;
  observed: ObservedLambdaConfig | undefined;
}

interface DeploymentBase {
  id: string;
  functionId: string;
  version: number;
  status: DeploymentStatus;
  createdAt: number;
}
export type LocalDeployment = DeploymentBase & { target: 'local'; config: LocalConfig };
export type AwsLambdaDeployment = DeploymentBase & { target: 'aws-lambda'; config: AwsLambdaConfig };
export type Deployment = LocalDeployment | AwsLambdaDeployment;

export type NewDeployment =
  | { target: 'local'; config: LocalConfig }
  | { target: 'aws-lambda'; config: AwsLambdaConfig };

export type InvocationStatus =
  | 'succeeded'
  | 'function-error'
  | 'accepted'
  | 'timeout'
  | 'rejected'
  | 'failed'
  | 'unknown-outcome';

export type InvocationSource = 'api' | 'sqs';

export interface InvocationRecord {
  requestId: string;
  attemptId: string;
  functionId: string;
  functionName: string;
  deploymentId: string | undefined;
  target: Target;
  invocationType: InvocationType;
  source: InvocationSource;
  status: InvocationStatus;
  errorCode: string | undefined;
  coldStart: boolean | undefined;
  awsRequestId: string | undefined;
  startedAt: number;
  durationMs: number;
  payloadBytes: number;
  responseBytes: number;
  traceId: string | undefined;
}

export interface LogLine {
  functionId: string;
  deploymentId: string;
  requestId: string | undefined;
  stream: 'stdout' | 'stderr' | 'system';
  at: number;
  message: string;
}

export interface EventSource {
  id: string;
  functionId: string;
  kind: 'sqs';
  target: Target;
  queueUrl: string;
  region: string;
  batchSize: number;
  maxInFlight: number;
  visibilityExtensionSec: number;
  createdAt: number;
}

export interface AwsConnection {
  profile: string | undefined;
  region: string;
  accountId: string;
  principalArn: string;
  verifiedAt: number;
}

export interface ArtifactRef {
  id: string; // sha256:<hex>
  sizeBytes: number;
  fileCount: number;
}

/** Public API views (no environment values, no credentials). Shared by controller and SDK. */
export interface DeploymentView {
  id: string;
  target: Target;
  version: number;
  status: string;
  createdAt: number;
  details: Record<string, unknown>;
}
export interface FunctionView {
  id: string;
  name: string;
  description: string | undefined;
  routing: Routing;
  deployments: Partial<Record<Target, DeploymentView>>;
  createdAt: number;
  updatedAt: number;
}
