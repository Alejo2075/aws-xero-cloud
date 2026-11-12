# ADR 0011: Scoped API tokens and rate limiting

Status: Accepted (v0.1.x)

**Decision.** Besides the master (admin) token in `<home>/token`, operators can mint named tokens with a scope:
`read` (list/inspect functions, invocation history, metrics), `invoke` (only `POST /v1/invoke/*`) or `admin`. Only the SHA-256 of a
token is stored (migration 2); the plaintext is shown once. Tokens are revocable immediately. Every route requires `admin` unless
`apps/controller/src/access.ts` explicitly opens it, so new routes are private by default. Logs, AWS status and diagnostics are
admin-only because they can expose sensitive data or trigger billable AWS calls. A token bucket per principal
(`XERO_RATE_LIMIT_RPS`, default 200, burst 2x, 0 disables) returns `429 RATE_LIMITED` with `Retry-After`.
**Consequences.** Applications can be given an `invoke`-only token. This is still a loopback API; remote exposure still needs the
TLS/mTLS ADR. Tokens carry no per-function restriction yet (future work).
