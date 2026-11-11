# Real AWS suite (opt-in, disposable account only)

**This suite calls real AWS APIs and can incur small charges. Never run it against production or a shared account.**
It is excluded from `pnpm test`, `pnpm check` and CI. Run it explicitly:

```bash
XERO_AWS_DISPOSABLE=1 \
XERO_TEST_AWS_PROFILE=xero-test \
XERO_TEST_AWS_REGION=us-east-1 \
XERO_TEST_ACCOUNT_ID=123456789012 \        # hard guard: the suite aborts if STS reports a different account
XERO_TEST_LAMBDA_ARN=arn:aws:lambda:us-east-1:123456789012:function:xero-echo:live \
XERO_TEST_ROLE_ARN=arn:aws:iam::123456789012:role/xero-test-fn \     # optional: assume-role test
XERO_TEST_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/123456789012/xero-test-queue \  # optional, dedicated queue
pnpm test:aws-disposable
```

Xero creates **nothing**. You provision (and tear down) the resources yourself, ideally with a throwaway stack:
- a Lambda that echoes its event (`exports.handler = async (e) => e`),
- optionally a role the test identity may assume (trust policy: the test identity) with no permissions,
- optionally a **dedicated** SQS queue with a DLQ (the suite sends 1 message and verifies it is consumed and deleted;
  it never purges the queue).

Permissions needed by the test identity: `sts:GetCallerIdentity`, `lambda:GetFunctionConfiguration` and
`lambda:InvokeFunction` on the test function, optionally `sts:AssumeRole` on the test role, and
`sqs:SendMessage|ReceiveMessage|DeleteMessage|ChangeMessageVisibility|GetQueueAttributes` on the test queue.

Cleanup check: the suite fails if the test queue still holds messages it sent after the run.
Estimated cost: a handful of Lambda invocations and SQS requests (well under one US cent).
