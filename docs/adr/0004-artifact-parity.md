# ADR 0004: Artifact parity

Status: Accepted (v0.1)

**Decision.** Local artifacts are immutable content-addressed directories. Native Lambda code is external and is not synchronized or built by Xero in v0.1. Parity is a developer responsibility; Xero records hashes and observed Lambda `CodeSha256` only for visibility.
**Consequences.** No claim that both targets run identical code.
