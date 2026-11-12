# Threat model (v0.1)

| Threat | Mitigation | Residual |
|---|---|---|
| Malicious function code escaping container | non-privileged, cap-drop ALL, no-new-privileges, read-only rootfs, pids/memory limits, no Docker socket/home/state mounts | Container escape CVEs; hostile multitenancy unsupported |
| Malicious function abusing AWS | per-function role (operator-scoped), controller creds never injected | Over-broad role chosen by operator |
| Local controller compromise | loopback bind, 0600 token, no secrets in DB | Same-user local attacker can read token/state |
| Dependency attacks | lockfile, minimal dependencies, artifacts validated (no symlink escape, size limits); artifact dependency provenance is the operator's | Third-party packages inside artifacts |
| Token/credential theft | STS credentials short-lived, redacted in logs, never persisted | Credentials visible in worker env during lifetime |
| Leaked Roles Anywhere certificates | not implemented in v0.1; documented as the recommended production path | — |
| Overly broad trust/IAM policies | docs give minimal examples; `aws connect` reports identity and warns on admin-looking identities | Operator error |
| Replayed / duplicate SQS messages | at-least-once documented; message id passed to the handler; idempotency required | Duplicate side effects |
| EventBridge/bridge impersonation | no inbound bridges shipped in v0.1 | — |
| Remote-node compromise | no multi-node in v0.1 | — |
| Accidental AWS charges | no resource creation; per-function AWS request counters; docs list cost-incurring calls | Lambda/SQS/STS usage by function code |
| Unsafe egress / network exposure | publish only to 127.0.0.1; controller refuses non-loopback bind | Containers have default egress |
| SSRF via configuration | ARN/queue URL/regex validated; optional allow-lists for accounts/regions; no user-controlled URLs fetched | — |
| Log/telemetry leakage | structured logger with key & pattern redaction; payloads never logged | Secrets printed by function code are best-effort redacted |

## Additional notes (implementation review)
- **API token = control of the host user.** `deploy` ingests any directory readable by the controller user and mounts the
  resulting immutable copy read-only into a container. Treat `$XERO_HOME/token` like an SSH key. The API checks the bearer token,
  the `Host` header (DNS rebinding) and rejects requests carrying an `Origin` header (browser CSRF).
- **Worker environment** is delivered through a temporary 0600 `--env-file` removed right after `docker run`; it is never placed in
  argv or in the environment of the `docker` client, so function-chosen variable names cannot affect the host CLI.
- **Symlinks** in artifacts are validated against the real filesystem after staging (chains such as `d/up -> ..` + `esc -> d/up/..`
  are rejected), dangling links are rejected.
- **AWS targets** (account/region) are checked against the connected account and optional `XERO_ALLOWED_ACCOUNTS` /
  `XERO_ALLOWED_REGIONS`; queue URLs must be genuine `sqs.<region>.amazonaws.com` URLs.
- **Container egress**: workers use the default bridge network and can reach the internet (and the Docker host gateway). Use
  engine-level network policy if functions must be restricted.
- **Scoped tokens (ADR 0011).** Give applications an `invoke` token and dashboards a `read` token; keep the master token for operators. Token hashes
  (not plaintext) are stored; revoke with `xero tokens revoke`. Per-principal rate limiting bounds abuse of a leaked token.
- **Isolation hardening.** `XERO_DOCKER_RUNTIME=runsc` (gVisor) or `kata` runs workers on an alternative OCI runtime. The runtime must be installed in the container engine.
