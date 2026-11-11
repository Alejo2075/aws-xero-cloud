# Architecture overview

```
CLI / SDK / App / SQS poller  ->  Controller (HTTP on 127.0.0.1) -> InvocationRouter
                                                                     |-- local      -> Scheduler -> WarmPool -> ExecutionBackend(docker) -> handler
                                                                     `-- aws-lambda -> LambdaInvoker (AWS SDK Invoke)
```

| Package | Responsibility | May import |
|---|---|---|
| `specification` | zod schemas for logical functions / deployments / manifests | zod |
| `shared` | clock, id generation, abort helpers | — |
| `core` | domain types, structured errors, ports (`FunctionRegistry`, `ArtifactStore`, `ExecutionBackend`, `LambdaInvoker`, `CredentialIssuer`) | specification, shared |
| `registry` | SQLite persistence + migrations | core |
| `artifacts` | pack/validate/store immutable artifacts | core |
| `execution` | backend-neutral execution contracts & worker lifecycle types | core |
| `executor-docker` | Docker CLI backend | execution |
| `runtime-node`, `runtime-python` | runtime catalogue (image, handler validation) | core |
| `scheduler` | per-function / global concurrency, bounded queue | core |
| `scaling` | warm pool, idle TTL, scale-to-zero | core, scheduler |
| `invocation` | router, target selection, attempt/correlation | core, scheduler, scaling |
| `telemetry` | structured logger with redaction, metrics | core |
| `aws-identity` | profile verification, scoped credentials (AWS SDK) | core |
| `target-aws-lambda` | native Lambda Invoke adapter (AWS SDK) | core |
| `event-source-sqs` | SQS poller (AWS SDK) | core |
| `sdk` | typed HTTP client of the controller | core |
| `apps/controller` | HTTP API, composition root | everything |
| `apps/cli` | argument parsing and rendering over the SDK | sdk |

Invariants: routing decision precedes execution; no failover of a possibly completed invocation; local functions run
with the AWS control plane unreachable; the controller never passes its own credentials to workers.
