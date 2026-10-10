-- Derived presence is separate from immutable metadata. These integrity gates
-- do not authenticate callers or prove transport/body-to-record correspondence.
CREATE TABLE observation_field_presence_results (
  tenant_id text NOT NULL,
  repository_id text NOT NULL,
  service_id text NOT NULL,
  environment text NOT NULL,
  policy_id text NOT NULL,
  owner_policy_revision bigint NOT NULL,
  policy_fingerprint text NOT NULL,
  import_id uuid NOT NULL,
  record_id uuid NOT NULL,
  source_digest text NOT NULL CHECK (source_digest ~ '^sha256:[0-9a-f]{64}$'),
  presence_fields jsonb NOT NULL,
  source_window_end timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,repository_id,service_id,environment,policy_id,owner_policy_revision,import_id,record_id),
  FOREIGN KEY (tenant_id,repository_id,service_id,environment,policy_id,owner_policy_revision,policy_fingerprint)
    REFERENCES observation_field_presence_policy_revisions
      (tenant_id,repository_id,service_id,environment,policy_id,owner_policy_revision,policy_fingerprint) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,repository_id,service_id,environment,import_id,record_id)
    REFERENCES observation_records
      (tenant_id,repository_id,service_id,environment,import_id,record_id) ON DELETE RESTRICT,
  CHECK (jsonb_typeof(presence_fields)='array' AND jsonb_array_length(presence_fields) BETWEEN 1 AND 32),
  CHECK (isfinite(source_window_end) AND isfinite(expires_at) AND isfinite(created_at)
    AND source_window_end < expires_at AND created_at < expires_at)
);
CREATE INDEX observation_field_presence_results_expiry_idx ON observation_field_presence_results
  (tenant_id,repository_id,service_id,environment,policy_id,expires_at);

CREATE TABLE observation_field_presence_tombstones (
  tenant_id text NOT NULL,
  repository_id text NOT NULL,
  service_id text NOT NULL,
  environment text NOT NULL,
  policy_id text NOT NULL,
  owner_policy_revision bigint NOT NULL,
  import_id uuid NOT NULL,
  record_id uuid NOT NULL,
  reason text NOT NULL CHECK (reason IN ('deleted','expired')),
  deleted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,repository_id,service_id,environment,policy_id,owner_policy_revision,import_id,record_id),
  FOREIGN KEY (tenant_id,repository_id,service_id,environment,policy_id,owner_policy_revision)
    REFERENCES observation_field_presence_policy_revisions
      (tenant_id,repository_id,service_id,environment,policy_id,owner_policy_revision) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,repository_id,service_id,environment,import_id,record_id)
    REFERENCES observation_records
      (tenant_id,repository_id,service_id,environment,import_id,record_id) ON DELETE RESTRICT
);
-- A tombstone must describe an existing derived row and its deletion must
-- complete in this transaction. Both halves are necessary: an absence-only
-- deferred check would still allow poisoning a never-written parent generation.
CREATE FUNCTION observation_field_presence_tombstone_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE previous_expiry timestamptz;
BEGIN
  PERFORM 1 FROM observation_field_presence_policy_heads WHERE tenant_id=NEW.tenant_id
    AND repository_id=NEW.repository_id AND service_id=NEW.service_id
    AND environment=NEW.environment AND policy_id=NEW.policy_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='invalid field presence tombstone';
  END IF;
  SELECT expires_at INTO previous_expiry FROM observation_field_presence_results WHERE tenant_id=NEW.tenant_id
    AND repository_id=NEW.repository_id AND service_id=NEW.service_id AND environment=NEW.environment
    AND policy_id=NEW.policy_id AND owner_policy_revision=NEW.owner_policy_revision
    AND import_id=NEW.import_id AND record_id=NEW.record_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='field presence tombstone requires existing result';
  END IF;
  NEW.reason:=CASE WHEN previous_expiry<=clock_timestamp() THEN 'expired' ELSE 'deleted' END;
  NEW.deleted_at:=clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER observation_field_presence_tombstones_insert BEFORE INSERT ON observation_field_presence_tombstones
FOR EACH ROW EXECUTE FUNCTION observation_field_presence_tombstone_guard();

CREATE FUNCTION observation_field_presence_tombstone_commit_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM observation_field_presence_results WHERE tenant_id=NEW.tenant_id
    AND repository_id=NEW.repository_id AND service_id=NEW.service_id AND environment=NEW.environment
    AND policy_id=NEW.policy_id AND owner_policy_revision=NEW.owner_policy_revision
    AND import_id=NEW.import_id AND record_id=NEW.record_id) THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='field presence tombstone requires completed deletion';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER observation_field_presence_tombstones_commit AFTER INSERT
ON observation_field_presence_tombstones DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION observation_field_presence_tombstone_commit_guard();

CREATE TRIGGER observation_field_presence_tombstones_immutable BEFORE UPDATE OR DELETE
ON observation_field_presence_tombstones FOR EACH ROW EXECUTE FUNCTION orchestration_immutable_row();

CREATE FUNCTION observation_field_presence_insert_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  head observation_field_presence_policy_heads%ROWTYPE;
  policy observation_field_presence_policy_revisions%ROWTYPE;
  parent observation_records%ROWTYPE;
  imported observation_imports%ROWTYPE;
  existing observation_field_presence_results%ROWTYPE;
  source_sha text;
  item jsonb;
  selected_paths text[];
  live_count bigint;
  db_now timestamptz;
BEGIN
  IF NEW.expires_at IS NOT NULL OR NEW.source_window_end IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='invalid field presence insertion';
  END IF;
  SELECT * INTO head FROM observation_field_presence_policy_heads
    WHERE tenant_id=NEW.tenant_id AND repository_id=NEW.repository_id AND service_id=NEW.service_id
      AND environment=NEW.environment AND policy_id=NEW.policy_id FOR UPDATE;
  IF NOT FOUND OR NOT head.enabled OR head.current_owner_policy_revision<>NEW.owner_policy_revision
    OR head.current_policy_fingerprint<>NEW.policy_fingerprint THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='inactive field presence policy';
  END IF;
  SELECT * INTO STRICT policy FROM observation_field_presence_policy_revisions
    WHERE tenant_id=NEW.tenant_id AND repository_id=NEW.repository_id AND service_id=NEW.service_id
      AND environment=NEW.environment AND policy_id=NEW.policy_id AND owner_policy_revision=NEW.owner_policy_revision;
  IF EXISTS (SELECT 1 FROM observation_field_presence_tombstones
    WHERE tenant_id=NEW.tenant_id AND repository_id=NEW.repository_id AND service_id=NEW.service_id
      AND environment=NEW.environment AND policy_id=NEW.policy_id AND owner_policy_revision=NEW.owner_policy_revision
      AND import_id=NEW.import_id AND record_id=NEW.record_id) THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='deleted field presence generation';
  END IF;
  SELECT * INTO parent FROM observation_records WHERE tenant_id=NEW.tenant_id AND repository_id=NEW.repository_id
    AND service_id=NEW.service_id AND environment=NEW.environment AND import_id=NEW.import_id AND record_id=NEW.record_id;
  IF NOT FOUND OR parent.status<>'confirmed' OR parent.completeness<>'metadata_only'
    OR parent.policy_version<>'metadata-only-1' OR parent.endpoint_id<>policy.endpoint_id
    OR policy.direction='response' AND parent.status_code<>policy.status_code THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='invalid field presence parent';
  END IF;
  SELECT * INTO STRICT imported FROM observation_imports WHERE tenant_id=NEW.tenant_id AND repository_id=NEW.repository_id
    AND service_id=NEW.service_id AND environment=NEW.environment AND import_id=NEW.import_id;
  SELECT document #>> '{source,source_digest}' INTO source_sha FROM catalog_snapshots WHERE tenant_id=NEW.tenant_id
    AND repository_id=NEW.repository_id AND service_id=NEW.service_id AND snapshot_id=imported.snapshot_id
      AND immutable_revision=imported.revision AND config_fingerprint=imported.config_fingerprint;
  db_now:=clock_timestamp();
  IF imported.config_fingerprint<>policy.config_fingerprint OR source_sha IS DISTINCT FROM NEW.source_digest
    OR NOT isfinite(imported.window_start) OR NOT isfinite(imported.window_end) OR NOT isfinite(imported.imported_at)
    OR imported.window_end>imported.imported_at OR imported.window_end>db_now THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='invalid field presence lineage';
  END IF;
  NEW.source_window_end:=imported.window_end;
  NEW.expires_at:=imported.window_end+make_interval(secs=>policy.ttl_seconds);
  NEW.created_at:=db_now;
  IF NEW.expires_at<=db_now THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='expired field presence window';
  END IF;
  IF jsonb_typeof(NEW.presence_fields) IS DISTINCT FROM 'array'
    OR jsonb_array_length(NEW.presence_fields) IS DISTINCT FROM cardinality(policy.property_paths) THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='invalid field presence states';
  END IF;
  selected_paths:=ARRAY[]::text[];
  FOR item IN SELECT value FROM jsonb_array_elements(NEW.presence_fields) LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object'
      OR (SELECT count(*) FROM jsonb_object_keys(item))<>2
      OR jsonb_typeof(item->'path') IS DISTINCT FROM 'string'
      OR jsonb_typeof(item->'state') IS DISTINCT FROM 'string'
      OR item->>'state' NOT IN ('present','absent') THEN
      RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='invalid field presence states';
    END IF;
    selected_paths:=array_append(selected_paths,item->>'path');
  END LOOP;
  IF selected_paths IS DISTINCT FROM policy.property_paths THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='invalid field presence paths';
  END IF;
  SELECT * INTO existing FROM observation_field_presence_results WHERE tenant_id=NEW.tenant_id
    AND repository_id=NEW.repository_id AND service_id=NEW.service_id AND environment=NEW.environment
    AND policy_id=NEW.policy_id AND owner_policy_revision=NEW.owner_policy_revision
    AND import_id=NEW.import_id AND record_id=NEW.record_id;
  IF FOUND THEN
    IF existing.presence_fields IS DISTINCT FROM NEW.presence_fields OR existing.source_digest IS DISTINCT FROM NEW.source_digest
      OR existing.policy_fingerprint IS DISTINCT FROM NEW.policy_fingerprint OR existing.expires_at IS DISTINCT FROM NEW.expires_at THEN
      RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='conflicting field presence replay';
    END IF;
    RETURN NEW;
  END IF;
  -- Hidden old generations still consume the unexpired-record budget until cleanup.
  SELECT count(*) INTO live_count FROM observation_field_presence_results WHERE tenant_id=NEW.tenant_id
    AND repository_id=NEW.repository_id AND service_id=NEW.service_id AND environment=NEW.environment
    AND policy_id=NEW.policy_id AND expires_at>db_now;
  IF live_count>=policy.max_live_records THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='field presence budget exhausted';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER observation_field_presence_results_insert BEFORE INSERT ON observation_field_presence_results
FOR EACH ROW EXECUTE FUNCTION observation_field_presence_insert_guard();
CREATE TRIGGER observation_field_presence_results_no_update BEFORE UPDATE ON observation_field_presence_results
FOR EACH ROW EXECUTE FUNCTION orchestration_immutable_row();

CREATE FUNCTION observation_field_presence_delete_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM observation_field_presence_tombstones WHERE tenant_id=OLD.tenant_id
    AND repository_id=OLD.repository_id AND service_id=OLD.service_id AND environment=OLD.environment
    AND policy_id=OLD.policy_id AND owner_policy_revision=OLD.owner_policy_revision
    AND import_id=OLD.import_id AND record_id=OLD.record_id) THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='field presence deletion requires tombstone';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER observation_field_presence_results_delete BEFORE DELETE ON observation_field_presence_results
FOR EACH ROW EXECUTE FUNCTION observation_field_presence_delete_guard();

-- Internal SQL maintenance primitive: invoker rights, no authentication or grants.
-- Lock the policy head before any result row to serialize with insertion/budgets.
CREATE FUNCTION observation_field_presence_delete(p_tenant text,p_repository text,p_service text,p_environment text,
  p_policy text,p_revision bigint,p_import uuid,p_record uuid)
RETURNS boolean LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE removed integer;
BEGIN
  PERFORM 1 FROM observation_field_presence_policy_heads WHERE tenant_id=p_tenant AND repository_id=p_repository
    AND service_id=p_service AND environment=p_environment AND policy_id=p_policy FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO observation_field_presence_tombstones
    (tenant_id,repository_id,service_id,environment,policy_id,owner_policy_revision,import_id,record_id,reason)
    SELECT tenant_id,repository_id,service_id,environment,policy_id,owner_policy_revision,import_id,record_id,
      CASE WHEN expires_at<=clock_timestamp() THEN 'expired' ELSE 'deleted' END
    FROM observation_field_presence_results WHERE tenant_id=p_tenant AND repository_id=p_repository
      AND service_id=p_service AND environment=p_environment AND policy_id=p_policy AND owner_policy_revision=p_revision
      AND import_id=p_import AND record_id=p_record ON CONFLICT DO NOTHING;
  DELETE FROM observation_field_presence_results WHERE tenant_id=p_tenant AND repository_id=p_repository
    AND service_id=p_service AND environment=p_environment AND policy_id=p_policy AND owner_policy_revision=p_revision
    AND import_id=p_import AND record_id=p_record;
  GET DIAGNOSTICS removed=ROW_COUNT;
  RETURN removed=1;
END;
$$;
CREATE VIEW observation_field_presence_live_results AS SELECT result.* FROM observation_field_presence_results result
  JOIN observation_field_presence_policy_heads head USING (tenant_id,repository_id,service_id,environment,policy_id)
  WHERE head.enabled AND head.current_owner_policy_revision=result.owner_policy_revision
    AND head.current_policy_fingerprint=result.policy_fingerprint AND result.expires_at>clock_timestamp();
