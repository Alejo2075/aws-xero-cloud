# ADR 0005: Event delivery semantics (SQS)

Status: Accepted (v0.1)

**Decision.** Outbound long-polling consumer, at-least-once. Message deleted only after the handler returns without `FunctionError` and, for batch responses, per `batchItemFailures`. Failed messages are left to reappear after the visibility timeout (receive count/DLQ is governed by the queue's redrive policy, which Xero reads but never changes). Visibility timeout is extended while processing if configured. In-flight work is bounded; no unbounded prefetch.
**Consequences.** Handlers must be idempotent; duplicates are expected.
