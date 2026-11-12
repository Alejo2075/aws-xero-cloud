# Controller API (management and invocation are separate)
Binds `127.0.0.1:7777` by default. Every route except `GET /v1/health` and `GET /v1/ready` requires a bearer token: the master admin token (`$XERO_HOME/token`, mode 0600) or a scoped token (`read` | `invoke` | `admin`, ADR 0011). Requests are rate limited per principal.
Binding to a non-loopback address requires `--allow-remote` plus TLS configuration (not shipped in v0.1; refused).
Errors: `{ "error": { "code": "STABLE_CODE", "message": "...", "requestId": "..." } }`.

Management: `GET/POST /v1/functions`, `GET/DELETE /v1/functions/:name`, `POST /v1/functions/:name/deployments/local`,
`PUT /v1/functions/:name/deployments/aws-lambda`, `DELETE /v1/functions/:name/deployments/:target`,
`PATCH /v1/functions/:name/routing`, `GET /v1/functions/:name/logs`, `GET /v1/functions/:name/invocations`,
`GET /v1/metrics`, `GET/PUT/DELETE /v1/aws/connection`, `GET/POST/DELETE /v1/events`, `GET/POST/DELETE /v1/tokens`, `POST /v1/images/pull`, `POST /v1/backups`, `GET /v1/doctor`, `GET /v1/ready`.
Invocation: `POST /v1/invoke/:name?target=local|aws-lambda&type=RequestResponse|Event`.
The CLI only uses `@xero/sdk`.
