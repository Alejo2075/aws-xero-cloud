# Architecture overview

```
CLI / SDK / App / SQS poller  ->  Controller (HTTP on 127.0.0.1) -> InvocationRouter
                                                                     |-- local      -> Scheduler -> WarmPool -> ExecutionBackend(docker) -> handler
                                                                     `-- aws-lambda -> LambdaInvoker (AWS SDK Invoke)
```

| Package | Responsibility | Depends on (workspace) |
|---|---|---|
| `specification` | zod schemas: function manifest, requests, ARN/queue-URL validation | — |
| `shared` | clock, id generation, abortable sleep, limits | — |
| `core` | domain types, structured errors (stable codes), ports: `FunctionRegistry`, `ArtifactStore`, `LambdaInvoker`, `CredentialIssuer`, `Logger`, `Metrics` | specification |
| `telemetry` | JSON logger with redaction, in-memory metrics (+Prometheus text) | core |
| `registry` | SQLite persistence (`node:sqlite`), versioned migrations | core, shared, specification |
| `artifacts` | immutable, content-addressed artifact store with validation | core, shared |
| `execution` | `ExecutionBackend` port, runtime catalogue, `FakeExecutionBackend` test double | core, specification |
| `executor-docker` | Docker CLI backend (hardened `docker run`, fencing, log streaming) | execution, core, shared |
| `runtime-node`, `runtime-python` | handler validation / image selection per runtime | execution, core |
| `scheduler` | per-deployment + global concurrency, bounded FIFO queue | core, shared |
| `scaling` | warm worker pool, idle TTL (scale-to-zero), credential-expiry recycling | core, execution, shared |
| `invocation` | router, local and aws-lambda target executors | core, scheduler, scaling, execution |
| `aws-identity` | `sts:GetCallerIdentity`, `sts:AssumeRole` worker credentials (AWS SDK) | core |
| `target-aws-lambda` | native Lambda `Invoke` / `GetFunctionConfiguration` (AWS SDK) | core, shared |
| `event-source-sqs` | outbound SQS poller (AWS SDK) | core, specification, shared |
| `sdk` | typed HTTP client of the controller | core, specification |
| `apps/controller` | HTTP API, service layer, composition root | all of the above |
| `apps/cli` | argument parsing and rendering over the SDK | sdk, specification |

AWS SDK imports exist only in `aws-identity`, `target-aws-lambda`, `event-source-sqs` (enforced by ESLint for the core
packages). The CLI never imports the controller.

Invariants: routing decision precedes execution; no failover of a possibly completed invocation; local functions run
with the AWS control plane unreachable; the controller never passes its own credentials to workers.
