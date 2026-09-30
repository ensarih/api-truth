CREATE TABLE environment_reconciliation_tasks (
  tenant_id text NOT NULL,
  repository_id text NOT NULL,
  service_id text NOT NULL,
  environment text NOT NULL,
  checkpoint_version bigint NOT NULL CHECK (checkpoint_version > 0),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'leased', 'retry_wait', 'resolved', 'exhausted')),
  attempt_count bigint NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts bigint NOT NULL DEFAULT 8 CHECK (max_attempts > 0),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_token text,
  lease_expires_at timestamptz,
  safe_last_error_code text CHECK (safe_last_error_code IN
    ('INVALID_ENVIRONMENT_INPUT', 'ENVIRONMENT_NOT_FOUND_OR_DENIED',
     'ENVIRONMENT_STORAGE_ERROR', 'ARTIFACT_BINDING_CONFLICT')),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, repository_id, service_id, environment),
  FOREIGN KEY (tenant_id, repository_id, service_id, environment)
    REFERENCES environment_serving_checkpoints
      (tenant_id, repository_id, service_id, environment) ON DELETE RESTRICT,
  CHECK (tenant_id <> '' AND repository_id <> '' AND service_id <> '' AND environment <> ''),
  CHECK ((state = 'leased') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((state = 'resolved') = (resolved_at IS NOT NULL))
);

CREATE INDEX environment_serving_pending_idx ON environment_serving_checkpoints
  (tenant_id, repository_id, service_id, environment, version)
  WHERE reconciliation_required;

CREATE INDEX environment_reconciliation_due_idx ON environment_reconciliation_tasks
  (available_at, created_at, tenant_id, repository_id, service_id, environment)
  WHERE state IN ('queued', 'leased', 'retry_wait');
