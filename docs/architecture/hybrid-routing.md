# Hybrid routing (v0.1)

Per invocation: explicit `target` in the request, else `routing.defaultTarget`. No weights, no fallback, no failover.
If the selected target has no active deployment -> `TARGET_NOT_DEPLOYED` (no silent switch). Compatibility check:
runtime *family* (node/python) of an `aws-lambda` deployment vs the logical function; mismatch -> `INCOMPATIBLE_TARGET`
at bind time and recorded as a warning at invoke time if the observed handler differs.
Network failure after dispatch to AWS -> `UNKNOWN_OUTCOME`; **never** retried locally. Each attempt gets an `attemptId`;
`requestId` is stable across attempts; `X-Amzn-Trace-Id` is forwarded when provided.
Weighted routing here (later) will be a Xero gateway feature and not Lambda alias routing.
