# Roadmap and status

Legend: done = implemented and covered by tests.

| Area | Status |
|---|---|
| Phase 0 contracts/ADRs/threat model | done |
| Phase 1 local engine (Node/Python) | done; verified on a real engine (Colima, linux/arm64) by `pnpm test:e2e` |
| Phase 2 AWS-connected execution | done (`tests/aws-disposable` is the opt-in real-AWS suite) |
| Phase 3 SQS ingress, v0.1 criteria | done |
| Hardening (tokens, rate limits, runtime option, backup/restore, drain) | done |
| Not started | Engine-API backend, durable async queue, per-function network policy, OpenTelemetry, IAM Roles Anywhere provider, packaging (npm/Homebrew), phases 4-6 (weighted routing, bridges, multi-node) |

Items in "Not started" need an ADR/RFC first (CLAUDE.md §17). Phases 4–6 stay blocked until v0.1 is validated end to end.
