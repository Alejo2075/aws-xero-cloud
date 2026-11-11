# ADR 0003: AWS identity and permission model

Status: Accepted (v0.1)

**Decision.** The controller uses the operator's selected profile through the AWS SDK credential-provider chain (read-only verification, Lambda Invoke, SQS polling). Worker credentials are obtained separately by `sts:AssumeRole` on an *existing* per-function role (`awsRoleArn`), with an inline session policy ceiling optional, duration >= 15 min, refreshed by recycling the worker before expiry. Without a role, workers get no AWS credentials. Controller credentials are never injected. No long-lived keys by default; IAM Roles Anywhere / OIDC federation are the recommended production path for long-running on-prem hosts (the `CredentialIssuer` port allows adding it).
**Consequences.** Operators create roles themselves; Xero documents required trust and permission policies.
