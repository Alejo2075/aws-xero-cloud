# ADR 0007: State storage

Status: Accepted (v0.1)

**Decision.** Embedded SQLite (`node:sqlite`) with versioned migrations; artifacts on disk content-addressed. Controller local API: loopback + bearer token. Remote ingress and multi-node coordination are explicitly deferred and each will need its own ADR.
**Consequences.** Node >= 24 required.
