# ADR 0001: Logical function identity vs deployment

Status: Accepted (v0.1)

**Decision.** A logical function has a Xero-generated ID and unique name; each target has an independent deployment record. AWS ARNs are attributes of an `aws-lambda` deployment, never identifiers of the logical function.
**Consequences.** Local and Lambda versions may diverge; Xero stores observed configuration and surfaces drift instead of hiding it.
