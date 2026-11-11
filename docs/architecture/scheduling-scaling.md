# Scheduling and scaling
Per-function `maxConcurrency`, global `maxWorkers` (default 8), bounded wait queue (`queueLimit`, default 16, wait
deadline = remaining invocation timeout). Host exhaustion -> `CAPACITY_EXHAUSTED` (HTTP 429); AWS throttling is a
different error `AWS_THROTTLED` (HTTP 429 with `target=aws-lambda`). Warm pool reuses idle workers of the same
deployment; each worker handles one invocation at a time; idle TTL (default 60 s) -> stop worker (scale-to-zero).
Metrics: `invocations_total{target,outcome}`, `cold_starts_total`, `warm_hits_total`, `capacity_rejections_total`,
`workers_running`, `aws_requests_total{operation}`.
