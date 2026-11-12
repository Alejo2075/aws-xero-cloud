# Changelog

## 0.1.0 (unreleased)
First complete implementation of the v0.1 MVP (see `docs/product/mvp.md`).

### Added
- Local execution of Node.js and Python Lambda-style handlers in hardened containers: immutable artifacts, SQLite registry with
  migrations, concurrency/timeout/memory limits, warm reuse, idle scale-to-zero, `minWarm`, graceful shutdown.
- Hybrid model: one logical function with `local` and `aws-lambda` deployments; explicit target or static default; no fallback.
- AWS (opt-in): profile verification, scoped STS credentials for local workers, native Lambda `Invoke`, outbound SQS consumer.
- Controller API (loopback), SDK, CLI. Scoped API tokens, rate limiting, backup/restore, `doctor`, `images pull`, `/v1/ready`.
- Optional alternative OCI runtime (`XERO_DOCKER_RUNTIME`, e.g. gVisor).

### Known gaps (honest list)
- Container execution and every real AWS interaction are covered only by test doubles in the default suites. `tests/e2e` (needs Docker)
  and `tests/aws-disposable` (needs a disposable AWS account) exist but had not been executed when this was written.
- The Docker backend shells out to the `docker` CLI; it does not yet use the Engine API.
- Local async (`Event`) invocations are accepted in memory and are lost if the controller stops; they are not durable.
- Per-function network policy is not implemented (workers keep default egress); see `docs/security/threat-model.md`.
- No OpenTelemetry export, no multi-node, no weighted routing (deferred by design).
- The project/npm scope name "Xero" is provisional (trademark/name clash); publishing is disabled until decided.
