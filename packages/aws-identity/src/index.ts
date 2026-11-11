import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import type { AwsCredentialIdentityProvider } from '@aws-sdk/types';
import { XeroError, type CredentialIssuer, type IssuedCredentials } from '@xero/core';

export interface ConnectionTarget {
  profile?: string | undefined;
  region: string;
}

export interface VerifiedIdentity {
  accountId: string;
  arn: string;
  userId: string;
  warnings: string[];
}

export type CredentialProviderFactory = (target: ConnectionTarget) => AwsCredentialIdentityProvider;
export type StsClientFactory = (region: string, credentials: AwsCredentialIdentityProvider) => STSClient;

/** Default: the standard SDK provider chain (env, SSO, shared config/credentials, process, IMDS/ECS). Refreshable. */
export const defaultProviderFactory: CredentialProviderFactory = ({ profile }) =>
  fromNodeProviderChain(profile ? { profile } : {});

const defaultStsFactory: StsClientFactory = (region, credentials) => new STSClient({ region, credentials, maxAttempts: 2 });

/** Maps SDK failures to stable, non-leaky Xero errors. */
export function mapAwsError(e: unknown, operation: string): XeroError {
  if (e instanceof XeroError) return e;
  const err = e as { name?: string; code?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  const name = err.name ?? '';
  if (['CredentialsProviderError', 'ExpiredToken', 'ExpiredTokenException', 'TokenRefreshRequired', 'UnrecognizedClientException', 'InvalidClientTokenId', 'InvalidSignatureException'].includes(name)) {
    return new XeroError('AWS_CREDENTIALS_ERROR', `AWS credentials are missing, expired or invalid (${operation}); re-authenticate (e.g. "aws sso login")`, { awsError: name });
  }
  if (['AccessDenied', 'AccessDeniedException', 'AuthorizationError'].includes(name)) {
    return new XeroError('AWS_ACCESS_DENIED', `AWS denied ${operation}; check the IAM policy / role trust policy`, { awsError: name });
  }
  return new XeroError('AWS_REQUEST_FAILED', `AWS request failed (${operation})`, { awsError: name || err.code || 'unknown' }, { cause: e });
}

/** Heuristic warnings only; Xero cannot judge IAM policies it is not allowed to read. */
export function identityWarnings(arn: string): string[] {
  const out: string[] = [];
  if (/:root$/.test(arn)) out.push('connected as the account root user; use a least-privilege identity instead');
  if (/(^|[/_-])(admin|administrator|administratoraccess)([/_-]|$)/i.test(arn)) {
    out.push('identity looks like an administrator; Xero only needs sts:GetCallerIdentity, lambda:Invoke*, sqs:* on specific queues and sts:AssumeRole on function roles');
  }
  return out;
}

/**
 * Controller-side AWS identity. Holds the operator-selected profile/region, verifies it, and produces
 * (a) refreshable credentials for the controller's own AWS clients and (b) scoped worker credentials via AssumeRole.
 * Worker credentials are always distinct from the controller's.
 */
export class AwsIdentity implements CredentialIssuer {
  private readonly providers = new Map<string, AwsCredentialIdentityProvider>();

  constructor(
    private readonly options: {
      providerFactory?: CredentialProviderFactory;
      stsFactory?: StsClientFactory;
      /** Currently connected profile/region (owned by the controller); used when issuing worker credentials. */
      currentTarget?: () => ConnectionTarget | undefined;
    } = {},
  ) {}

  /** Credential provider for the controller's own calls (Lambda Invoke, SQS, discovery). */
  controllerCredentials(target: ConnectionTarget): AwsCredentialIdentityProvider {
    const key = `${target.profile ?? ''}|${target.region}`;
    let p = this.providers.get(key);
    if (!p) {
      p = (this.options.providerFactory ?? defaultProviderFactory)(target);
      this.providers.set(key, p);
    }
    return p;
  }

  forget(): void {
    this.providers.clear();
  }

  /** Read-only verification via sts:GetCallerIdentity. */
  async verify(target: ConnectionTarget): Promise<VerifiedIdentity> {
    try {
      const sts = (this.options.stsFactory ?? defaultStsFactory)(target.region, this.controllerCredentials(target));
      const out = await sts.send(new GetCallerIdentityCommand({}));
      if (!out.Account || !out.Arn || !out.UserId) throw new XeroError('AWS_CREDENTIALS_ERROR', 'STS returned an incomplete identity');
      return { accountId: out.Account, arn: out.Arn, userId: out.UserId, warnings: identityWarnings(out.Arn) };
    } catch (e) {
      throw mapAwsError(e, 'sts:GetCallerIdentity');
    }
  }

  /** Implements CredentialIssuer: sts:AssumeRole on an *existing* role. Never returns the controller's own credentials. */
  async issue(request: { roleArn: string; sessionName: string; durationSec: number; region: string }): Promise<IssuedCredentials> {
    const target = this.options.currentTarget?.() ?? { region: request.region };
    try {
      const sts = (this.options.stsFactory ?? defaultStsFactory)(request.region, this.controllerCredentials(target));
      const out = await sts.send(
        new AssumeRoleCommand({
          RoleArn: request.roleArn,
          RoleSessionName: request.sessionName,
          DurationSeconds: Math.min(43_200, Math.max(900, request.durationSec)),
        }),
      );
      const c = out.Credentials;
      if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken || !c.Expiration) {
        throw new XeroError('AWS_CREDENTIALS_ERROR', 'STS returned incomplete credentials');
      }
      return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken, expiresAt: c.Expiration.getTime() };
    } catch (e) {
      throw mapAwsError(e, `sts:AssumeRole ${request.roleArn}`);
    }
  }
}
