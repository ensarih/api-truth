CREATE TABLE openapi_artifacts (
  tenant_id text NOT NULL CHECK (tenant_id <> ''),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  bytes bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, content_sha256)
);

CREATE TABLE openapi_publications (
  publication_id text PRIMARY KEY CHECK (publication_id ~ '^sha256:[0-9a-f]{64}$'),
  tenant_id text NOT NULL,
  repository_id text NOT NULL,
  service_id text NOT NULL,
  selector_kind text NOT NULL CHECK (selector_kind IN ('revision', 'branch', 'environment')),
  selector_value text NOT NULL,
  branch_pointer_version bigint CHECK (branch_pointer_version > 0),
  environment_checkpoint_version bigint CHECK (environment_checkpoint_version > 0),
  snapshot_id text NOT NULL,
  immutable_revision text NOT NULL,
  config_version text NOT NULL,
  config_fingerprint text NOT NULL,
  source_digest text NOT NULL,
  snapshot_content_sha256 text NOT NULL CHECK (snapshot_content_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  content_sha256 text NOT NULL,
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, repository_id, service_id, snapshot_id)
    REFERENCES catalog_snapshots(tenant_id, repository_id, service_id, snapshot_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, content_sha256)
    REFERENCES openapi_artifacts(tenant_id, content_sha256) ON DELETE RESTRICT,
  UNIQUE (tenant_id, repository_id, service_id, selector_kind, selector_value, publication_id),
  CHECK (tenant_id <> '' AND repository_id <> '' AND service_id <> '' AND selector_value <> ''
    AND snapshot_id <> '' AND immutable_revision <> '' AND config_version <> ''
    AND config_fingerprint <> '' AND source_digest <> ''),
  CHECK ((selector_kind = 'revision' AND selector_value = immutable_revision
      AND branch_pointer_version IS NULL AND environment_checkpoint_version IS NULL)
    OR (selector_kind = 'branch' AND branch_pointer_version IS NOT NULL
      AND environment_checkpoint_version IS NULL)
    OR (selector_kind = 'environment' AND branch_pointer_version IS NULL
      AND environment_checkpoint_version IS NOT NULL))
);

CREATE TABLE openapi_current_pointers (
  tenant_id text NOT NULL,
  repository_id text NOT NULL,
  service_id text NOT NULL,
  selector_kind text NOT NULL CHECK (selector_kind IN ('revision', 'branch', 'environment')),
  selector_value text NOT NULL,
  publication_id text NOT NULL,
  pointer_version bigint NOT NULL CHECK (pointer_version > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, repository_id, service_id, selector_kind, selector_value),
  FOREIGN KEY (tenant_id, repository_id, service_id, selector_kind, selector_value, publication_id)
    REFERENCES openapi_publications(tenant_id, repository_id, service_id, selector_kind, selector_value, publication_id)
    ON DELETE RESTRICT
);

CREATE FUNCTION openapi_immutable_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'immutable OpenAPI row';
END;
$$;
CREATE TRIGGER openapi_artifacts_immutable BEFORE UPDATE OR DELETE ON openapi_artifacts
  FOR EACH ROW EXECUTE FUNCTION openapi_immutable_row();
CREATE TRIGGER openapi_publications_immutable BEFORE UPDATE OR DELETE ON openapi_publications
  FOR EACH ROW EXECUTE FUNCTION openapi_immutable_row();
