-- Superseded capture jobs are terminal without claiming verification or changing 0008 admission.
LOCK TABLE orchestration_capture_verification_jobs,
  orchestration_capture_verification_job_state IN ACCESS EXCLUSIVE MODE;

ALTER TABLE orchestration_capture_verification_job_state
  DROP CONSTRAINT orchestration_capture_terminal_reason_ck,
  ADD CONSTRAINT orchestration_capture_terminal_reason_ck CHECK (
    terminal_reason IS NULL OR
    (state = 'failed' AND terminal_reason = 'CAPTURE_VERIFICATION_UNVERIFIED') OR
    (state = 'cancelled' AND terminal_reason = 'CAPTURE_CONFIG_SUPERSEDED')
  );
