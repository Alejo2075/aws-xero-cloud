# ADR 0010: Worker environment delivery

Status: Accepted (v0.1)

**Decision.** Function environment variables, including temporary AWS credentials, are written to a 0600 temporary `--env-file`
passed to `docker run` and deleted immediately afterwards. They are not passed as `-e KEY=VALUE` (visible in `ps`) and not through
the docker client's environment (user-chosen names such as `DOCKER_HOST` would affect the host CLI).
**Consequences.** Values containing newlines are rejected. Credentials remain visible inside the worker environment for its lifetime
(unavoidable with env-based SDK credential resolution); workers are recycled before expiry.
