CREATE TABLE observation_imports (
  tenant_id text NOT NULL,
  repository_id text NOT NULL,
  service_id text NOT NULL,
  environment text NOT NULL,
  import_id uuid NOT NULL,
  snapshot_id text NOT NULL,
  revision text NOT NULL,
  config_fingerprint text NOT NULL,
  checkpoint_version bigint NOT NULL CHECK (checkpoint_version > 0),
  source_id text NOT NULL,
  source_version text NOT NULL,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  policy_version text NOT NULL CHECK (policy_version = 'metadata-only-1'),
  safe_manifest jsonb NOT NULL CHECK (jsonb_typeof(safe_manifest) = 'array'),
  imported_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, repository_id, service_id, environment, import_id),
  FOREIGN KEY (tenant_id, repository_id, service_id, snapshot_id)
    REFERENCES catalog_snapshots (tenant_id, repository_id, service_id, snapshot_id) ON DELETE RESTRICT,
  CHECK (tenant_id <> '' AND repository_id <> '' AND service_id <> '' AND environment <> ''
    AND snapshot_id <> '' AND revision <> '' AND config_fingerprint <> '' AND source_id <> ''
    AND source_version <> '' AND window_start <= window_end)
);

CREATE TABLE observation_records (
  tenant_id text NOT NULL,
  repository_id text NOT NULL,
  service_id text NOT NULL,
  environment text NOT NULL,
  import_id uuid NOT NULL,
  record_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('confirmed', 'unresolved')),
  reason text,
  endpoint_id text,
  mapping_id text,
  method text CHECK (method IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')),
  status_code integer CHECK (status_code BETWEEN 100 AND 599),
  completeness text NOT NULL CHECK (completeness = 'metadata_only'),
  policy_version text NOT NULL CHECK (policy_version = 'metadata-only-1'),
  PRIMARY KEY (tenant_id, repository_id, service_id, environment, import_id, record_id),
  FOREIGN KEY (tenant_id, repository_id, service_id, environment, import_id)
    REFERENCES observation_imports (tenant_id, repository_id, service_id, environment, import_id) ON DELETE RESTRICT,
  CHECK ((status = 'confirmed' AND reason IS NULL AND endpoint_id IS NOT NULL AND mapping_id IS NOT NULL
    AND method IS NOT NULL AND status_code IS NOT NULL)
    OR (status = 'unresolved' AND reason IS NOT NULL AND endpoint_id IS NULL AND mapping_id IS NULL))
);

CREATE INDEX observation_records_endpoint_idx ON observation_records
  (tenant_id, repository_id, service_id, environment, endpoint_id)
  WHERE status = 'confirmed';

CREATE TRIGGER observation_imports_immutable BEFORE UPDATE OR DELETE ON observation_imports
FOR EACH ROW EXECUTE FUNCTION orchestration_immutable_row();
CREATE TRIGGER observation_records_immutable BEFORE UPDATE OR DELETE ON observation_records
FOR EACH ROW EXECUTE FUNCTION orchestration_immutable_row();
