# Interoperability matrix
| Direction | v0.1 | How |
|---|---|---|
| Local -> AWS service | Yes | AWS SDK in handler with worker credentials |
| Xero -> native Lambda | Yes | `Invoke` API on a bound existing ARN |
| Logical function local + Lambda | Yes | manual / static default |
| SQS -> local | Yes | outbound poller |
| EventBridge / API GW / Step Functions -> local | No | deferred (RFC) |
| Native Lambda -> Xero function | Only via Xero API/SDK you call explicitly | no ARN redirection |
| `LambdaClient.Invoke(AWS_ARN)` redirected to local | **Never** | not possible without changing the caller |
