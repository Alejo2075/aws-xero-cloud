# Xero

> Your hardware. Your Lambdas. One cloud experience.

Xero is an open-source, self-hosted runtime that runs **Lambda-style functions** on a machine you own
and interoperates with **native AWS Lambda** and real AWS services.

- **Local-first:** no AWS account needed. Functions run in isolated, resource-limited Docker containers.
- **Hybrid by design:** one *logical function* can have a `local` deployment and an `aws-lambda` deployment.
  You choose the target per invocation, or set a fixed default.
- **AWS-native interoperability:** local handlers use the real AWS SDK; Xero invokes *existing* Lambdas
  through the real `Invoke` API; an opt-in SQS poller delivers AWS-origin events to local handlers.
- **Functions only:** Xero does not implement S3, DynamoDB, SQS or any other AWS service.

> **Compatibility, precisely.** A local execution is *not* an AWS Lambda instance. The same logical function is
> backed by two separate physical deployments. Xero cannot make a native Lambda ARN, alias or event-source
> mapping route to your machine. See [`docs/architecture/runtime-compatibility.md`](docs/architecture/runtime-compatibility.md).

## Quick start (local, no AWS)

Requirements: Node.js >= 24, pnpm 9, and a Docker-compatible engine (Docker Desktop, Colima, Podman socket).

```bash
pnpm install && pnpm build

# 1. Start the controller (binds to 127.0.0.1 only)
node apps/controller/dist/main.js &

# 2. Deploy and invoke
node apps/cli/dist/main.js deploy ./examples/node-hello --name hello
node apps/cli/dist/main.js invoke hello --payload '{"name":"Ada"}'
node apps/cli/dist/main.js logs hello
node apps/cli/dist/main.js functions inspect hello
```

(After `pnpm link --global` in `apps/cli` the binary is available as `xero`; `xero-controller` for the daemon.)

## Hybrid quick start (opt-in AWS)

```bash
xero aws connect --profile development --region us-east-1        # read-only verification via STS
xero functions bind hello --target aws-lambda \
  --arn arn:aws:lambda:us-east-1:123456789012:function:hello:live  # existing Lambda; Xero never creates it
xero invoke hello --target aws-lambda --payload '{"name":"Ada"}'
xero invoke hello --target local      --payload '{"name":"Ada"}'
xero events attach hello --source sqs --queue-url <existing-queue-url>
```

Xero **never** creates Lambda functions, IAM roles, queues or any chargeable AWS resource. See
[`docs/integrations/aws/`](docs/integrations/aws) for the exact IAM permissions each feature needs and its cost impact.

## Repository layout

See [`CLAUDE.md`](CLAUDE.md) §8 and [`docs/architecture/overview.md`](docs/architecture/overview.md).

## Development

```bash
pnpm install
pnpm check          # build + lint + unit + contract + integration (no AWS credentials, no cloud charges)
pnpm test:e2e       # needs a running Docker daemon
pnpm test:aws-disposable   # OPT IN. Real AWS, disposable account only. See tests/aws-disposable/README.md
```

## License

Apache-2.0. Xero is an independent Cloud Republic OSS project; sponsorship is never a runtime dependency.
