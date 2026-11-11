# Persistence
SQLite via Node's built-in `node:sqlite` at `$XERO_HOME/xero.db` (default `~/.xero`). WAL mode. Versioned migrations in
`schema_migrations`; the controller refuses to start on a database newer than it understands. Artifacts live in
`$XERO_HOME/artifacts/<sha256>/` (read-only, content addressed). Invocation records keep metadata only (no payloads).
Worker filesystems are ephemeral. Deleting a function removes its deployments, event sources and unreferenced
artifacts. Single-host only; not suitable for HA (future ADR).
