# Xero

> Your hardware. Your Lambdas. One cloud experience.

Xero is an open-source, self-hosted runtime that runs **AWS Lambda-style functions** on a machine you own and
interoperates with **native AWS Lambda** and real AWS services.

- **Local-first.** No AWS account, no Kubernetes. Functions run in isolated, resource-limited containers on one host.
- **Hybrid by design.** One *logical function* can have a `local` deployment and an `aws-lambda` deployment. You pick the
  target per invocation, or set a fixed default. Routing is explicit and deterministic.
- **AWS-native interoperability.** Local handlers use the real AWS SDK. Xero calls *existing* Lambdas through the real
  `Invoke` API. An opt-in, outbound-only SQS poller delivers AWS events to local handlers.
- **Functions only.** Xero does not implement S3, DynamoDB, SQS, IAM or any other AWS service, and does not create AWS
  resources.
- **Independent.** Apache-2.0, no hosted control plane, no mandatory account, AI never sits in the dispatch path.

> **Status: v0.1, pre-release.** Local execution is verified on a real container engine; the AWS integration is verified
> with mocks only. Read [Project status](#project-status) before relying on it.

## What Xero is not

Compatibility claims are deliberately narrow:

- A local execution is **not** an AWS Lambda instance. The same logical function is two separate physical deployments that
  can differ in code, runtime, network, IAM identity, limits and cost.
- Xero **cannot** make a native Lambda ARN, alias, or event-source mapping route to your machine, and it cannot intercept
  `LambdaClient.Invoke(arn)` calls made by other code. Integration goes through a Xero API/SDK call, an explicit bridge, or
  the SQS adapter.
- Routing decides *per invocation*. A running invocation is never split or migrated, and a failed or unknown attempt is
  never silently retried on the other target.
- There is no support for Lambda layers, extensions, SnapStart or full Runtime API parity. The tested subset is documented in
  [`docs/architecture/runtime-compatibility.md`](docs/architecture/runtime-compatibility.md).

## Quick start (local, no AWS)

Requirements: Node.js >= 24, pnpm 9, and a Docker-compatible engine. On macOS use Docker Desktop, OrbStack, or Colima
(`brew install colima && colima start --vm-type vz`; keep `XERO_HOME` under `$HOME`, see the
[guide](docs/guides/getting-started.md)).

```bash
pnpm install && pnpm build

# 1. Start the controller (listens on 127.0.0.1 only; state in ~/.xero)
node apps/controller/dist/main.js &

# 2. Deploy, invoke, inspect
xero() { node apps/cli/dist/main.js "$@"; }         # or `pnpm link --global` in apps/cli
xero deploy ./examples/node-hello
xero invoke hello --payload '{"name":"Ada"}'
xero logs hello
xero functions inspect hello
xero doctor
```

The first invocation is a cold start (and pulls the AWS Lambda base image; `xero images pull` does that ahead of time).
Later invocations reuse a warm worker until the idle TTL expires, after which no worker is running (scale to zero).

A function directory may contain a `xero.yaml` manifest (schema `xero.dev/v1alpha1`, not frozen yet); CLI flags override it:

```yaml
apiVersion: xero.dev/v1alpha1
kind: Function
metadata: { name: process-order }
spec:
  runtime: nodejs22.x          # nodejs20.x | nodejs22.x | python3.12 | python3.13
  handler: index.handler
  deployments:
    local: { memoryMb: 256, timeoutSec: 10, maxConcurrency: 2, idleTtlSec: 60, minWarm: 0 }
  routing: { strategy: manual, defaultTarget: local }
```

## Hybrid usage (opt-in AWS)

Everything below is optional. Xero never creates Lambda functions, IAM roles, queues, stacks or network resources, and never
modifies triggers. Those must already exist, and you choose the identity Xero uses.

```bash
xero aws connect --profile development --region us-east-1   # read-only check: sts:GetCallerIdentity

# Bind an EXISTING Lambda as the aws-lambda deployment of the same logical function
xero functions bind hello --arn arn:aws:lambda:us-east-1:123456789012:function:hello:live

# One name, two independently addressable targets
xero invoke hello --target local      --payload '{"name":"Ada"}'
xero invoke hello --target aws-lambda --payload '{"name":"Ada"}'   # real Invoke API, billed by AWS
xero functions route hello --default-target aws-lambda             # static default, never automatic

# Opt-in, outbound-only SQS consumption of an existing queue (at-least-once)
xero events attach hello --source sqs --queue-url <existing-queue-url>
```

- **Local handler calls AWS.** If a local deployment names an existing role (`awsRoleArn`), workers get short-lived STS
  credentials for that role only. Without a role they get no AWS credentials. Controller credentials are never injected.
- **Native Lambda semantics are preserved.** `FunctionError` is reported as a function error, `InvocationType` is honoured,
  throttling is `AWS_THROTTLED` (distinct from local `CAPACITY_EXHAUSTED`), and a connection failure after dispatch is
  `UNKNOWN_OUTCOME` and is not retried.
- **SQS is at-least-once.** A message is deleted only after the handler acknowledges it; duplicates are possible, so handlers
  must be idempotent. Poison messages are handled by your queue's DLQ/redrive policy. Details:
  [`docs/integrations/aws/sqs-event-source.md`](docs/integrations/aws/sqs-event-source.md).
- **Cost visibility.** `xero metrics` exposes `aws_requests_total` per operation. Lambda invocations, SQS requests and STS calls
  are billed by AWS; Xero itself is free software.

See [`examples/hybrid-process-order`](examples/hybrid-process-order) and
[`docs/integrations/aws/`](docs/integrations/aws) (required IAM policies, trust policies, caveats).

## Security model

Function artifacts are treated as **untrusted code**; standard containers are not a sufficient boundary for hostile
multitenant use, which is out of scope.

- Workers run non-root, read-only rootfs, all capabilities dropped, `no-new-privileges`, CPU/memory/pids limits, a read-only
  artifact mount and nothing else (no Docker socket, no home directory, no controller state).
- The controller binds to loopback only and refuses other addresses. Every route needs a bearer token; the master token lives
  in `$XERO_HOME/token` (0600). Scoped tokens (`read`, `invoke`, `admin`) are stored hashed and revocable
  (`xero tokens ...`). Host and Origin checks defend against DNS rebinding and browser requests; requests are rate limited.
- Credentials are never written to logs, artifacts or manifests; stored function logs are redacted.
- Worker egress is **not** restricted by default. Use engine-level network policy if you need that.

Threat model: [`docs/security/threat-model.md`](docs/security/threat-model.md). Report vulnerabilities privately; see
[`SECURITY.md`](SECURITY.md).

## Project status

| Area | Status |
|---|---|
| Local execution (Node.js, Python), warm reuse, scale to zero, limits, fencing on timeout | **Verified** on a real engine (Colima, Linux arm64, `nodejs22.x` and `python3.13`) by `pnpm test:e2e` |
| Registry persistence, CLI/API/SDK, tokens, backup/restore, graceful shutdown | **Verified** by unit and integration suites |
| AWS connect, role credentials, native Lambda `Invoke`, dual-target routing, SQS poller | Implemented, tested with SDK mocks and an in-memory SQS model. **Never run against real AWS.** The opt-in suite `tests/aws-disposable` exists for a disposable account |
| Other platforms (amd64, Podman), `nodejs20.x`/`python3.12` images, gVisor/Kata (`XERO_DOCKER_RUNTIME`) | Implemented, **not verified** |
| Production hardening | **Not yet.** No per-function network policy, local async (`Event`) invocations are in memory and lost on restart, no OpenTelemetry export |
| Weighted routing, failover, EventBridge/API Gateway/Step Functions ingress, multi-node | Deferred by design; each needs an ADR/RFC |

The scope and acceptance criteria are in [`docs/product/mvp.md`](docs/product/mvp.md) and
[`docs/architecture/acceptance-matrix.md`](docs/architecture/acceptance-matrix.md); known gaps in
[`CHANGELOG.md`](CHANGELOG.md).

## Configuration

Environment variables (see the [guide](docs/guides/getting-started.md) for all): `XERO_HOME`, `XERO_PORT` (7777),
`XERO_MAX_WORKERS` (8), `XERO_QUEUE_LIMIT` (16), `XERO_RATE_LIMIT_RPS` (200), `XERO_ALLOWED_ACCOUNTS`, `XERO_ALLOWED_REGIONS`,
`XERO_DOCKER_RUNTIME`, `XERO_IMAGE_<RUNTIME>` (pin or mirror base images). SDK/CLI use `XERO_URL` and `XERO_TOKEN`.

Run it as a user service with the definitions in [`deploy/`](deploy) (systemd, launchd).

## Repository layout

```
apps/        controller (HTTP API + composition root), cli
packages/    specification, core, shared, registry, artifacts, execution, executor-docker, runtime-node,
             runtime-python, scheduler, scaling, invocation, telemetry, aws-identity, target-aws-lambda,
             event-source-sqs, sdk
examples/    node-hello, python-hello, hybrid-process-order
tests/       contracts, integration, e2e (needs Docker), aws-disposable (opt-in, real AWS)
docs/        product, architecture, integrations/aws, security, adr, rfcs, guides
```

The core packages (`core`, `specification`, `invocation`, `scheduler`, `scaling`) never import the AWS SDK, Docker or
Kubernetes. That boundary is enforced by lint. Architecture overview: [`docs/architecture/overview.md`](docs/architecture/overview.md).

## Development

```bash
pnpm install
pnpm check                 # build + typecheck tests + lint + unit + contract + integration
                           # needs NO AWS credentials and no Docker daemon, and never incurs cloud charges
pnpm test:e2e              # needs a running Docker-compatible engine; skipped if none is reachable
pnpm test:aws-disposable   # OPT IN. Real AWS, disposable account only. See tests/aws-disposable/README.md
```

The default suites never use real AWS credentials. Never point the AWS suite at a production or shared account.

## Contributing

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`CLAUDE.md`](CLAUDE.md) (project principles and agent instructions;
[`AGENTS.md`](AGENTS.md) summarises them). In short:

- Keep Xero **functions-only** and **local-first**; AWS interoperability stays opt-in but is a core contract.
- Behavioural changes need tests and docs; compatibility claims need evidence. Don't claim parity you haven't tested.
- Decisions on function identity, routing, AWS identity, event delivery, isolation, state storage, remote ingress and
  multi-node need an [ADR](docs/adr); backward-incompatible contracts and new AWS event integrations need an
  [RFC](docs/rfcs). Deferred features are not implemented without an approved change to `docs/product/mvp.md`.
- Commits follow Conventional Commits.

## Governance, naming and license

Xero is an independent Cloud Republic OSS project. Sponsorship is never a runtime dependency, and the project works without
any Cloud Republic, Hero or Zerverless service. Other products may integrate through the documented API and SDK.

The name "Xero" is a **working name**: it clashes with an existing company and with an earlier infrastructure-as-prompt
product, so it is not published to npm or other registries until a naming decision is made.

Licensed under the [Apache License 2.0](LICENSE). Third-party production dependencies are Apache-2.0, MIT, ISC or 0BSD.
AWS and AWS Lambda are trademarks of Amazon.com, Inc.; this project is not affiliated with or endorsed by AWS.
