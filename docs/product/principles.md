# Principles

1. Functions only. 2. Hybrid by design (`local`, `aws-lambda` are first-class targets). 3. Logical identity is not
physical deployment. 4. Single-node simple: no AWS account, no Kubernetes. 5. Prefer the official AWS SDK/API over
emulation. 6. Precise, evidence-backed compatibility claims. 7. Explicit routing, deterministic, never AI.
8. Secure connectivity: loopback by default, no long-lived keys. 9. Least privilege per function.
10. Container-based isolation using existing primitives. 11. Visible scaling (cold starts, rejections, spillover).
12. Provider boundaries. 13. Operator ownership. 14. Honest delivery: vertical slice first. 15. No mandatory AI,
account or sponsor.
