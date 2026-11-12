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
`XERO_ALLOWED_ACCOUNTS`, `XERO_ALLOWED_REGIONS`, `XERO_DOCKER_RUNTIME`, `XERO_RATE_LIMIT_RPS` (200), `XERO_MAX_LOG_LINES`, `XERO_MAX_INVOCATIONS`, `XERO_DRAIN_TIMEOUT_MS`. CLI/SDK: `XERO_URL`, `XERO_TOKEN` (or the token file in `XERO_HOME`).

## Using AWS (optional)
See `docs/integrations/aws/` and `examples/hybrid-process-order`. Xero never creates AWS resources; costs you incur are
Lambda invocations, SQS requests and STS calls, visible with `xero metrics` (`aws_requests_total`).

## Colima / Lima note
Colima shares only your home directory with its VM. Keep `XERO_HOME` (default `~/.xero`) under `$HOME`; a state directory elsewhere
(e.g. `/var/folders/...`) makes artifact mounts arrive empty and functions fail with import errors.
Verified setup: `brew install colima && colima start --vm-type vz --cpu 4 --memory 6`.

## Troubleshooting
- `BACKEND_UNAVAILABLE`: the container engine is not running or `docker` is not on PATH.
- `WORKER_START_FAILED`: image pull failed or the container exited at start; the error includes a log tail.
- `CAPACITY_EXHAUSTED` (HTTP 429): host limits (`XERO_MAX_WORKERS`, per-function `--concurrency`, queue) are saturated; this is different from `AWS_THROTTLED`.
- `UNKNOWN_OUTCOME`: the connection to AWS failed after dispatch; the Lambda may or may not have run. Xero does not retry it.

## Operations
- `xero images pull` pre-pulls the runtime base images. `xero doctor` checks the engine, database, AWS and event sources.
- `xero backup` snapshots the registry; restore with the controller stopped: `xero-controller restore --from <file>`.
- `xero tokens create app --scope invoke` mints a limited token for applications; give it to them as `XERO_TOKEN`.
- `GET /v1/ready` is an unauthenticated readiness probe (`{ready, engine}`); shutdown (SIGTERM) drains in-flight invocations first.
