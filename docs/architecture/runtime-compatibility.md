# Runtime compatibility matrix

Evidence levels: **T** tested without Docker/AWS (unit, integration or contract tests with doubles), **D** implemented but only
verifiable with a Docker daemon (`tests/e2e/docker.test.ts`, skipped when no daemon is reachable), **A** needs the opt-in AWS suite,
**X** not supported. Rows marked **T (e2e, Docker)** were executed against a real engine (Colima 0.10, Docker 29.5, linux/arm64) with `pnpm test:e2e`; nothing has been run on linux/amd64 or against real AWS (A).

| Aspect | Local worker | Native Lambda | Status |
|---|---|---|---|
| Runtimes | nodejs20.x, nodejs22.x, python3.12, python3.13 via official AWS Lambda base images | any | T (e2e: nodejs22.x, python3.13 only) |
| Handler resolution | by the AWS runtime inside the image | same | D |
| Context subset | `awsRequestId`, `functionName`, `functionVersion`, `memoryLimitInMB`, `getRemainingTimeInMillis` (provided by the AWS RIE) | full | D |
| Timeout | Enforced by the controller by killing the worker; deadline is also fenced | Lambda | T (e2e, Docker) |
| Memory | Docker `--memory` hard limit. Observed with the real AWS RIE: the runtime process is OOM-killed and restarted inside the surviving container; the caller gets a function error `Runtime.ExitError` ("signal: killed"), as on Lambda, and Xero discards that worker. `WORKER_OOM` is reserved for the container itself being killed | Lambda | T (e2e, Docker) |
| /tmp | tmpfs 512 MiB, discarded with the worker | 512 MiB–10 GiB | T (flags; hardening inspected in e2e) |
| IAM identity | Temporary STS credentials for an *existing* role the operator names; none otherwise | Lambda execution role | T (mock) |
| Network | container default bridge; no inbound | VPC/none | D |
| Architecture | host architecture (arm64 on Apple silicon) | x86_64/arm64 | — |
| Layers, extensions, Runtime API proxying, SnapStart, response streaming, provisioned concurrency | X | yes | X |
| Event shapes | whatever JSON the caller supplies; SQS adapter produces the Lambda `SQSEvent` shape | native | T |
| Quotas | Request <= 6 MiB; response limited by controller to 6 MiB | 6 MiB | T |
Do not claim parity beyond this table.
