# ADR 0006: Execution isolation

Status: Accepted (v0.1)

**Decision.** Docker-compatible containers via CLI behind `ExecutionBackend`, hardened as in `docs/architecture/execution.md`. Hostile multitenancy is out of scope. AWS Lambda base images (with RIE) are used for fidelity; a custom runtime may replace them behind the same port.
**Consequences.** Needs a container engine. macOS uses a Linux VM engine.
