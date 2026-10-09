CREATE TABLE semantic_inference_history (
  history_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id text NOT NULL,
  principal_id text NOT NULL,
  repository_id text NOT NULL,
  service_id text NOT NULL,
  selector_kind text NOT NULL CHECK (selector_kind IN ('revision','branch','environment')),
  selector_value text NOT NULL,
  selector_version text,
  snapshot_id text NOT NULL,
  revision text NOT NULL,
  config_fingerprint text NOT NULL,
  configuration_hash text NOT NULL CHECK (configuration_hash ~ '^sha256:[0-9a-f]{64}$'),
  provider text NOT NULL CHECK (provider IN ('openai','gemini','claude')),
  model text NOT NULL,
  prompt_version text NOT NULL CHECK (prompt_version IN
    ('semantic-grounding-1','semantic-discovery-1','semantic-discovery-source-1')),
  requested_endpoint_ids text[] NOT NULL,
  safe_result jsonb NOT NULL CHECK (jsonb_typeof(safe_result) = 'object'
    AND octet_length(safe_result::text) <= 16384),
  record_sha256 text NOT NULL CHECK (record_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, repository_id, service_id, snapshot_id)
    REFERENCES catalog_snapshots (tenant_id, repository_id, service_id, snapshot_id) ON DELETE RESTRICT,
  CHECK (tenant_id <> '' AND principal_id <> '' AND repository_id <> '' AND service_id <> ''
    AND selector_value <> '' AND snapshot_id <> '' AND revision <> '' AND config_fingerprint <> ''
    AND model <> '' AND cardinality(requested_endpoint_ids) BETWEEN 1 AND 16),
  CHECK ((selector_kind = 'revision' AND selector_version IS NULL)
    OR (selector_kind IN ('branch','environment') AND selector_version ~ '^[1-9][0-9]{0,18}$'))
);

CREATE INDEX semantic_inference_history_current_idx ON semantic_inference_history
  (tenant_id, principal_id, repository_id, service_id, selector_kind, selector_value,
    snapshot_id, revision, config_fingerprint, history_id DESC);

CREATE TRIGGER semantic_inference_history_immutable BEFORE UPDATE OR DELETE ON semantic_inference_history
FOR EACH ROW EXECUTE FUNCTION orchestration_immutable_row();
