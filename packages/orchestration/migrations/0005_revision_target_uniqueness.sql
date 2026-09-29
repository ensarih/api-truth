-- The immutable target is known before source resolution. A different source
-- digest for that target is a conflict, not a second revision association.
CREATE UNIQUE INDEX orchestration_revision_snapshots_target_unique
  ON orchestration_revision_snapshots (
    tenant_id, repository_id, service_id, service_root, immutable_revision,
    analyzer_adapter_id, analyzer_adapter_version, exchange_version, ir_version,
    identity_version, config_version, config_fingerprint
  );
