-- Signed external capture identities are independent of source-analysis snapshots.
-- This table does not participate in branch or environment pointer promotion.
CREATE TABLE orchestration_observed_capture_associations (
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[A-Za-z0-9_.-]{1,128}$'),
  capture_identity_digest text NOT NULL CHECK (capture_identity_digest ~ '^sha256:[a-f0-9]{64}$'),
  repository_id text NOT NULL CHECK (repository_id ~ '^[A-Za-z0-9_.-]{1,128}$'),
  service_id text NOT NULL CHECK (service_id ~ '^[A-Za-z0-9_.-]{1,128}$'),
  immutable_revision text NOT NULL CHECK (immutable_revision ~ '^[a-fA-F0-9]{12,128}$'),
  source_digest text NOT NULL CHECK (source_digest ~ '^sha256:[a-f0-9]{64}$'),
  environment text NOT NULL CHECK (environment ~ '^[A-Za-z0-9_.-]{1,128}$'),
  policy_version text NOT NULL CHECK (policy_version = 'runtime-capture-pin-1'),
  artifact_ref text NOT NULL CHECK (artifact_ref ~ '^capture:[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  configured_key_ref text NOT NULL CHECK (configured_key_ref ~ '^key:[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  receipt_digest text NOT NULL CHECK (receipt_digest ~ '^sha256:[a-f0-9]{64}$'),
  signer_spki_digest text NOT NULL CHECK (signer_spki_digest ~ '^sha256:[a-f0-9]{64}$'),
  associated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, capture_identity_digest)
);

CREATE INDEX orchestration_observed_capture_scope_idx
  ON orchestration_observed_capture_associations
  (tenant_id, repository_id, service_id, immutable_revision, source_digest, environment);

CREATE TRIGGER orchestration_observed_capture_associations_immutable
BEFORE UPDATE OR DELETE ON orchestration_observed_capture_associations
FOR EACH ROW EXECUTE FUNCTION orchestration_immutable_row();
