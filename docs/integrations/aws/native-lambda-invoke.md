# Invoking existing native Lambda
Uses `lambda:Invoke` with `FunctionName=<qualified ARN>`, `InvocationType` `RequestResponse` (default) or `Event`,
`LogType=None`. Mapping (AWS semantics preserved):
- HTTP 200 + `X-Amz-Function-Error` header -> result `status: function-error`, payload returned as is.
- `TooManyRequestsException`/429 -> `AWS_THROTTLED`; `AccessDeniedException` -> `AWS_ACCESS_DENIED`;
  `ResourceNotFoundException` -> `AWS_TARGET_NOT_FOUND`; request too large -> `PAYLOAD_TOO_LARGE`.
- Network/timeout after dispatch (`RequestResponse`) -> `UNKNOWN_OUTCOME` (never retried).
- `Event` returns acceptance (202), not a result. SDK retries are disabled (`maxAttempts: 1`) to avoid hidden duplicates.
Cost: standard Lambda pricing applies to every invocation; Xero counts them in `aws_requests_total`.
