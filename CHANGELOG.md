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

### Fixed after first run on a real engine
- Worker reuse after a runtime crash/OOM: the AWS emulator keeps the container up and reports `Runtime.ExitError`; such workers are now discarded.
- Emulator `(rapid)` chatter is no longer stored in function logs.

### Known gaps (honest list)
- Real AWS interaction is covered only by SDK mocks and an in-memory SQS model; `tests/aws-disposable` (disposable account) has not been run.
- Container execution was verified with `tests/e2e` (11 tests) on Colima/Docker, linux/arm64 only (nodejs22.x and python3.13). Not verified: amd64, rootless Podman, nodejs20.x/python3.12 images, gVisor/Kata (`XERO_DOCKER_RUNTIME`).
- The Docker backend shells out to the `docker` CLI; it does not yet use the Engine API.
- Local async (`Event`) invocations are accepted in memory and are lost if the controller stops; they are not durable.
- Per-function network policy is not implemented (workers keep default egress); see `docs/security/threat-model.md`.
- No OpenTelemetry export, no multi-node, no weighted routing (deferred by design).
- The project/npm scope name "Xero" is provisional (trademark/name clash); publishing is disabled until decided.
