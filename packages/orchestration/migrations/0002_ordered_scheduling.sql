ALTER TABLE orchestration_jobs
  ADD COLUMN service_root text,
  ADD COLUMN analyzer_adapter_id text,
  ADD COLUMN analyzer_adapter_version text,
  ADD COLUMN exchange_version text,
  ADD COLUMN ir_version text,
  ADD COLUMN identity_version text,
  ADD COLUMN config_version text,
  ADD COLUMN semantic_identity jsonb;

DO $$
DECLARE constraint_to_replace record;
BEGIN
  FOR constraint_to_replace IN
    SELECT constraint_row.conname
    FROM pg_catalog.pg_constraint constraint_row
    WHERE constraint_row.conrelid = 'orchestration_jobs'::regclass
      AND constraint_row.contype = 'c'
      AND pg_catalog.pg_get_constraintdef(constraint_row.oid) LIKE '%superseding_job_id IS NULL%state = ''superseded''%'
  LOOP
    EXECUTE format('ALTER TABLE orchestration_jobs DROP CONSTRAINT %I', constraint_to_replace.conname);
  END LOOP;

  FOR constraint_to_replace IN
    SELECT constraint_row.conname
    FROM pg_catalog.pg_constraint constraint_row
    WHERE constraint_row.conrelid = 'orchestration_jobs'::regclass
      AND constraint_row.contype = 'c'
      AND pg_catalog.pg_get_constraintdef(constraint_row.oid) LIKE '%tenant_id <>%job_id <>%repository_id <>%'
  LOOP
    EXECUTE format('ALTER TABLE orchestration_jobs DROP CONSTRAINT %I', constraint_to_replace.conname);
  END LOOP;

  FOR constraint_to_replace IN
    SELECT constraint_row.conname
    FROM pg_catalog.pg_constraint constraint_row
    WHERE constraint_row.conrelid = 'orchestration_event_targets'::regclass
      AND constraint_row.contype = 'c'
      AND pg_catalog.pg_get_constraintdef(constraint_row.oid) LIKE '%disposition = ''scheduled''%job_id IS NULL%'
  LOOP
    EXECUTE format('ALTER TABLE orchestration_event_targets DROP CONSTRAINT %I', constraint_to_replace.conname);
  END LOOP;

  FOR constraint_to_replace IN
    SELECT constraint_row.conname
    FROM pg_catalog.pg_constraint constraint_row
    WHERE constraint_row.conrelid = 'orchestration_pr_checkpoints'::regclass
      AND constraint_row.contype = 'c'
      AND pg_catalog.pg_get_constraintdef(constraint_row.oid) LIKE '%current_job_id IS NULL%analysis_generation > 0%'
  LOOP
    EXECUTE format('ALTER TABLE orchestration_pr_checkpoints DROP CONSTRAINT %I', constraint_to_replace.conname);
  END LOOP;
END;
$$;

ALTER TABLE orchestration_jobs
  ALTER COLUMN service_root SET NOT NULL,
  ALTER COLUMN analyzer_adapter_id SET NOT NULL,
  ALTER COLUMN analyzer_adapter_version SET NOT NULL,
  ALTER COLUMN exchange_version SET NOT NULL,
  ALTER COLUMN ir_version SET NOT NULL,
  ALTER COLUMN identity_version SET NOT NULL,
  ALTER COLUMN config_version SET NOT NULL,
  ALTER COLUMN semantic_identity SET NOT NULL,
  ADD CONSTRAINT orchestration_jobs_pinned_analysis_key_nonempty CHECK (
    service_root <> '' AND analyzer_adapter_id <> '' AND analyzer_adapter_version <> ''
    AND exchange_version <> '' AND ir_version <> '' AND identity_version <> '' AND config_version <> ''
  ),
  ADD CONSTRAINT orchestration_jobs_supersession_state CHECK (
    superseding_job_id IS NULL
    OR (state = 'superseded' AND cancellation_requested)
    OR (state = 'leased' AND cancellation_requested)
  ),
  ADD CONSTRAINT orchestration_jobs_nonempty_identity CHECK (
    tenant_id <> '' AND job_id <> '' AND repository_id <> '' AND service_id <> '' AND config_fingerprint <> ''
    AND (branch IS NULL OR branch <> '') AND (pull_request_id IS NULL OR pull_request_id <> '')
    AND (base_revision IS NULL OR base_revision <> '') AND (target_revision IS NULL OR target_revision <> '')
    AND (provider IS NULL OR provider <> '') AND (provider_reference IS NULL OR provider_reference <> '')
    AND (order_value IS NULL OR order_value <> '')
  ),
  ADD CONSTRAINT orchestration_jobs_semantic_identity_object CHECK (jsonb_typeof(semantic_identity) = 'object'),
  ADD CONSTRAINT orchestration_jobs_pinned_configuration_fk
    FOREIGN KEY (tenant_id, config_fingerprint, config_version)
    REFERENCES orchestration_configurations (tenant_id, config_fingerprint, config_version) ON DELETE RESTRICT;

ALTER TABLE orchestration_event_targets
  ADD CONSTRAINT orchestration_event_targets_job_reference CHECK (
    (disposition = 'scheduled' AND reconciliation_id IS NULL)
    OR (disposition = 'reconciliation_required' AND job_id IS NULL)
    OR (disposition NOT IN ('scheduled', 'reconciliation_required') AND job_id IS NULL AND reconciliation_id IS NULL)
  );

ALTER TABLE orchestration_pr_checkpoints
  ADD CONSTRAINT orchestration_pr_checkpoints_current_generation CHECK (
    current_job_id IS NULL OR analysis_generation > 0 OR reconciliation_generation > 0
  );

DO $$
DECLARE foreign_key record;
BEGIN
  FOR foreign_key IN
    SELECT constraint_row.conrelid::regclass::text AS table_name,
           constraint_row.conname,
           pg_catalog.pg_get_constraintdef(constraint_row.oid) AS definition
    FROM pg_catalog.pg_constraint constraint_row
    WHERE constraint_row.contype = 'f'
      AND constraint_row.confrelid = 'orchestration_jobs'::regclass
      AND constraint_row.conrelid IN (
        'orchestration_jobs'::regclass,
        'orchestration_event_targets'::regclass,
        'orchestration_job_dependencies'::regclass,
        'orchestration_analysis_checkpoints'::regclass,
        'orchestration_branch_checkpoints'::regclass,
        'orchestration_pr_checkpoints'::regclass,
        'orchestration_reconciliation_checkpoints'::regclass,
        'orchestration_revision_snapshots'::regclass,
        'orchestration_job_results'::regclass,
        'orchestration_outbox'::regclass
      )
      AND NOT constraint_row.condeferrable
  LOOP
    EXECUTE format('ALTER TABLE %s ALTER CONSTRAINT %I DEFERRABLE INITIALLY DEFERRED',
      foreign_key.table_name, foreign_key.conname);
  END LOOP;

  FOR foreign_key IN
    SELECT constraint_row.conname
    FROM pg_catalog.pg_constraint constraint_row
    WHERE constraint_row.contype='f'
      AND constraint_row.conrelid='orchestration_active_configurations'::regclass
      AND constraint_row.confrelid='orchestration_events'::regclass
      AND NOT constraint_row.condeferrable
  LOOP
    EXECUTE format(
      'ALTER TABLE orchestration_active_configurations ALTER CONSTRAINT %I DEFERRABLE INITIALLY DEFERRED',
      foreign_key.conname
    );
  END LOOP;
END;
$$;

CREATE FUNCTION orchestration_job_identity_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
BEGIN
  IF ROW(
    OLD.dedupe_key, OLD.kind, OLD.event_producer_id, OLD.event_id, OLD.repository_id, OLD.service_id,
    OLD.branch, OLD.pull_request_id, OLD.base_revision, OLD.target_revision, OLD.service_root,
    OLD.analyzer_adapter_id, OLD.analyzer_adapter_version, OLD.exchange_version, OLD.ir_version,
    OLD.identity_version, OLD.config_version, OLD.config_fingerprint, OLD.config_document_sha256,
    OLD.provider, OLD.provider_reference, OLD.order_kind, OLD.order_value, OLD.subject_generation,
    OLD.semantic_identity
  ) IS DISTINCT FROM ROW(
    NEW.dedupe_key, NEW.kind, NEW.event_producer_id, NEW.event_id, NEW.repository_id, NEW.service_id,
    NEW.branch, NEW.pull_request_id, NEW.base_revision, NEW.target_revision, NEW.service_root,
    NEW.analyzer_adapter_id, NEW.analyzer_adapter_version, NEW.exchange_version, NEW.ir_version,
    NEW.identity_version, NEW.config_version, NEW.config_fingerprint, NEW.config_document_sha256,
    NEW.provider, NEW.provider_reference, NEW.order_kind, NEW.order_value, NEW.subject_generation,
    NEW.semantic_identity
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'immutable orchestration job identity';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER orchestration_jobs_identity_immutable
BEFORE UPDATE ON orchestration_jobs
FOR EACH ROW EXECUTE FUNCTION orchestration_job_identity_is_immutable();

CREATE FUNCTION orchestration_checkpoint_job_matches()
RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
BEGIN
  IF NEW.current_job_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'orchestration_branch_checkpoints' THEN
    IF NOT EXISTS (
      SELECT 1 FROM orchestration_jobs job
      WHERE job.tenant_id=NEW.tenant_id AND job.job_id=NEW.current_job_id
        AND job.kind='branch_analysis' AND job.repository_id=NEW.repository_id AND job.service_id=NEW.service_id
        AND job.branch=NEW.branch AND job.subject_generation=NEW.analysis_generation
    ) THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='branch checkpoint job mismatch';
    END IF;
  ELSIF TG_TABLE_NAME = 'orchestration_pr_checkpoints' THEN
    IF NOT EXISTS (
      SELECT 1 FROM orchestration_jobs job
      WHERE job.tenant_id=NEW.tenant_id AND job.job_id=NEW.current_job_id
        AND job.repository_id=NEW.repository_id AND job.service_id=NEW.service_id
        AND job.pull_request_id=NEW.pull_request_id
        AND (
          (job.kind='pr_preview_analysis' AND job.subject_generation=NEW.analysis_generation)
          OR (job.kind='pr_reconciliation' AND job.subject_generation=NEW.reconciliation_generation)
        )
    ) THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='pull request checkpoint job mismatch';
    END IF;
  ELSIF TG_TABLE_NAME = 'orchestration_reconciliation_checkpoints' THEN
    IF NOT EXISTS (
      SELECT 1 FROM orchestration_jobs job
      WHERE job.tenant_id=NEW.tenant_id AND job.job_id=NEW.current_job_id
        AND job.kind='branch_reconciliation' AND job.repository_id=NEW.repository_id AND job.service_id=NEW.service_id
        AND job.branch=NEW.branch AND job.subject_generation=NEW.generation
    ) THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='reconciliation checkpoint job mismatch';
    END IF;
  ELSIF TG_TABLE_NAME = 'orchestration_analysis_checkpoints' THEN
    IF NOT EXISTS (
      SELECT 1 FROM orchestration_jobs job
      WHERE job.tenant_id=NEW.tenant_id AND job.job_id=NEW.current_job_id
        AND job.kind='baseline_analysis' AND job.repository_id=NEW.repository_id AND job.service_id=NEW.service_id
        AND job.service_root=NEW.service_root AND job.target_revision=NEW.immutable_revision
        AND job.analyzer_adapter_id=NEW.analyzer_adapter_id AND job.analyzer_adapter_version=NEW.analyzer_adapter_version
        AND job.exchange_version=NEW.exchange_version AND job.ir_version=NEW.ir_version
        AND job.identity_version=NEW.identity_version AND job.config_version=NEW.config_version
        AND job.config_fingerprint=NEW.config_fingerprint AND job.subject_generation=NEW.attempt_generation
    ) THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='analysis checkpoint job mismatch';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER orchestration_branch_checkpoint_job_matches
AFTER INSERT OR UPDATE ON orchestration_branch_checkpoints
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION orchestration_checkpoint_job_matches();

CREATE CONSTRAINT TRIGGER orchestration_pr_checkpoint_job_matches
AFTER INSERT OR UPDATE ON orchestration_pr_checkpoints
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION orchestration_checkpoint_job_matches();

CREATE CONSTRAINT TRIGGER orchestration_reconciliation_checkpoint_job_matches
AFTER INSERT OR UPDATE ON orchestration_reconciliation_checkpoints
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION orchestration_checkpoint_job_matches();

CREATE CONSTRAINT TRIGGER orchestration_analysis_checkpoint_job_matches
AFTER INSERT OR UPDATE ON orchestration_analysis_checkpoints
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION orchestration_checkpoint_job_matches();

CREATE FUNCTION orchestration_event_target_job_matches()
RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
BEGIN
  IF NEW.job_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM orchestration_jobs job
    WHERE job.tenant_id=NEW.tenant_id AND job.job_id=NEW.job_id
      AND job.repository_id=NEW.repository_id AND job.service_id=NEW.service_id
      AND (
        (NEW.scope_key='baseline' AND job.kind='baseline_analysis' AND EXISTS (
          SELECT 1 FROM orchestration_analysis_checkpoints checkpoint
          WHERE checkpoint.tenant_id=job.tenant_id AND checkpoint.repository_id=job.repository_id
            AND checkpoint.service_id=job.service_id AND checkpoint.current_job_id=job.job_id
            AND checkpoint.attempt_generation=job.subject_generation
        ))
        OR (NEW.scope_key LIKE 'branch:%' AND job.kind='branch_analysis'
          AND job.branch=substring(NEW.scope_key FROM 8) AND EXISTS (
            SELECT 1 FROM orchestration_branch_checkpoints checkpoint
            WHERE checkpoint.tenant_id=job.tenant_id AND checkpoint.repository_id=job.repository_id
              AND checkpoint.service_id=job.service_id AND checkpoint.branch=job.branch
              AND checkpoint.current_job_id=job.job_id AND checkpoint.analysis_generation=job.subject_generation
          ))
        OR (NEW.scope_key LIKE 'pr:%' AND job.kind='pr_preview_analysis'
          AND job.pull_request_id=substring(NEW.scope_key FROM 4) AND EXISTS (
            SELECT 1 FROM orchestration_pr_checkpoints checkpoint
            WHERE checkpoint.tenant_id=job.tenant_id AND checkpoint.repository_id=job.repository_id
              AND checkpoint.service_id=job.service_id AND checkpoint.pull_request_id=job.pull_request_id
              AND checkpoint.current_job_id=job.job_id AND checkpoint.analysis_generation=job.subject_generation
          ))
        OR (NEW.scope_key LIKE 'reconciliation:%' AND job.kind='branch_reconciliation'
          AND job.branch=substring(NEW.scope_key FROM 16) AND EXISTS (
            SELECT 1 FROM orchestration_reconciliation_checkpoints checkpoint
            WHERE checkpoint.tenant_id=job.tenant_id AND checkpoint.repository_id=job.repository_id
              AND checkpoint.service_id=job.service_id AND checkpoint.branch=job.branch
              AND checkpoint.current_job_id=job.job_id AND checkpoint.generation=job.subject_generation
          ))
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='event target job mismatch';
  END IF;
  IF NEW.reconciliation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM orchestration_jobs job
    WHERE job.tenant_id=NEW.tenant_id AND job.job_id=NEW.reconciliation_id
      AND job.repository_id=NEW.repository_id AND job.service_id=NEW.service_id
      AND (
        (NEW.scope_key LIKE 'branch:%' AND job.kind='branch_reconciliation'
          AND job.branch=substring(NEW.scope_key FROM 8) AND EXISTS (
            SELECT 1 FROM orchestration_reconciliation_checkpoints checkpoint
            WHERE checkpoint.tenant_id=job.tenant_id AND checkpoint.repository_id=job.repository_id
              AND checkpoint.service_id=job.service_id AND checkpoint.branch=job.branch
              AND checkpoint.current_job_id=job.job_id AND checkpoint.generation=job.subject_generation
          ))
        OR (NEW.scope_key LIKE 'pr:%' AND job.kind='pr_reconciliation'
          AND job.pull_request_id=substring(NEW.scope_key FROM 4) AND EXISTS (
            SELECT 1 FROM orchestration_pr_checkpoints checkpoint
            WHERE checkpoint.tenant_id=job.tenant_id AND checkpoint.repository_id=job.repository_id
              AND checkpoint.service_id=job.service_id AND checkpoint.pull_request_id=job.pull_request_id
              AND checkpoint.current_job_id=job.job_id AND checkpoint.reconciliation_generation=job.subject_generation
          ))
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='event target reconciliation mismatch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER orchestration_event_target_job_matches
AFTER INSERT ON orchestration_event_targets
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION orchestration_event_target_job_matches();
