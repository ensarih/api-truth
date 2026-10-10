-- Append-only capture-qualified summary of a signed Swagger load observation that
-- corresponds to selected source bytes. This does not publish API contract facts.
CREATE TABLE orchestration_observed_loaded_document_verifications (
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[A-Za-z0-9_.-]{1,128}$'),
  load_identity_digest text NOT NULL CHECK (load_identity_digest ~ '^sha256:[a-f0-9]{64}$'),
  capture_identity_digest text NOT NULL CHECK (capture_identity_digest ~ '^sha256:[a-f0-9]{64}$'),
  parent_verifier_profile_version text NOT NULL CHECK (parent_verifier_profile_version = 'protected-handler-bytes-1'),
  verifier_profile_version text NOT NULL CHECK (verifier_profile_version = 'swagger-loaded-document-1'),
  repository_id text NOT NULL CHECK (repository_id ~ '^[A-Za-z0-9_.-]{1,128}$'),
  service_id text NOT NULL CHECK (service_id ~ '^[A-Za-z0-9_.-]{1,128}$'),
  immutable_revision text NOT NULL CHECK (immutable_revision ~ '^[A-Fa-f0-9]{12,128}$'),
  source_digest text NOT NULL CHECK (source_digest ~ '^sha256:[a-f0-9]{64}$'),
  environment text NOT NULL CHECK (environment ~ '^[A-Za-z0-9_.-]{1,128}$'),
  load_artifact_ref text NOT NULL CHECK (load_artifact_ref ~ '^capture:[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  load_configured_key_ref text NOT NULL CHECK (load_configured_key_ref ~ '^key:[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  load_envelope_digest text NOT NULL CHECK (load_envelope_digest ~ '^sha256:[a-f0-9]{64}$'),
  load_signer_spki_digest text NOT NULL CHECK (load_signer_spki_digest ~ '^sha256:[a-f0-9]{64}$'),
  service_root text NOT NULL CHECK (length(service_root) BETWEEN 1 AND 1024
    AND service_root ~ '^(\.|[A-Za-z0-9_@+.-]+(/[A-Za-z0-9_@+.-]+)*)$'
    AND (service_root = '.' OR service_root !~ '(^|/)\.\.?(/|$)')),
  session_id text NOT NULL CHECK (session_id ~ '^[A-Za-z0-9_.-]{1,128}$'),
  document_raw_sha256 text NOT NULL CHECK (document_raw_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  document_canonical_value_sha256 text NOT NULL CHECK (document_canonical_value_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  document_digest text NOT NULL CHECK (document_digest ~ '^sha256:[a-f0-9]{64}$'),
  result_digest text NOT NULL CHECK (result_digest ~ '^sha256:[a-f0-9]{64}$'),
  handler_count integer NOT NULL CHECK (handler_count BETWEEN 1 AND 1024),
  match_count integer NOT NULL CHECK (match_count BETWEEN 1 AND 1024 AND match_count = handler_count),
  unobserved_diagnostic_count integer NOT NULL CHECK (unobserved_diagnostic_count BETWEEN 0 AND 1024),
  CHECK (match_count + unobserved_diagnostic_count <= 1024),
  verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, load_identity_digest),
  FOREIGN KEY (tenant_id, capture_identity_digest)
    REFERENCES orchestration_observed_capture_associations (tenant_id, capture_identity_digest) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, capture_identity_digest, parent_verifier_profile_version)
    REFERENCES orchestration_observed_capture_verifications
      (tenant_id, capture_identity_digest, verifier_profile_version) ON DELETE RESTRICT
);

CREATE TRIGGER orchestration_observed_loaded_document_verifications_immutable
BEFORE UPDATE OR DELETE ON orchestration_observed_loaded_document_verifications
FOR EACH ROW EXECUTE FUNCTION orchestration_immutable_row();
