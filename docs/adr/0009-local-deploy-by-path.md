# ADR 0009: Local deployment by directory path (no archive upload in v0.1)

Status: Accepted (v0.1)

**Decision.** `POST .../deployments/local` takes `sourcePath`, a directory on the controller host. Because the controller only
listens on loopback and requires a bearer token, caller and controller share a machine and a trust boundary. The controller
validates and copies the directory into the content-addressed store; later edits to the source do not affect the deployment.
**Consequences.** No archive parsing attack surface in v0.1. Remote deployment (archive upload with size limits, signature/
provenance checks) needs the remote-ingress ADR and is out of scope.
