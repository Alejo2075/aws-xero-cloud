export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Append-only list. Never edit a released migration; add a new one. */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial',
    sql: `
CREATE TABLE functions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  routing_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE deployments (
  id TEXT PRIMARY KEY,
  function_id TEXT NOT NULL REFERENCES functions(id) ON DELETE CASCADE,
  target TEXT NOT NULL CHECK (target IN ('local','aws-lambda')),
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','superseded','removed')),
  config_json TEXT NOT NULL,
  artifact_id TEXT,
  created_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX deployments_one_active ON deployments(function_id, target) WHERE status = 'active';
CREATE UNIQUE INDEX deployments_version ON deployments(function_id, target, version);
CREATE INDEX deployments_artifact ON deployments(artifact_id);
CREATE TABLE invocations (
  attempt_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  function_id TEXT NOT NULL REFERENCES functions(id) ON DELETE CASCADE,
  function_name TEXT NOT NULL,
  deployment_id TEXT,
  target TEXT NOT NULL,
  invocation_type TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  error_code TEXT,
  cold_start INTEGER,
  aws_request_id TEXT,
  started_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  payload_bytes INTEGER NOT NULL,
  response_bytes INTEGER NOT NULL,
  trace_id TEXT
) STRICT;
CREATE INDEX invocations_fn ON invocations(function_id, started_at DESC);
CREATE TABLE logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  function_id TEXT NOT NULL REFERENCES functions(id) ON DELETE CASCADE,
  deployment_id TEXT NOT NULL,
  request_id TEXT,
  stream TEXT NOT NULL,
  at INTEGER NOT NULL,
  message TEXT NOT NULL
) STRICT;
CREATE INDEX logs_fn ON logs(function_id, id);
CREATE TABLE event_sources (
  id TEXT PRIMARY KEY,
  function_id TEXT NOT NULL REFERENCES functions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  queue_url TEXT NOT NULL,
  region TEXT NOT NULL,
  batch_size INTEGER NOT NULL,
  max_in_flight INTEGER NOT NULL,
  visibility_extension_sec INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (function_id, queue_url)
) STRICT;
CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
`,
  },
];
