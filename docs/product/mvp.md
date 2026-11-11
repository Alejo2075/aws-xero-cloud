# MVP v0.1 — minimum viable hybrid runtime

Source of truth for scope. Changing it requires an ADR.

## In scope
**Local:** Docker-compatible engine; Node.js (`nodejs20.x`, `nodejs22.x`) and Python (`python3.12`, `python3.13`)
handlers; immutable content-addressed artifacts; SQLite registry that survives restarts; timeout / memory / pid /
concurrency limits; structured redacted logs; basic metrics; warm reuse and idle scale-to-zero;
CLI `deploy | invoke | functions list/inspect/bind/unbind | logs | update | remove | metrics | aws connect/status | events attach/detach/list`.

**AWS (all opt-in):** `aws connect` (profile + region via SDK credential chain, verified by `sts:GetCallerIdentity`);
local handlers call real AWS services with short-lived credentials from `sts:AssumeRole` on an *existing*
per-function role; `bind` an *existing* Lambda ARN (verified with `lambda:GetFunctionConfiguration`) and invoke it with
the real `Invoke` API; one logical function with `local` + `aws-lambda` deployments, explicit `--target` or a static
default; an opt-in SQS consumer for an *existing* queue.

**Never in v0.1:** creating Lambdas, roles, queues, stacks or network resources; modifying triggers.

## Deferred (needs ADR + approved change of this file)
Native Lambda deployment/sync, weighted/adaptive routing, cloud bursting, automatic failover, EventBridge/API Gateway/
Step Functions ingress, multi-node, K3s, full Runtime API/layers/extensions parity, enterprise multitenancy, hosted UI.

## Acceptance
See `CLAUDE.md` §20; traceability in `docs/architecture/acceptance-matrix.md`.
