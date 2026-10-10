-- Reviews annotate private inferred history metadata only; they cannot approve API claims or prose.
CREATE UNIQUE INDEX semantic_inference_history_owner_id_idx
  ON semantic_inference_history (tenant_id, principal_id, history_id);

CREATE TABLE semantic_history_reviews (
  tenant_id text NOT NULL,
  principal_id text NOT NULL,
  history_id bigint NOT NULL,
  review_version bigint NOT NULL CHECK (review_version > 0),
  expected_version bigint NOT NULL CHECK (expected_version >= 0 AND expected_version < 9223372036854775807),
  decision text NOT NULL CHECK (decision IN ('acknowledged','follow_up','dismissed')),
  record_sha256 text NOT NULL CHECK (record_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, principal_id, history_id, review_version),
  UNIQUE (tenant_id, principal_id, history_id, expected_version),
  FOREIGN KEY (tenant_id, principal_id, history_id)
    REFERENCES semantic_inference_history (tenant_id, principal_id, history_id) ON DELETE RESTRICT,
  CHECK (tenant_id <> '' AND principal_id <> '' AND history_id > 0),
  CHECK (review_version = expected_version + 1)
);

CREATE TRIGGER semantic_history_reviews_immutable BEFORE UPDATE OR DELETE ON semantic_history_reviews
FOR EACH ROW EXECUTE FUNCTION orchestration_immutable_row();
