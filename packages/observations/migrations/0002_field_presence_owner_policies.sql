-- Owner policy history contains static configuration only. It stores no traffic,
-- projected presence, payload, source record, or computed retention timestamp.
CREATE FUNCTION observation_field_presence_paths_are_valid(paths text[])
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  path text;
  segment text;
  decoded text;
  normalized text;
  segments text[];
BEGIN
  IF array_ndims(paths) IS DISTINCT FROM 1 OR array_lower(paths,1) IS DISTINCT FROM 1 THEN
    RETURN false;
  END IF;
  IF cardinality(paths) NOT BETWEEN 1 AND 32 OR array_position(paths,NULL) IS NOT NULL
    OR array_position(paths,'') IS NOT NULL
    OR paths <> ARRAY(SELECT item FROM unnest(paths) AS selected(item) ORDER BY item COLLATE "C")
    OR cardinality(paths) <> (SELECT count(DISTINCT item COLLATE "C") FROM unnest(paths) AS selected(item)) THEN
    RETURN false;
  END IF;
  FOREACH path IN ARRAY paths LOOP
    IF length(path) NOT BETWEEN 2 AND 512 OR path !~ '^/[^/]+(/[^/]+){0,11}$' THEN
      RETURN false;
    END IF;
    segments := string_to_array(substr(path,2),'/');
    FOREACH segment IN ARRAY segments LOOP
      IF length(segment)>128 OR segment ~ '~([^01]|$)' THEN RETURN false; END IF;
      decoded := replace(replace(segment,'~1','/'),'~0','~');
      normalized := regexp_replace(lower(decoded),'[^a-z0-9]','','g');
      IF length(decoded)>128 OR decoded ~ '[[:cntrl:]]' OR decoded='*'
        OR decoded ~* '^(__proto__|prototype|constructor)$'
        OR normalized ~ '(email|phone|mobile|ssn|socialsecurity|creditcard|cardnumber|dateofbirth|birthdate|firstname|lastname|givenname|familyname|postalcode|streetaddress)' THEN
        RETURN false;
      END IF;
    END LOOP;
  END LOOP;
  RETURN true;
END;
$$;

CREATE TABLE observation_field_presence_policy_revisions (
  tenant_id text NOT NULL,
  repository_id text NOT NULL,
  service_id text NOT NULL,
  environment text NOT NULL,
  policy_id text NOT NULL,
  owner_policy_revision bigint NOT NULL CHECK (owner_policy_revision > 0),
  policy_fingerprint text NOT NULL CHECK (policy_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  config_fingerprint text NOT NULL,
  config_activation_checkpoint bigint NOT NULL CHECK (config_activation_checkpoint > 0),
  endpoint_id text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('request','response')),
  media_type text NOT NULL,
  status_code integer,
  property_paths text[] NOT NULL CHECK (observation_field_presence_paths_are_valid(property_paths)),
  ttl_seconds integer NOT NULL CHECK (ttl_seconds BETWEEN 60 AND 2592000),
  max_live_records integer NOT NULL CHECK (max_live_records BETWEEN 1 AND 10000),
  owner_access_scope_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,repository_id,service_id,environment,policy_id,owner_policy_revision),
  UNIQUE (tenant_id,repository_id,service_id,environment,policy_id,owner_policy_revision,policy_fingerprint),
  FOREIGN KEY (tenant_id,config_fingerprint)
    REFERENCES orchestration_configurations (tenant_id,config_fingerprint) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,owner_access_scope_id)
    REFERENCES access_scopes (tenant_id,access_scope_id) ON DELETE RESTRICT,
  CHECK (tenant_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND repository_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    AND service_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND environment ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    AND policy_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' AND config_fingerprint <> ''
    AND endpoint_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    AND config_fingerprint ~ '^sha256:[0-9a-f]{64}$' AND media_type ~* '^application/(?:[a-z0-9.+-]+\+)?json$'
    AND length(media_type) BETWEEN 1 AND 128 AND owner_access_scope_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CHECK ((direction = 'request' AND status_code IS NULL)
    OR (direction = 'response' AND status_code IS NOT NULL AND status_code BETWEEN 100 AND 599))
);

CREATE TRIGGER observation_field_presence_policy_revisions_immutable
BEFORE UPDATE OR DELETE ON observation_field_presence_policy_revisions
FOR EACH ROW EXECUTE FUNCTION orchestration_immutable_row();

CREATE TABLE observation_field_presence_policy_heads (
  tenant_id text NOT NULL,
  repository_id text NOT NULL,
  service_id text NOT NULL,
  environment text NOT NULL,
  policy_id text NOT NULL,
  current_owner_policy_revision bigint NOT NULL CHECK (current_owner_policy_revision > 0),
  current_policy_fingerprint text NOT NULL CHECK (current_policy_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  enabled boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,repository_id,service_id,environment,policy_id),
  FOREIGN KEY (tenant_id,repository_id,service_id,environment,policy_id,
    current_owner_policy_revision,current_policy_fingerprint)
    REFERENCES observation_field_presence_policy_revisions
      (tenant_id,repository_id,service_id,environment,policy_id,owner_policy_revision,policy_fingerprint)
    ON DELETE RESTRICT
);

CREATE FUNCTION observation_field_presence_policy_head_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='field presence policy head cannot be deleted';
  END IF;
  IF ROW(NEW.tenant_id,NEW.repository_id,NEW.service_id,NEW.environment,NEW.policy_id)
      IS DISTINCT FROM ROW(OLD.tenant_id,OLD.repository_id,OLD.service_id,OLD.environment,OLD.policy_id)
    OR NEW.current_owner_policy_revision < OLD.current_owner_policy_revision
    OR NEW.current_owner_policy_revision = OLD.current_owner_policy_revision
      AND NEW.current_policy_fingerprint IS DISTINCT FROM OLD.current_policy_fingerprint
    OR NEW.current_owner_policy_revision = OLD.current_owner_policy_revision
      AND OLD.enabled = false AND NEW.enabled = true THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='invalid field presence policy head transition';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER observation_field_presence_policy_head_guard
BEFORE UPDATE OR DELETE ON observation_field_presence_policy_heads
FOR EACH ROW EXECUTE FUNCTION observation_field_presence_policy_head_guard();
