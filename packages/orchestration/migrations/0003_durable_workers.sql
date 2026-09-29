CREATE INDEX orchestration_job_dependencies_prerequisite_idx
  ON orchestration_job_dependencies (tenant_id, prerequisite_job_id, job_id);

ALTER TABLE orchestration_concurrency_policies
  ADD CONSTRAINT orchestration_concurrency_policies_bounded CHECK (
    global_limit <= 1024 AND repository_limit <= 1024 AND service_limit <= 1024
  );

ALTER TABLE orchestration_pr_checkpoints
  ADD COLUMN latest_outcome text CHECK (latest_outcome IN (
    'queued', 'leased', 'retry_wait', 'succeeded', 'failed', 'cancelled', 'superseded'
  ));
