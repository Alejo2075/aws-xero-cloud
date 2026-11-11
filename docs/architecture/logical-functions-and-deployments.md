# Logical functions and deployments

`LogicalFunction` (`fn_<uuid>`, unique `name`) owns routing policy only. `Deployment` (`dep_<uuid>`) is a physical
deployment on one `target` (`local` | `aws-lambda`), with its own monotonically increasing `version` per
(function, target), status (`active` | `superseded` | `removed`), limits, identity and configuration.
At most one `active` deployment per target. Updating creates version N+1 and supersedes N atomically.
An AWS ARN is **never** used as a logical function ID. For `aws-lambda` deployments Xero stores the qualified ARN and
read-only observed configuration (runtime, handler, timeout, memory, CodeSha256, version) and does not claim to
control that code. `bind` fails if the ARN is malformed, the region is not in the connected AWS config, or
`GetFunctionConfiguration` is denied (unless `--no-verify` is explicitly given, which is recorded).
