-- Mutable worker state is separate from immutable loaded-document admissions.
LOCK TABLE orchestration_loaded_document_verification_jobs IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE orchestration_loaded_document_verification_job_state (
  tenant_id text NOT NULL,
  job_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('queued','leased','retry_wait','succeeded','failed','cancelled')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_worker_id text CHECK (lease_worker_id IS NULL OR lease_worker_id ~ '^[A-Za-z0-9_.-]{1,128}$'),
  lease_instance_id text CHECK (lease_instance_id IS NULL OR lease_instance_id ~ '^[A-Za-z0-9_.-]{1,128}$'),
  lease_token_hash text CHECK (lease_token_hash IS NULL OR lease_token_hash ~ '^sha256:[a-f0-9]{64}$'),
  lease_expires_at timestamptz,
  safe_error_code text CHECK (safe_error_code IS NULL OR safe_error_code = 'LOADED_DOCUMENT_LEASE_EXHAUSTED'),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, job_id),
  FOREIGN KEY (tenant_id, job_id)
    REFERENCES orchestration_loaded_document_verification_jobs (tenant_id, job_id) ON DELETE RESTRICT,
  CHECK ((state = 'leased' AND lease_worker_id IS NOT NULL AND lease_instance_id IS NOT NULL
    AND lease_token_hash IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state <> 'leased' AND lease_worker_id IS NULL AND lease_instance_id IS NULL
    AND lease_token_hash IS NULL AND lease_expires_at IS NULL)),
  CHECK (state = 'failed' OR safe_error_code IS NULL)
);

CREATE TABLE orchestration_loaded_document_verification_lease_attempts (
  tenant_id text NOT NULL,
  job_id text NOT NULL,
  attempt_no integer NOT NULL CHECK (attempt_no BETWEEN 1 AND 3),
  worker_id text NOT NULL CHECK (worker_id ~ '^[A-Za-z0-9_.-]{1,128}$'),
  instance_id text NOT NULL CHECK (instance_id ~ '^[A-Za-z0-9_.-]{1,128}$'),
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  initial_lease_expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, job_id, attempt_no),
  FOREIGN KEY (tenant_id, job_id)
    REFERENCES orchestration_loaded_document_verification_jobs (tenant_id, job_id) ON DELETE RESTRICT,
  CHECK (initial_lease_expires_at > claimed_at)
);

CREATE INDEX orchestration_loaded_document_verification_state_ready_idx
  ON orchestration_loaded_document_verification_job_state (tenant_id, state, available_at, job_id);
CREATE INDEX orchestration_loaded_document_verification_state_live_idx
  ON orchestration_loaded_document_verification_job_state (tenant_id, lease_expires_at)
  WHERE state = 'leased';

CREATE FUNCTION orchestration_enqueue_loaded_document_verification_state()
RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
BEGIN
  INSERT INTO orchestration_loaded_document_verification_job_state (tenant_id,job_id,state)
  VALUES (NEW.tenant_id,NEW.job_id,'queued');
  RETURN NEW;
END;
$$;

CREATE TRIGGER orchestration_loaded_document_verification_jobs_enqueue
AFTER INSERT ON orchestration_loaded_document_verification_jobs
FOR EACH ROW EXECUTE FUNCTION orchestration_enqueue_loaded_document_verification_state();

INSERT INTO orchestration_loaded_document_verification_job_state (tenant_id,job_id,state)
SELECT tenant_id,job_id,'queued' FROM orchestration_loaded_document_verification_jobs;

CREATE TRIGGER orchestration_loaded_document_verification_lease_attempts_immutable
BEFORE UPDATE OR DELETE ON orchestration_loaded_document_verification_lease_attempts
FOR EACH ROW EXECUTE FUNCTION orchestration_immutable_row();
