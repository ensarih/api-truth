CREATE TABLE environment_serving_observations (
  tenant_id text NOT NULL,
  producer_id text NOT NULL,
  event_id text NOT NULL,
  repository_id text NOT NULL,
  service_id text NOT NULL,
  environment text NOT NULL,
  observation_id text NOT NULL,
  source_authority_id text NOT NULL,
  source_access_label text NOT NULL,
  effective_order text NOT NULL,
  completeness text NOT NULL CHECK (completeness IN ('complete', 'incomplete', 'transitional')),
  serving_status text NOT NULL CHECK (serving_status IN ('known', 'unknown')),
  inventory jsonb,
  rollback_request_id text,
  active_config_fingerprint text NOT NULL,
  disposition text NOT NULL CHECK (disposition IN ('applied', 'stale', 'replay', 'reconciliation_required')),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, producer_id, event_id),
  UNIQUE (tenant_id, repository_id, service_id, environment, producer_id, event_id),
  FOREIGN KEY (tenant_id, producer_id, event_id)
    REFERENCES orchestration_events (tenant_id, producer_id, event_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, active_config_fingerprint)
    REFERENCES orchestration_configurations (tenant_id, config_fingerprint) ON DELETE RESTRICT,
  CHECK (tenant_id <> '' AND producer_id <> '' AND event_id <> '' AND repository_id <> ''
    AND service_id <> '' AND environment <> '' AND observation_id <> '' AND source_authority_id <> ''
    AND source_access_label <> '' AND effective_order <> ''
    AND (rollback_request_id IS NULL OR rollback_request_id <> '')),
  CHECK ((serving_status = 'known' AND inventory IS NOT NULL AND jsonb_typeof(inventory) = 'array')
    OR (serving_status = 'unknown' AND inventory IS NULL))
);

CREATE INDEX environment_serving_observations_scope_idx ON environment_serving_observations
  (tenant_id, repository_id, service_id, environment, recorded_at);

CREATE TRIGGER environment_serving_observations_immutable
BEFORE UPDATE OR DELETE ON environment_serving_observations
FOR EACH ROW EXECUTE FUNCTION orchestration_immutable_row();

CREATE TABLE environment_serving_checkpoints (
  tenant_id text NOT NULL,
  repository_id text NOT NULL,
  service_id text NOT NULL,
  environment text NOT NULL,
  current_producer_id text,
  current_event_id text,
  pending_producer_id text,
  pending_event_id text,
  reconciliation_required boolean NOT NULL DEFAULT false,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, repository_id, service_id, environment),
  FOREIGN KEY (tenant_id, repository_id, service_id, environment, current_producer_id, current_event_id)
    REFERENCES environment_serving_observations
      (tenant_id, repository_id, service_id, environment, producer_id, event_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, repository_id, service_id, environment, pending_producer_id, pending_event_id)
    REFERENCES environment_serving_observations
      (tenant_id, repository_id, service_id, environment, producer_id, event_id) ON DELETE RESTRICT,
  CHECK (tenant_id <> '' AND repository_id <> '' AND service_id <> '' AND environment <> ''),
  CHECK ((current_producer_id IS NULL) = (current_event_id IS NULL)),
  CHECK ((pending_producer_id IS NULL) = (pending_event_id IS NULL)),
  CHECK (reconciliation_required = (pending_event_id IS NOT NULL))
);
