# Inbound bridges (deferred)
EventBridge API destinations, API Gateway, Step Functions HTTP Task and trigger-forwarding Lambdas are **not part of
v0.1**. They require an explicitly reachable, authenticated Xero ingress (TLS/mTLS) and an RFC. The recommended interim
path for any AWS service event is: route it into SQS and attach the queue.
