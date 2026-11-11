# v0.1 acceptance traceability
| # | Criterion | Evidence |
|---|---|---|
| 1 | Run locally with no AWS | `tests/integration/local-only.test.ts` (no AWS env, AWS unreachable) |
| 2 | Deploy/invoke/logs/update/remove Node & Python | `tests/integration/lifecycle.test.ts`, `tests/e2e/docker-*.test.ts` (needs Docker) |
| 3 | Bounded concurrency/timeouts/memory/cold/warm/scale-to-zero | `packages/scheduler|scaling` unit tests, integration, e2e |
| 4 | Restart keeps metadata | `tests/integration/restart.test.ts` |
| 5 | Connect AWS account | `packages/aws-identity` tests (mocked STS) |
| 6 | Local fn calls real AWS service with temp creds | credential issuance tests + `examples/hybrid-process-order`; real run: `tests/aws-disposable` (opt-in) |
| 7 | Bind & invoke existing Lambda | `packages/target-aws-lambda` tests (mocked) + disposable suite |
| 8 | One logical fn, two targets | `tests/contracts/hybrid-routing.test.ts` |
| 9 | SQS attach & at-least-once processing | `packages/event-source-sqs` tests (fake SQS) |
| 10 | Inspect handling deployment & correlate | invocation records tests |
| 11 | Local keeps working during AWS outage | `tests/integration/local-only.test.ts` |
| 12 | Default suite needs no cloud creds | CI config; AWS suite gated by `XERO_AWS_DISPOSABLE=1` |
| 13 | CLI/API/SDK parity | `tests/integration/api-sdk.test.ts` |
