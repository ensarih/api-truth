-- Immutable admission for a configured signed Swagger load observation.
-- It does not execute verification or write loaded-document summaries/catalog facts.
CREATE TABLE orchestration_loaded_document_verification_jobs (
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[A-Za-z0-9_.-]{1,128}$'),
  job_id text NOT NULL CHECK (job_id ~ '^sha256:[a-f0-9]{64}$'),
  load_identity_digest text NOT NULL CHECK (load_identity_digest ~ '^sha256:[a-f0-9]{64}$'),
  capture_identity_digest text NOT NULL CHECK (capture_identity_digest ~ '^sha256:[a-f0-9]{64}$'),
  parent_verifier_profile_version text NOT NULL CHECK (parent_verifier_profile_version = 'protected-handler-bytes-1'),
  verifier_profile_version text NOT NULL CHECK (verifier_profile_version = 'swagger-loaded-document-1'),
  repository_id text NOT NULL CHECK (repository_id ~ '^[A-Za-z0-9_.-]{1,128}$'),
  service_id text NOT NULL CHECK (service_id ~ '^[A-Za-z0-9_.-]{1,128}$'),
  environment text NOT NULL CHECK (environment ~ '^[A-Za-z0-9_.-]{1,128}$'),
  immutable_revision text NOT NULL CHECK (immutable_revision ~ '^[A-Fa-f0-9]{12,128}$'),
  source_digest text NOT NULL CHECK (source_digest ~ '^sha256:[a-f0-9]{64}$'),
  service_root text NOT NULL CHECK (length(service_root) BETWEEN 1 AND 1024
    AND service_root ~ '^(\.|[A-Za-z0-9_@+.-]+(/[A-Za-z0-9_@+.-]+)*)$'
    AND (service_root = '.' OR service_root !~ '(^|/)\.\.?(/|$)')),
  load_artifact_ref text NOT NULL CHECK (load_artifact_ref ~ '^capture:[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  load_configured_key_ref text NOT NULL CHECK (load_configured_key_ref ~ '^key:[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  load_envelope_digest text NOT NULL CHECK (load_envelope_digest ~ '^sha256:[a-f0-9]{64}$'),
  load_signer_spki_digest text NOT NULL CHECK (load_signer_spki_digest ~ '^sha256:[a-f0-9]{64}$'),
  config_fingerprint text NOT NULL CHECK (length(config_fingerprint) BETWEEN 1 AND 512
    AND config_fingerprint !~ '[[:cntrl:]]'),
  config_document_sha256 text NOT NULL CHECK (config_document_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  config_checkpoint_version bigint NOT NULL CHECK (config_checkpoint_version > 0),
  state text NOT NULL DEFAULT 'queued' CHECK (state = 'queued'),
  admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, job_id),
  UNIQUE (tenant_id, load_identity_digest, config_fingerprint, config_document_sha256, config_checkpoint_version),
  FOREIGN KEY (tenant_id, capture_identity_digest)
    REFERENCES orchestration_observed_capture_associations (tenant_id, capture_identity_digest) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, capture_identity_digest, parent_verifier_profile_version)
    REFERENCES orchestration_observed_capture_verifications
      (tenant_id, capture_identity_digest, verifier_profile_version) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, config_fingerprint, config_document_sha256)
    REFERENCES orchestration_configurations (tenant_id, config_fingerprint, document_sha256) ON DELETE RESTRICT
);

CREATE INDEX orchestration_loaded_document_verification_queued_idx
  ON orchestration_loaded_document_verification_jobs (tenant_id, admitted_at, job_id)
  WHERE state = 'queued';

CREATE TRIGGER orchestration_loaded_document_verification_jobs_immutable
BEFORE UPDATE OR DELETE ON orchestration_loaded_document_verification_jobs
FOR EACH ROW EXECUTE FUNCTION orchestration_immutable_row();
