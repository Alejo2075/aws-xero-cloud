# Local execution
`ExecutionBackend` (`startWorker`, `invoke`, `stopWorker`, `inspect`, `streamLogs`, `list`). `executor-docker` runs
`docker run -d` with: `--read-only`, `--tmpfs /tmp`, `--cap-drop ALL`, `--security-opt no-new-privileges`,
`--pids-limit`, `--memory/--memory-swap`, `--cpus` (derived from memory), no privileged mode, no Docker socket, only the
immutable artifact mounted read-only at `/var/task`, publish port bound to `127.0.0.1`, label `xero.managed=true`.
Timeout = kill the container (fence), never just abort the HTTP request. Crashes surface as `WORKER_CRASHED`; the
controller reaps orphans labelled `xero.managed=true` on boot.
Credentials are injected only as env vars for that worker (see `integrations/aws/credentials-and-iam.md`).
