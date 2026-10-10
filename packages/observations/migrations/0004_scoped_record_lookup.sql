-- Locate an independently attested record across imports without scanning scoped history.
-- The index is non-unique: existing imports remain append-only and ambiguity is rejected by readers.
CREATE INDEX observation_records_scoped_record_idx
  ON observation_records (tenant_id, repository_id, service_id, environment, record_id);
