-- D08 completion writes its checkpoint, job, association, result, and outbox
-- before the trusted D06 catalog mutation. Defer only D08 references to the
-- catalog snapshot until the shared transaction commits.
DO $$
DECLARE foreign_key record;
BEGIN
  FOR foreign_key IN
    SELECT constraint_row.conrelid::regclass AS table_name, constraint_row.conname
    FROM pg_catalog.pg_constraint constraint_row
    WHERE constraint_row.contype = 'f'
      AND constraint_row.confrelid = 'catalog_snapshots'::regclass
      AND constraint_row.conrelid IN (
        'orchestration_jobs'::regclass,
        'orchestration_branch_checkpoints'::regclass,
        'orchestration_revision_snapshots'::regclass,
        'orchestration_job_results'::regclass
      )
      AND NOT constraint_row.condeferrable
  LOOP
    EXECUTE format('ALTER TABLE %s ALTER CONSTRAINT %I DEFERRABLE INITIALLY DEFERRED',
      foreign_key.table_name, foreign_key.conname);
  END LOOP;
END;
$$;

ALTER TABLE orchestration_job_results
  ADD COLUMN base_selected_revision text,
  ADD COLUMN base_snapshot_id text,
  ADD CONSTRAINT orchestration_job_results_base_selection_pair CHECK (
    (base_selected_revision IS NULL) = (base_snapshot_id IS NULL)
    AND (base_selected_revision IS NULL OR base_selected_revision <> '')
  ),
  ADD CONSTRAINT orchestration_job_results_base_snapshot_fk
    FOREIGN KEY (tenant_id, repository_id, service_id, base_snapshot_id)
    REFERENCES catalog_snapshots (tenant_id, repository_id, service_id, snapshot_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
