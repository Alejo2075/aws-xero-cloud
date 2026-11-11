# Getting started

## Requirements
- Node.js >= 24 (uses the built-in `node:sqlite`), pnpm 9.
- A Docker-compatible engine. macOS: Docker Desktop, OrbStack or Colima (`brew install colima docker && colima start`). Linux: Docker Engine or rootless Podman with the Docker socket.
- No AWS account or Kubernetes is needed.

## Install from source
```bash
pnpm install && pnpm build
pnpm --filter @xero/cli exec pnpm link --global       # optional: puts `xero` on PATH
pnpm --filter @xero/controller exec pnpm link --global  # optional: `xero-controller`
```

## Run
```bash
xero-controller                       # loopback only; state in ~/.xero (override with XERO_HOME)
xero deploy ./examples/node-hello
xero invoke hello --payload '{"name":"Ada"}'
xero functions inspect hello && xero logs hello
```
The first invocation pulls `public.ecr.aws/lambda/nodejs:22` (cold start); later invocations reuse the warm worker until the
idle TTL (default 60 s) expires. Pin or mirror images with `XERO_IMAGE_NODEJS22_X=registry/image@sha256:...`.

## Configuration (environment)
`XERO_HOME`, `XERO_PORT` (7777), `XERO_MAX_WORKERS` (8), `XERO_QUEUE_LIMIT` (16), `XERO_LOG_LEVEL`, `XERO_DOCKER_BIN`,
`XERO_ALLOWED_ACCOUNTS`, `XERO_ALLOWED_REGIONS`. CLI/SDK: `XERO_URL`, `XERO_TOKEN` (or the token file in `XERO_HOME`).

## Using AWS (optional)
See `docs/integrations/aws/` and `examples/hybrid-process-order`. Xero never creates AWS resources; costs you incur are
Lambda invocations, SQS requests and STS calls, visible with `xero metrics` (`aws_requests_total`).

## Troubleshooting
- `BACKEND_UNAVAILABLE`: the container engine is not running or `docker` is not on PATH.
- `WORKER_START_FAILED`: image pull failed or the container exited at start; the error includes a log tail.
- `CAPACITY_EXHAUSTED` (HTTP 429): host limits (`XERO_MAX_WORKERS`, per-function `--concurrency`, queue) are saturated; this is different from `AWS_THROTTLED`.
- `UNKNOWN_OUTCOME`: the connection to AWS failed after dispatch; the Lambda may or may not have run. Xero does not retry it.
