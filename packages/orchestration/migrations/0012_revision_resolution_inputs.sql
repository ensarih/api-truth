-- Persist the ordered, validated adapter inputs used to produce each immutable revision association.
LOCK TABLE orchestration_revision_snapshots IN ACCESS EXCLUSIVE MODE;

ALTER TABLE orchestration_revision_snapshots
  ADD COLUMN resolution_inputs_fingerprint text
    CHECK (resolution_inputs_fingerprint IS NULL OR resolution_inputs_fingerprint ~ '^sha256:[a-f0-9]{64}$');
