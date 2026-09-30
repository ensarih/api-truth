CREATE TABLE environment_deployment_attempts (
  tenant_id text NOT NULL,
  producer_id text NOT NULL,
  event_id text NOT NULL,
  repository_id text NOT NULL,
  service_id text NOT NULL,
  environment text NOT NULL,
  deployment_id text NOT NULL,
  attempt_state text NOT NULL CHECK (attempt_state IN
    ('pending', 'succeeded', 'failed', 'rollback_requested', 'rolled_back')),
  effective_order text NOT NULL,
  artifact_id text,
  revision_state text NOT NULL CHECK (revision_state IN ('known', 'unknown')),
  revision text,
  target_revision text,
  configuration_digest text,
  active_config_fingerprint text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, producer_id, event_id),
  FOREIGN KEY (tenant_id, producer_id, event_id)
    REFERENCES orchestration_events (tenant_id, producer_id, event_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, active_config_fingerprint)
    REFERENCES orchestration_configurations (tenant_id, config_fingerprint) ON DELETE RESTRICT,
  CHECK (tenant_id <> '' AND producer_id <> '' AND event_id <> '' AND repository_id <> ''
    AND service_id <> '' AND environment <> '' AND deployment_id <> '' AND effective_order <> ''
    AND (artifact_id IS NULL OR artifact_id <> '') AND (target_revision IS NULL OR target_revision <> '')
    AND (configuration_digest IS NULL OR configuration_digest <> '')),
  CHECK ((revision_state = 'known' AND revision IS NOT NULL AND revision <> '')
    OR (revision_state = 'unknown' AND revision IS NULL))
);

CREATE INDEX environment_attempts_scope_idx ON environment_deployment_attempts
  (tenant_id, repository_id, service_id, environment, recorded_at);

CREATE TRIGGER environment_deployment_attempts_immutable
BEFORE UPDATE OR DELETE ON environment_deployment_attempts
FOR EACH ROW EXECUTE FUNCTION orchestration_immutable_row();

CREATE TABLE environment_artifact_bindings (
  tenant_id text NOT NULL,
  repository_id text NOT NULL,
  service_id text NOT NULL,
  artifact_id text NOT NULL,
  revision text NOT NULL,
  first_producer_id text NOT NULL,
  first_event_id text NOT NULL,
  bound_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, repository_id, service_id, artifact_id),
  FOREIGN KEY (tenant_id, first_producer_id, first_event_id)
    REFERENCES environment_deployment_attempts (tenant_id, producer_id, event_id) ON DELETE RESTRICT,
  CHECK (tenant_id <> '' AND repository_id <> '' AND service_id <> '' AND artifact_id <> ''
    AND revision <> '' AND first_producer_id <> '' AND first_event_id <> '')
);

CREATE TRIGGER environment_artifact_bindings_immutable
BEFORE UPDATE OR DELETE ON environment_artifact_bindings
FOR EACH ROW EXECUTE FUNCTION orchestration_immutable_row();
