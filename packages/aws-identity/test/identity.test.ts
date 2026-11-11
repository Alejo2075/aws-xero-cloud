import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AwsIdentity, identityWarnings, mapAwsError } from '../src/index.js';

const sts = mockClient(STSClient);
const fakeCreds = async () => ({ accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'controller-secret-never-injected' });
const identity = () => new AwsIdentity({ providerFactory: () => fakeCreds });

beforeEach(() => sts.reset());
afterEach(() => sts.reset());

describe('AwsIdentity.verify', () => {
  it('returns the caller identity from sts:GetCallerIdentity only', async () => {
    sts.on(GetCallerIdentityCommand).resolves({ Account: '123456789012', Arn: 'arn:aws:iam::123456789012:user/dev', UserId: 'AID' });
    const id = await identity().verify({ profile: 'development', region: 'us-east-1' });
    expect(id).toEqual({ accountId: '123456789012', arn: 'arn:aws:iam::123456789012:user/dev', userId: 'AID', warnings: [] });
    expect(sts.calls()).toHaveLength(1);
  });

  it('maps expired / missing credentials to AWS_CREDENTIALS_ERROR without leaking details', async () => {
    sts.on(GetCallerIdentityCommand).rejects(Object.assign(new Error('The security token included in the request is expired SECRETDETAIL'), { name: 'ExpiredToken' }));
    const err = await identity().verify({ region: 'us-east-1' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'AWS_CREDENTIALS_ERROR' });
    expect(JSON.stringify(err)).not.toContain('SECRETDETAIL');
  });

  it('warns about root and administrator identities', () => {
    expect(identityWarnings('arn:aws:iam::123456789012:root')).toHaveLength(1);
    expect(identityWarnings('arn:aws:sts::123456789012:assumed-role/AdministratorAccess/me')).toHaveLength(1);
    expect(identityWarnings('arn:aws:iam::123456789012:user/xero')).toEqual([]);
  });

  it('uses the selected profile for provider resolution and caches it', async () => {
    const seen: unknown[] = [];
    const id = new AwsIdentity({ providerFactory: (t) => { seen.push(t); return fakeCreds; } });
    sts.on(GetCallerIdentityCommand).resolves({ Account: '123456789012', Arn: 'arn:aws:iam::123456789012:user/dev', UserId: 'A' });
    await id.verify({ profile: 'dev', region: 'us-east-1' });
    await id.verify({ profile: 'dev', region: 'us-east-1' });
    expect(seen).toEqual([{ profile: 'dev', region: 'us-east-1' }]);
  });
});

describe('AwsIdentity.issue (worker credentials)', () => {
  it('assumes the named existing role and returns only the temporary credentials', async () => {
    const exp = new Date(Date.now() + 3600_000);
    sts.on(AssumeRoleCommand).resolves({ Credentials: { AccessKeyId: 'ASIATEMP', SecretAccessKey: 'tmp-secret', SessionToken: 'tmp-token', Expiration: exp } });
    const c = await identity().issue({ roleArn: 'arn:aws:iam::123456789012:role/xero-fn', sessionName: 'xero-fn', durationSec: 3600, region: 'us-east-1' });
    expect(c).toEqual({ accessKeyId: 'ASIATEMP', secretAccessKey: 'tmp-secret', sessionToken: 'tmp-token', expiresAt: exp.getTime() });
    expect(JSON.stringify(c)).not.toContain('controller-secret');
    expect(sts.commandCalls(AssumeRoleCommand)[0]!.args[0].input).toMatchObject({ RoleArn: 'arn:aws:iam::123456789012:role/xero-fn', RoleSessionName: 'xero-fn', DurationSeconds: 3600 });
  });

  it('clamps the session duration to STS limits', async () => {
    sts.on(AssumeRoleCommand).resolves({ Credentials: { AccessKeyId: 'a', SecretAccessKey: 'b', SessionToken: 'c', Expiration: new Date() } });
    await identity().issue({ roleArn: 'arn:aws:iam::123456789012:role/r', sessionName: 's', durationSec: 10, region: 'us-east-1' });
    expect(sts.commandCalls(AssumeRoleCommand)[0]!.args[0].input.DurationSeconds).toBe(900);
  });

  it('maps AccessDenied to AWS_ACCESS_DENIED and rejects incomplete responses', async () => {
    sts.on(AssumeRoleCommand).rejects(Object.assign(new Error('not authorized'), { name: 'AccessDenied' }));
    await expect(identity().issue({ roleArn: 'arn:aws:iam::123456789012:role/r', sessionName: 's', durationSec: 900, region: 'us-east-1' })).rejects.toMatchObject({ code: 'AWS_ACCESS_DENIED' });
    sts.reset();
    sts.on(AssumeRoleCommand).resolves({ Credentials: { AccessKeyId: 'a' } as never });
    await expect(identity().issue({ roleArn: 'arn:aws:iam::123456789012:role/r', sessionName: 's', durationSec: 900, region: 'us-east-1' })).rejects.toMatchObject({ code: 'AWS_CREDENTIALS_ERROR' });
  });

  it('mapAwsError falls back to AWS_REQUEST_FAILED', () => {
    expect(mapAwsError(new Error('x'), 'op')).toMatchObject({ code: 'AWS_REQUEST_FAILED' });
  });
});

describe('AwsIdentity.issue profile selection', () => {
  it('uses the connected profile for the controller credentials that call AssumeRole', async () => {
    const seen: unknown[] = [];
    const id = new AwsIdentity({ providerFactory: (t) => { seen.push(t); return fakeCreds; }, currentTarget: () => ({ profile: 'development', region: 'us-east-1' }) });
    sts.on(AssumeRoleCommand).resolves({ Credentials: { AccessKeyId: 'a', SecretAccessKey: 'b', SessionToken: 'c', Expiration: new Date() } });
    await id.issue({ roleArn: 'arn:aws:iam::123456789012:role/r', sessionName: 's', durationSec: 900, region: 'us-east-1' });
    expect(seen).toEqual([{ profile: 'development', region: 'us-east-1' }]);
  });
});
