# v0.1 acceptance traceability

"fake" = Docker and AWS are replaced by test doubles, so the test needs neither a daemon nor credentials.
"docker" = needs a running container engine (`pnpm test:e2e`, auto-skipped otherwise). "aws" = opt-in disposable-account suite.

| # | Criterion | Evidence |
|---|---|---|
| 1 | Run locally with no AWS account | `tests/integration/local-only.test.ts` (fake) |
| 2 | Deploy/invoke/logs/update/remove Node & Python | `tests/integration/lifecycle.test.ts`, `cli.test.ts` (fake); `tests/e2e/docker.test.ts` (docker) |
| 3 | Bounded concurrency, timeouts, memory, cold/warm, scale-to-zero | `packages/scheduler`, `packages/scaling`, `packages/invocation` unit tests (fake); `tests/e2e/docker.test.ts` (docker) |
| 4 | Restart keeps metadata | `tests/integration/restart.test.ts`, `packages/registry` tests |
| 5 | Connect an existing AWS account | `packages/aws-identity` tests (SDK mock), `tests/integration/aws-connect.test.ts`; `tests/aws-disposable` (aws) |
| 6 | Local fn calls a real AWS service with temporary credentials | credential issuance/injection/redaction: `aws-connect.test.ts`, `packages/invocation/test/local.test.ts` (fake); real STS: `tests/aws-disposable` (aws). The handler in `examples/hybrid-process-order` uses the real SDK |
| 7 | Bind & invoke an existing Lambda | `packages/target-aws-lambda` (SDK mock), `tests/contracts/hybrid-routing.test.ts`; `tests/aws-disposable` (aws) |
| 8 | One logical fn, two targets, explicit target | `tests/contracts/hybrid-routing.test.ts` |
| 9 | Attach existing SQS queue, at-least-once | `packages/event-source-sqs` (in-memory SQS model), `tests/integration/sqs.test.ts`; `tests/aws-disposable` (aws) |
| 10 | Inspect which deployment handled an invocation, correlate | invocation records in `lifecycle.test.ts`, `hybrid-routing.test.ts` |
| 11 | Local keeps working during an AWS outage | `local-only.test.ts` |
| 12 | Default suite needs no cloud credentials or charges | CI workflow; AWS suite requires `XERO_AWS_DISPOSABLE=1` **and** profile/region/account variables |
| 13 | Same capabilities via CLI/API/SDK | `cli.test.ts`, SDK used by every integration test |
