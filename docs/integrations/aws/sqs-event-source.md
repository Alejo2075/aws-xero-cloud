# SQS event source (opt-in, outbound-only)
`xero events attach <fn> --source sqs --queue-url <url> [--batch-size 10] [--target local]`. The queue must exist.
Xero validates the URL/region against the connected config, reads `GetQueueAttributes` (visibility timeout, redrive
policy) and **warns when no DLQ is configured**. Poll loop: long poll (20 s), up to `batchSize` (<=10) messages, bounded
by `maxInFlight`. The handler receives the Lambda `SQSEvent` shape (`Records[].messageId, receiptHandle, body, attributes,
messageAttributes, eventSource, eventSourceARN, awsRegion`). Outcome:
- success (no `FunctionError`, no `batchItemFailures`) -> `DeleteMessage` for all.
- `batchItemFailures` -> delete the others, leave failed ones (reappear after visibility timeout; DLQ via redrive policy).
- function error / timeout / capacity rejection -> leave all (visibility timeout expiry -> retry).
- visibility extension (`ChangeMessageVisibility`) while the invocation runs.
Duplicates are possible: handlers must be idempotent (use `messageId`). Required IAM: see credentials-and-iam.md.
Costs: SQS requests are billed by AWS (about one receive per poll, plus deletes).

## Poison messages
Xero never deletes a message the handler did not acknowledge, and never moves messages itself: the queue's redrive policy
(DLQ + `maxReceiveCount`) is the only mechanism. To isolate one poison message without failing the whole batch, return a
Lambda-style partial batch response (`{"batchItemFailures":[{"itemIdentifier":"<messageId>"}]}`). A handler that throws or
returns a function error fails the **entire** batch, exactly as with native Lambda. Malformed `batchItemFailures` are
treated as a whole-batch failure. On FIFO queues processing is serialised and a failure also leaves all later messages of
the batch unacknowledged.

## Early release
Only invocations that provably did not run (capacity exhausted, target not deployed, AWS not connected, throttled) release the
batch early (`ChangeMessageVisibility` to 10 s). Timeouts, crashes and unknown outcomes wait for the normal visibility timeout.
