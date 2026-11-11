# ADR 0002: Routing boundaries

Status: Accepted (v0.1)

**Decision.** v0.1 routing is manual per request or a static default. The routing decision happens before execution; a running invocation is never migrated; there is no automatic failover. Unknown outcomes are reported, never retried on another target.
**Consequences.** Weighted routing / failover (later) need an RFC and idempotency guidance.
