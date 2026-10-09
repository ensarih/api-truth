-- Mutable lease state is separate from immutable 0008 admission and ordinary D08 jobs.
LOCK TABLE orchestration_capture_verification_jobs IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE orchestration_capture_verification_job_state (
  tenant_id text NOT NULL,
  job_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('queued','leased','retry_wait','succeeded','failed','cancelled')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_worker_id text,
  lease_instance_id text,
  lease_token_hash text CHECK (lease_token_hash IS NULL OR lease_token_hash ~ '^sha256:[a-f0-9]{64}$'),
  lease_expires_at timestamptz,
  safe_error_code text CHECK (safe_error_code IS NULL OR safe_error_code = 'CAPTURE_LEASE_EXHAUSTED'),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, job_id),
  FOREIGN KEY (tenant_id, job_id)
    REFERENCES orchestration_capture_verification_jobs (tenant_id, job_id) ON DELETE RESTRICT,
  CHECK ((state = 'leased' AND lease_worker_id IS NOT NULL AND lease_instance_id IS NOT NULL
    AND lease_token_hash IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state <> 'leased' AND lease_worker_id IS NULL AND lease_instance_id IS NULL
    AND lease_token_hash IS NULL AND lease_expires_at IS NULL))
);

CREATE INDEX orchestration_capture_verification_state_ready_idx
  ON orchestration_capture_verification_job_state (tenant_id, state, available_at, job_id);

CREATE FUNCTION orchestration_enqueue_capture_verification_state()
RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
BEGIN
  INSERT INTO orchestration_capture_verification_job_state (tenant_id,job_id,state)
  VALUES (NEW.tenant_id,NEW.job_id,'queued');
  RETURN NEW;
END;
$$;

CREATE TRIGGER orchestration_capture_verification_jobs_enqueue
AFTER INSERT ON orchestration_capture_verification_jobs
FOR EACH ROW EXECUTE FUNCTION orchestration_enqueue_capture_verification_state();

INSERT INTO orchestration_capture_verification_job_state (tenant_id,job_id,state)
SELECT tenant_id,job_id,'queued' FROM orchestration_capture_verification_jobs;
