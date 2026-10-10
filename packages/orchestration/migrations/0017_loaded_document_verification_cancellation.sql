-- Separate manager cancellation releases active capacity without removing historical proof.
ALTER TABLE orchestration_loaded_document_verification_job_state
  ADD COLUMN terminal_reason text,
  ADD CONSTRAINT orchestration_loaded_document_terminal_reason_ck CHECK (
    terminal_reason IS NULL OR (state='cancelled' AND terminal_reason='LOADED_DOCUMENT_CONFIG_SUPERSEDED'));
