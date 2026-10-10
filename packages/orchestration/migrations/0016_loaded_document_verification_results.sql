-- A successful loaded-document run, its safe summary, and lease transition
-- must commit together. Results contain metadata only, never tokens or source text.
ALTER TABLE orchestration_loaded_document_verification_jobs
  ADD CONSTRAINT orchestration_loaded_document_jobs_result_identity_uq
    UNIQUE (tenant_id,job_id,load_identity_digest,capture_identity_digest);

ALTER TABLE orchestration_observed_loaded_document_verifications
  ADD CONSTRAINT orchestration_observed_loaded_doc_result_identity_uq
    UNIQUE (tenant_id,load_identity_digest,capture_identity_digest,verifier_profile_version,
      result_digest,handler_count,match_count,unobserved_diagnostic_count);

ALTER TABLE orchestration_loaded_document_verification_job_state
  ADD COLUMN verification_result_digest text CHECK (verification_result_digest IS NULL
    OR verification_result_digest ~ '^sha256:[a-f0-9]{64}$'),
  ADD COLUMN verification_attempt_no integer CHECK (verification_attempt_no IS NULL
    OR verification_attempt_no BETWEEN 1 AND 3),
  ADD COLUMN completed_at timestamptz,
  ADD COLUMN verification_error_code text CHECK (verification_error_code IS NULL OR verification_error_code IN
    ('LOADED_DOCUMENT_VERIFICATION_UNVERIFIED','LOADED_DOCUMENT_VERIFICATION_TRANSIENT')),
  ADD CONSTRAINT orchestration_loaded_document_state_completion_ck CHECK (
    (state = 'succeeded' AND verification_result_digest IS NOT NULL AND verification_attempt_no IS NOT NULL
      AND verification_attempt_no=attempt_count AND completed_at IS NOT NULL AND verification_error_code IS NULL)
    OR (state <> 'succeeded' AND verification_result_digest IS NULL AND verification_attempt_no IS NULL
      AND completed_at IS NULL)),
  ADD CONSTRAINT orchestration_loaded_document_state_error_ck CHECK (
    verification_error_code IS NULL OR state IN ('retry_wait','failed'));

CREATE TABLE orchestration_loaded_document_verification_results (
  tenant_id text NOT NULL,
  job_id text NOT NULL,
  load_identity_digest text NOT NULL CHECK (load_identity_digest ~ '^sha256:[a-f0-9]{64}$'),
  capture_identity_digest text NOT NULL CHECK (capture_identity_digest ~ '^sha256:[a-f0-9]{64}$'),
  verifier_profile_version text NOT NULL CHECK (verifier_profile_version = 'swagger-loaded-document-1'),
  result_digest text NOT NULL CHECK (result_digest ~ '^sha256:[a-f0-9]{64}$'),
  attempt_no integer NOT NULL CHECK (attempt_no BETWEEN 1 AND 3),
  handler_count integer NOT NULL CHECK (handler_count BETWEEN 1 AND 1024),
  match_count integer NOT NULL CHECK (match_count BETWEEN 1 AND 1024 AND match_count = handler_count),
  unobserved_diagnostic_count integer NOT NULL CHECK (unobserved_diagnostic_count BETWEEN 0 AND 1024),
  completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,job_id),
  CHECK (match_count + unobserved_diagnostic_count <= 1024),
  FOREIGN KEY (tenant_id,job_id,load_identity_digest,capture_identity_digest)
    REFERENCES orchestration_loaded_document_verification_jobs
      (tenant_id,job_id,load_identity_digest,capture_identity_digest) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,load_identity_digest,capture_identity_digest,verifier_profile_version,result_digest,
    handler_count,match_count,unobserved_diagnostic_count)
    REFERENCES orchestration_observed_loaded_document_verifications
      (tenant_id,load_identity_digest,capture_identity_digest,verifier_profile_version,
       result_digest,handler_count,match_count,unobserved_diagnostic_count) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,job_id)
    REFERENCES orchestration_loaded_document_verification_job_state (tenant_id,job_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,job_id,attempt_no)
    REFERENCES orchestration_loaded_document_verification_lease_attempts (tenant_id,job_id,attempt_no) ON DELETE RESTRICT
);

CREATE FUNCTION orchestration_loaded_document_result_state_consistent()
RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
DECLARE
  state_row orchestration_loaded_document_verification_job_state%ROWTYPE;
  result_row orchestration_loaded_document_verification_results%ROWTYPE;
  has_result boolean;
BEGIN
  SELECT * INTO state_row FROM orchestration_loaded_document_verification_job_state
    WHERE tenant_id=NEW.tenant_id AND job_id=NEW.job_id;
  IF state_row.job_id IS NULL THEN RAISE EXCEPTION 'loaded document completion state missing'; END IF;
  SELECT * INTO result_row FROM orchestration_loaded_document_verification_results
    WHERE tenant_id=NEW.tenant_id AND job_id=NEW.job_id;
  has_result := FOUND;
  IF NOT has_result AND state_row.state <> 'succeeded' THEN RETURN NULL; END IF;
  IF state_row.state IS DISTINCT FROM 'succeeded' OR NOT has_result
    OR result_row.job_id IS NULL
    OR state_row.verification_result_digest <> result_row.result_digest
    OR state_row.verification_attempt_no <> result_row.attempt_no
    OR state_row.completed_at <> result_row.completed_at THEN
    RAISE EXCEPTION 'loaded document completion state mismatch';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER orchestration_loaded_document_state_result_consistency
AFTER INSERT OR UPDATE ON orchestration_loaded_document_verification_job_state
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION orchestration_loaded_document_result_state_consistent();

CREATE CONSTRAINT TRIGGER orchestration_loaded_document_result_state_consistency
AFTER INSERT ON orchestration_loaded_document_verification_results
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION orchestration_loaded_document_result_state_consistent();

CREATE FUNCTION orchestration_loaded_document_success_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'loaded document worker state is append only';
  END IF;
  IF OLD.state = 'succeeded' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'loaded document success is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER orchestration_loaded_document_success_immutable
BEFORE UPDATE OR DELETE ON orchestration_loaded_document_verification_job_state
FOR EACH ROW EXECUTE FUNCTION orchestration_loaded_document_success_immutable();

CREATE TRIGGER orchestration_loaded_document_results_immutable
BEFORE UPDATE OR DELETE ON orchestration_loaded_document_verification_results
FOR EACH ROW EXECUTE FUNCTION orchestration_immutable_row();
