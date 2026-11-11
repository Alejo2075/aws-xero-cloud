# Runtime compatibility matrix

Evidence levels: **T** unit/contract-tested in this repo, **D** designed but needs a Docker daemon to verify (e2e suite),
**X** not supported.

| Aspect | Local worker | Native Lambda | Status |
|---|---|---|---|
| Runtimes | nodejs20.x, nodejs22.x, python3.12, python3.13 via official AWS Lambda base images | any | D |
| Handler resolution | by the AWS runtime inside the image | same | D |
| Context subset | `awsRequestId`, `functionName`, `functionVersion`, `memoryLimitInMB`, `getRemainingTimeInMillis` (provided by the AWS RIE) | full | D |
| Timeout | Enforced by the controller by killing the worker; deadline is also fenced | Lambda | T (fake backend) / D |
| Memory | Docker `--memory` hard limit (OOM kill reported as `WORKER_OOM`) | Lambda | D |
| /tmp | tmpfs 512 MiB, discarded with the worker | 512 MiB–10 GiB | T (flags) |
| IAM identity | Temporary STS credentials for an *existing* role the operator names; none otherwise | Lambda execution role | T (mock) |
| Network | container default bridge; no inbound | VPC/none | D |
| Architecture | host architecture (arm64 on Apple silicon) | x86_64/arm64 | — |
| Layers, extensions, Runtime API proxying, SnapStart, response streaming, provisioned concurrency | X | yes | X |
| Event shapes | whatever JSON the caller supplies; SQS adapter produces the Lambda `SQSEvent` shape | native | T |
| Quotas | Request <= 6 MiB; response limited by controller to 6 MiB | 6 MiB | T |
Do not claim parity beyond this table.
