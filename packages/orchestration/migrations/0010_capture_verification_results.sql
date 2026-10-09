-- A successful lease has one exact, append-only 0007 verification in the same transaction.
-- This lifecycle link does not create an ordinary snapshot, checkpoint, or serving pointer.
LOCK TABLE orchestration_capture_verification_jobs,
  orchestration_capture_verification_job_state,
  orchestration_observed_capture_verifications IN ACCESS EXCLUSIVE MODE;

ALTER TABLE orchestration_capture_verification_job_state
  ADD COLUMN verification_capture_identity_digest text,
  ADD COLUMN verification_profile_version text,
  ADD COLUMN verification_result_digest text,
  ADD COLUMN verified_at timestamptz,
  ADD COLUMN terminal_reason text CONSTRAINT orchestration_capture_terminal_reason_ck CHECK (terminal_reason IS NULL OR state = 'failed'
    AND terminal_reason = 'CAPTURE_VERIFICATION_UNVERIFIED');

ALTER TABLE orchestration_observed_capture_verifications
  ADD CONSTRAINT orchestration_observed_capture_verifications_exact_result_uq
  UNIQUE (tenant_id,capture_identity_digest,verifier_profile_version,result_digest);

ALTER TABLE orchestration_capture_verification_jobs
  ADD CONSTRAINT orchestration_capture_verification_jobs_result_owner_uq
  UNIQUE (tenant_id,job_id,capture_identity_digest,verifier_profile_version);

ALTER TABLE orchestration_capture_verification_job_state
  ADD CONSTRAINT orchestration_capture_verification_state_result_shape CHECK (
    (state = 'succeeded' AND verification_capture_identity_digest IS NOT NULL
      AND verification_profile_version IS NOT NULL
      AND verification_profile_version = 'protected-handler-bytes-1'
      AND verification_result_digest IS NOT NULL
      AND verification_result_digest ~ '^sha256:[a-f0-9]{64}$' AND verified_at IS NOT NULL)
    OR (state <> 'succeeded' AND verification_capture_identity_digest IS NULL
      AND verification_profile_version IS NULL AND verification_result_digest IS NULL AND verified_at IS NULL)
  ),
  ADD CONSTRAINT orchestration_capture_verification_state_result_fk
    FOREIGN KEY (tenant_id,verification_capture_identity_digest,verification_profile_version,
      verification_result_digest)
    REFERENCES orchestration_observed_capture_verifications
      (tenant_id,capture_identity_digest,verifier_profile_version,result_digest) ON DELETE RESTRICT,
  ADD CONSTRAINT orchestration_capture_verification_state_result_owner_fk
    FOREIGN KEY (tenant_id,job_id,verification_capture_identity_digest,verification_profile_version)
    REFERENCES orchestration_capture_verification_jobs
      (tenant_id,job_id,capture_identity_digest,verifier_profile_version) ON DELETE RESTRICT;
