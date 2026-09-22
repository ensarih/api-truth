CREATE FUNCTION catalog_scope_array_is_canonical(value text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT cardinality(value) > 0
    AND array_position(value, NULL) IS NULL
    AND array_position(value, '') IS NULL
    AND value = ARRAY(
      SELECT item
      FROM unnest(value) AS scope_items(item)
      ORDER BY item COLLATE "C"
    )
    AND cardinality(value) = (
      SELECT count(DISTINCT item COLLATE "C")
      FROM unnest(value) AS distinct_scope_items(item)
    );
$$;

CREATE TABLE access_scopes (
  tenant_id text NOT NULL,
  access_scope_id text NOT NULL,
  active boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, access_scope_id),
  CHECK (tenant_id <> '' AND access_scope_id <> '')
);

CREATE TABLE principal_scope_grants (
  tenant_id text NOT NULL,
  principal_id text NOT NULL,
  access_scope_id text NOT NULL,
  active boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, principal_id, access_scope_id),
  FOREIGN KEY (tenant_id, access_scope_id)
    REFERENCES access_scopes (tenant_id, access_scope_id) ON DELETE RESTRICT,
  CHECK (tenant_id <> '' AND principal_id <> '' AND access_scope_id <> '')
);

CREATE INDEX principal_scope_grants_active_idx
  ON principal_scope_grants (tenant_id, principal_id, access_scope_id)
  WHERE active;

CREATE TABLE catalog_snapshots (
  tenant_id text NOT NULL,
  snapshot_id text NOT NULL,
  repository_id text NOT NULL,
  service_id text NOT NULL,
  immutable_revision text NOT NULL,
  analyzer_status text NOT NULL CHECK (analyzer_status IN ('success', 'partial')),
  ir_version text NOT NULL,
  identity_version text NOT NULL,
  config_fingerprint text NOT NULL,
  identity_sha256 text NOT NULL CHECK (identity_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  required_scope_ids text[] NOT NULL,
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  ingested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, snapshot_id),
  UNIQUE (tenant_id, repository_id, service_id, snapshot_id),
  CHECK (catalog_scope_array_is_canonical(required_scope_ids)),
  CHECK (
    tenant_id <> ''
    AND snapshot_id <> ''
    AND repository_id <> ''
    AND service_id <> ''
    AND immutable_revision <> ''
    AND ir_version <> ''
    AND identity_version <> ''
    AND config_fingerprint <> ''
  )
);

CREATE INDEX catalog_snapshots_service_revision_idx
  ON catalog_snapshots (tenant_id, service_id, immutable_revision);

CREATE TABLE catalog_branch_pointers (
  tenant_id text NOT NULL,
  repository_id text NOT NULL,
  service_id text NOT NULL,
  branch text NOT NULL,
  snapshot_id text NOT NULL,
  pointer_version bigint NOT NULL DEFAULT 1 CHECK (pointer_version > 0),
  provider text NOT NULL,
  provider_reference text NOT NULL,
  order_kind text CHECK (order_kind IN ('sequence', 'cursor', 'effective_version')),
  order_value text,
  promoted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, repository_id, service_id, branch),
  FOREIGN KEY (tenant_id, repository_id, service_id, snapshot_id)
    REFERENCES catalog_snapshots (tenant_id, repository_id, service_id, snapshot_id) ON DELETE RESTRICT,
  CHECK ((order_kind IS NULL) = (order_value IS NULL)),
  CHECK (
    tenant_id <> ''
    AND repository_id <> ''
    AND service_id <> ''
    AND branch <> ''
    AND snapshot_id <> ''
    AND provider <> ''
    AND provider_reference <> ''
    AND (order_value IS NULL OR order_value <> '')
  )
);

CREATE FUNCTION catalog_snapshot_scope_ids_exist()
RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM unnest(NEW.required_scope_ids) AS required(access_scope_id)
    WHERE NOT EXISTS (
      SELECT 1
      FROM access_scopes scope
      WHERE scope.tenant_id = NEW.tenant_id
        AND scope.access_scope_id = required.access_scope_id
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'unknown required access scope';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER catalog_snapshot_scope_ids_exist_at_commit
AFTER INSERT ON catalog_snapshots
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION catalog_snapshot_scope_ids_exist();

CREATE FUNCTION catalog_snapshot_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'immutable catalog row';
END;
$$;

CREATE TRIGGER catalog_snapshot_is_immutable
BEFORE UPDATE OR DELETE ON catalog_snapshots
FOR EACH ROW EXECUTE FUNCTION catalog_snapshot_is_immutable();
