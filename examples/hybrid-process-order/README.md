# hybrid-process-order

One logical function (`process-order`) with a **local** deployment and a binding to an **existing native Lambda**.
All identifiers below are placeholders: replace the account id, role and ARNs with your own. Nothing in this repository
contains credentials, and Xero will not create any of the AWS resources named here.

1. You create (outside Xero): the DynamoDB table, the function role (`iam/` has a least-privilege example policy and trust
   policy), optionally the native Lambda and an SQS queue (+ DLQ).
2. `xero aws connect --profile development --region us-east-1`
3. `xero deploy ./examples/hybrid-process-order` — deploys locally and binds the Lambda from the manifest (read-only verify).
4. `xero invoke process-order --target local --payload '{"id":"order-1"}'` (local worker, temporary role credentials)
   `xero invoke process-order --target aws-lambda --payload '{"id":"order-1"}'` (real `Invoke` API, billed by AWS)
5. `xero events attach process-order --source sqs --queue-url <existing queue url>` — outbound polling, at-least-once.

The two targets are separate deployments: they may run different code, roles, networks and limits.
