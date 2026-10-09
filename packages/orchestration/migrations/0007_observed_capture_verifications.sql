-- Byte verification is capture-qualified metadata, never a catalog/IR snapshot or serving pointer.
CREATE TABLE orchestration_observed_capture_verifications (
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[A-Za-z0-9_.-]{1,128}$'),
  capture_identity_digest text NOT NULL CHECK (capture_identity_digest ~ '^sha256:[a-f0-9]{64}$'),
  verifier_profile_version text NOT NULL CHECK (verifier_profile_version = 'protected-handler-bytes-1'),
  service_root text NOT NULL CHECK (length(service_root) BETWEEN 1 AND 1024
    AND service_root ~ '^(\.|[A-Za-z0-9_@+.-]+(/[A-Za-z0-9_@+.-]+)*)$'
    AND (service_root = '.' OR service_root !~ '(^|/)\.\.?(/|$)')),
  source_digest text NOT NULL CHECK (source_digest ~ '^sha256:[a-f0-9]{64}$'),
  receipt_digest text NOT NULL CHECK (receipt_digest ~ '^sha256:[a-f0-9]{64}$'),
  signer_spki_digest text NOT NULL CHECK (signer_spki_digest ~ '^sha256:[a-f0-9]{64}$'),
  result_digest text NOT NULL CHECK (result_digest ~ '^sha256:[a-f0-9]{64}$'),
  handler_count integer NOT NULL CHECK (handler_count BETWEEN 1 AND 1024),
  verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, capture_identity_digest, verifier_profile_version),
  FOREIGN KEY (tenant_id, capture_identity_digest)
    REFERENCES orchestration_observed_capture_associations (tenant_id, capture_identity_digest)
    ON DELETE RESTRICT
);

CREATE TRIGGER orchestration_observed_capture_verifications_immutable
BEFORE UPDATE OR DELETE ON orchestration_observed_capture_verifications
FOR EACH ROW EXECUTE FUNCTION orchestration_immutable_row();
