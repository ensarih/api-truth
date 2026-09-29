CREATE FUNCTION orchestration_text_array_is_canonical(value text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT array_position(value, NULL) IS NULL
    AND array_position(value, '') IS NULL
    AND value = ARRAY(SELECT item FROM unnest(value) AS values_to_sort(item) ORDER BY item COLLATE "C")
    AND cardinality(value) = (SELECT count(DISTINCT item COLLATE "C") FROM unnest(value) AS distinct_values(item));
$$;

CREATE FUNCTION orchestration_immutable_row()
RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'immutable orchestration row';
END;
$$;

CREATE FUNCTION orchestration_safe_error_code(value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT value IN (
    'INVALID_ORCHESTRATION_INPUT', 'EVENT_UNAUTHORIZED', 'EVENT_ID_CONFLICT', 'EVENT_SUBJECT_MISMATCH',
    'CONFIGURATION_NOT_FOUND', 'CONFIGURATION_CONFLICT', 'CONFIGURATION_UNAUTHORIZED', 'EVENT_ORDER_CONFLICT',
    'REVISION_ASSOCIATION_CONFLICT', 'JOB_NOT_FOUND_OR_DENIED', 'WORKER_UNAUTHORIZED', 'JOB_LEASE_CONFLICT',
    'JOB_CANCELLED', 'JOB_SUPERSEDED', 'JOB_DEPENDENCY_FAILED', 'JOB_EXECUTION_FAILED',
    'RECONCILIATION_FAILED', 'OUTBOX_LEASE_CONFLICT', 'OUTBOX_DELIVERY_FAILED', 'PROMOTION_INELIGIBLE',
    'ORCHESTRATION_STORAGE_ERROR'
  );
$$;

CREATE TRIGGER orchestration_schema_migrations_immutable
BEFORE UPDATE OR DELETE ON orchestration_schema_migrations
FOR EACH ROW EXECUTE FUNCTION orchestration_immutable_row();

CREATE TABLE orchestration_configurations (
  tenant_id text NOT NULL,
  config_fingerprint text NOT NULL,
  config_version text NOT NULL,
  document_sha256 text NOT NULL CHECK (document_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  registrar_principal_id text NOT NULL,
  PRIMARY KEY (tenant_id, config_fingerprint),
  UNIQUE (tenant_id, config_fingerprint, document_sha256),
  UNIQUE (tenant_id, config_fingerprint, config_version),
  CHECK (tenant_id <> '' AND config_fingerprint <> '' AND config_version <> '' AND registrar_principal_id <> '')
);

CREATE TRIGGER orchestration_configurations_immutable
BEFORE UPDATE OR DELETE ON orchestration_configurations
FOR EACH ROW EXECUTE FUNCTION orchestration_immutable_row();

CREATE TABLE orchestration_events (
  tenant_id text NOT NULL,
  producer_id text NOT NULL,
  event_id text NOT NULL,
  event_sha256 text NOT NULL CHECK (event_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  event_type text NOT NULL CHECK (event_type IN (
    'branch.updated', 'configuration.changed', 'deployment.changed', 'pull_request.updated',
    'reconciliation.requested', 'repository.baseline_requested', 'source_document.changed'
  )),
  repository_id text,
  service_ids text[] NOT NULL,
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  adapter_version text NOT NULL,
  provider text NOT NULL,
  provider_reference text NOT NULL,
  order_kind text CHECK (order_kind IN ('sequence', 'cursor', 'effective_version')),
  order_value text,
  first_received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  active_config_fingerprint text,
  PRIMARY KEY (tenant_id, producer_id, event_id),
  FOREIGN KEY (tenant_id, active_config_fingerprint)
    REFERENCES orchestration_configurations (tenant_id, config_fingerprint) ON DELETE RESTRICT,
  CHECK (orchestration_text_array_is_canonical(service_ids)),
  CHECK (cardinality(service_ids) > 0),
  CHECK ((order_kind IS NULL) = (order_value IS NULL)),
  CHECK (tenant_id <> '' AND producer_id <> '' AND event_id <> '' AND adapter_version <> ''
    AND provider <> '' AND provider_reference <> '' AND (repository_id IS NULL OR repository_id <> '')
    AND (order_value IS NULL OR order_value <> ''))
);

CREATE INDEX orchestration_events_received_idx
  ON orchestration_events (tenant_id, first_received_at, producer_id, event_id);

CREATE TRIGGER orchestration_events_immutable
BEFORE UPDATE OR DELETE ON orchestration_events
FOR EACH ROW EXECUTE FUNCTION orchestration_immutable_row();

CREATE TABLE orchestration_active_configurations (
  tenant_id text PRIMARY KEY,
  config_fingerprint text NOT NULL,
  checkpoint_version bigint NOT NULL CHECK (checkpoint_version > 0),
  provider text,
  provider_reference text,
  order_kind text CHECK (order_kind IN ('sequence', 'cursor', 'effective_version')),
  order_value text,
  activation_producer_id text,
  activation_event_id text,
  activated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, config_fingerprint)
    REFERENCES orchestration_configurations (tenant_id, config_fingerprint) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, activation_producer_id, activation_event_id)
    REFERENCES orchestration_events (tenant_id, producer_id, event_id) ON DELETE RESTRICT,
  CHECK ((provider IS NULL) = (provider_reference IS NULL)),
  CHECK ((order_kind IS NULL) = (order_value IS NULL)),
  CHECK (order_kind IS NULL OR provider IS NOT NULL),
  CHECK ((activation_producer_id IS NULL) = (activation_event_id IS NULL)),
  CHECK (tenant_id <> '' AND (provider IS NULL OR provider <> '') AND (provider_reference IS NULL OR provider_reference <> '')
    AND (order_value IS NULL OR order_value <> ''))
);

CREATE TABLE orchestration_event_deliveries (
  tenant_id text NOT NULL,
  producer_id text NOT NULL,
  event_id text NOT NULL,
  delivery_id bigint GENERATED ALWAYS AS IDENTITY,
  declared_received_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, producer_id, event_id, delivery_id),
  FOREIGN KEY (tenant_id, producer_id, event_id)
    REFERENCES orchestration_events (tenant_id, producer_id, event_id) ON DELETE RESTRICT
);

CREATE INDEX orchestration_event_deliveries_received_idx
  ON orchestration_event_deliveries (tenant_id, received_at, producer_id, event_id);

CREATE TRIGGER orchestration_event_deliveries_immutable
BEFORE UPDATE OR DELETE ON orchestration_event_deliveries
FOR EACH ROW EXECUTE FUNCTION orchestration_immutable_row();

CREATE TABLE orchestration_jobs (
  tenant_id text NOT NULL,
  job_id text NOT NULL,
  dedupe_key text NOT NULL CHECK (dedupe_key ~ '^sha256:[0-9a-f]{64}$'),
  kind text NOT NULL CHECK (kind IN ('baseline_analysis', 'branch_analysis', 'pr_preview_analysis', 'branch_reconciliation', 'pr_reconciliation')),
  event_producer_id text,
  event_id text,
  repository_id text NOT NULL,
  service_id text NOT NULL,
  branch text,
  pull_request_id text,
  base_revision text,
  target_revision text,
  config_fingerprint text NOT NULL,
  config_document_sha256 text NOT NULL CHECK (config_document_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  provider text,
  provider_reference text,
  order_kind text CHECK (order_kind IN ('sequence', 'cursor', 'effective_version')),
  order_value text,
  subject_generation bigint NOT NULL CHECK (subject_generation > 0),
  state text NOT NULL CHECK (state IN ('queued', 'leased', 'retry_wait', 'succeeded', 'failed', 'cancelled', 'superseded')),
  attempt_count bigint NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts bigint NOT NULL CHECK (max_attempts > 0),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_worker_id text,
  lease_instance_id text,
  lease_token text,
  lease_expires_at timestamptz,
  cancellation_requested boolean NOT NULL DEFAULT false,
  superseding_job_id text,
  safe_last_error_code text CHECK (orchestration_safe_error_code(safe_last_error_code)),
  result_snapshot_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  completed_at timestamptz,
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  PRIMARY KEY (tenant_id, job_id),
  UNIQUE (tenant_id, dedupe_key),
  FOREIGN KEY (tenant_id, event_producer_id, event_id)
    REFERENCES orchestration_events (tenant_id, producer_id, event_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, config_fingerprint, config_document_sha256)
    REFERENCES orchestration_configurations (tenant_id, config_fingerprint, document_sha256) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, superseding_job_id)
    REFERENCES orchestration_jobs (tenant_id, job_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, repository_id, service_id, result_snapshot_id)
    REFERENCES catalog_snapshots (tenant_id, repository_id, service_id, snapshot_id) ON DELETE RESTRICT,
  CHECK ((event_producer_id IS NULL) = (event_id IS NULL)),
  CHECK ((provider IS NULL) = (provider_reference IS NULL)),
  CHECK ((order_kind IS NULL) = (order_value IS NULL)),
  CHECK (order_kind IS NULL OR provider IS NOT NULL),
  CHECK ((lease_worker_id IS NULL) = (lease_instance_id IS NULL)
    AND (lease_worker_id IS NULL) = (lease_token IS NULL)
    AND (lease_worker_id IS NULL) = (lease_expires_at IS NULL)),
  CHECK ((state = 'leased') = (lease_worker_id IS NOT NULL)),
  CHECK ((state IN ('succeeded', 'failed', 'cancelled', 'superseded')) = (completed_at IS NOT NULL)),
  CHECK (attempt_count <= max_attempts),
  CHECK (result_snapshot_id IS NULL OR state = 'succeeded'),
  CHECK (superseding_job_id IS NULL OR state = 'superseded'),
  CHECK (safe_last_error_code IS NULL OR state IN ('retry_wait', 'failed')),
  CHECK (
    (kind = 'baseline_analysis' AND branch IS NULL AND pull_request_id IS NULL)
    OR (kind IN ('branch_analysis', 'branch_reconciliation') AND branch IS NOT NULL AND pull_request_id IS NULL)
    OR (kind IN ('pr_preview_analysis', 'pr_reconciliation') AND pull_request_id IS NOT NULL)
  ),
  CHECK (tenant_id <> '' AND job_id <> '' AND repository_id <> '' AND service_id <> '' AND config_fingerprint <> ''
    AND (branch IS NULL OR branch <> '') AND (pull_request_id IS NULL OR pull_request_id <> '')
    AND (base_revision IS NULL OR base_revision <> '') AND (target_revision IS NULL OR target_revision <> '')
    AND (provider IS NULL OR provider <> '') AND (provider_reference IS NULL OR provider_reference <> '')
    AND (order_value IS NULL OR order_value <> ''))
);

CREATE INDEX orchestration_jobs_claim_idx
  ON orchestration_jobs (tenant_id, state, available_at, created_at, job_id)
  WHERE state IN ('queued', 'retry_wait', 'leased');
CREATE INDEX orchestration_jobs_scope_idx
  ON orchestration_jobs (tenant_id, repository_id, service_id, state);

CREATE TABLE orchestration_event_targets (
  tenant_id text NOT NULL,
  producer_id text NOT NULL,
  event_id text NOT NULL,
  repository_id text NOT NULL,
  service_id text NOT NULL,
  scope_key text NOT NULL,
  disposition text NOT NULL CHECK (disposition IN (
    'scheduled', 'ignored_unconfigured_branch', 'ignored_stale',
    'reconciliation_required', 'deferred_handler', 'no_work'
  )),
  job_id text,
  reconciliation_id text,
  safe_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, producer_id, event_id, repository_id, service_id, scope_key),
  FOREIGN KEY (tenant_id, producer_id, event_id)
    REFERENCES orchestration_events (tenant_id, producer_id, event_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, job_id) REFERENCES orchestration_jobs (tenant_id, job_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, reconciliation_id) REFERENCES orchestration_jobs (tenant_id, job_id) ON DELETE RESTRICT,
  CHECK (tenant_id <> '' AND producer_id <> '' AND event_id <> '' AND repository_id <> '' AND service_id <> '' AND scope_key <> '')
  ,CHECK (reconciliation_id IS NULL OR reconciliation_id <> '')
  ,CHECK (safe_reason IS NULL OR safe_reason IN (
    'unconfigured_branch', 'stale', 'reconciliation_required', 'deferred_handler', 'no_work'
  ))
  ,CHECK (disposition = 'scheduled' OR (job_id IS NULL AND reconciliation_id IS NULL))
);

CREATE INDEX orchestration_event_targets_event_idx
  ON orchestration_event_targets (tenant_id, producer_id, event_id, disposition);

CREATE TRIGGER orchestration_event_targets_immutable
BEFORE UPDATE OR DELETE ON orchestration_event_targets
FOR EACH ROW EXECUTE FUNCTION orchestration_immutable_row();

CREATE TABLE orchestration_job_dependencies (
  tenant_id text NOT NULL,
  job_id text NOT NULL,
  prerequisite_job_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, job_id, prerequisite_job_id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES orchestration_jobs (tenant_id, job_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, prerequisite_job_id) REFERENCES orchestration_jobs (tenant_id, job_id) ON DELETE RESTRICT,
  CHECK (job_id <> prerequisite_job_id)
);

CREATE TRIGGER orchestration_job_dependencies_immutable
BEFORE UPDATE OR DELETE ON orchestration_job_dependencies
FOR EACH ROW EXECUTE FUNCTION orchestration_immutable_row();

CREATE TABLE orchestration_analysis_checkpoints (
  tenant_id text NOT NULL, repository_id text NOT NULL, service_id text NOT NULL, service_root text NOT NULL,
  immutable_revision text NOT NULL, analyzer_adapter_id text NOT NULL, analyzer_adapter_version text NOT NULL,
  exchange_version text NOT NULL, ir_version text NOT NULL, identity_version text NOT NULL,
  config_version text NOT NULL, config_fingerprint text NOT NULL,
  attempt_generation bigint NOT NULL CHECK (attempt_generation > 0),
  current_job_id text,
  last_terminal_outcome text CHECK (last_terminal_outcome IN ('succeeded', 'failed', 'cancelled', 'superseded')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, repository_id, service_id, service_root, immutable_revision, analyzer_adapter_id,
    analyzer_adapter_version, exchange_version, ir_version, identity_version, config_version, config_fingerprint),
  FOREIGN KEY (tenant_id, current_job_id) REFERENCES orchestration_jobs (tenant_id, job_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, config_fingerprint, config_version)
    REFERENCES orchestration_configurations (tenant_id, config_fingerprint, config_version) ON DELETE RESTRICT
  ,CHECK (tenant_id <> '' AND repository_id <> '' AND service_id <> '' AND service_root <> ''
    AND immutable_revision <> '' AND analyzer_adapter_id <> '' AND analyzer_adapter_version <> ''
    AND exchange_version <> '' AND ir_version <> '' AND identity_version <> '' AND config_version <> '' AND config_fingerprint <> '')
  ,CHECK (current_job_id IS NULL OR attempt_generation > 0)
);

CREATE TABLE orchestration_branch_checkpoints (
  tenant_id text NOT NULL, repository_id text NOT NULL, service_id text NOT NULL, branch text NOT NULL,
  desired_state text NOT NULL CHECK (desired_state IN ('present', 'absent')), desired_revision text,
  provider text NOT NULL, provider_reference text NOT NULL,
  order_kind text CHECK (order_kind IN ('sequence', 'cursor', 'effective_version')), order_value text,
  checkpoint_version bigint NOT NULL CHECK (checkpoint_version > 0), analysis_generation bigint NOT NULL CHECK (analysis_generation >= 0),
  current_job_id text, last_successful_job_id text, last_successful_snapshot_id text,
  last_successful_selected_revision text, last_successful_association_key text,
  latest_outcome text CHECK (latest_outcome IN (
    'queued', 'leased', 'retry_wait', 'succeeded', 'failed', 'cancelled', 'superseded',
    'no_work', 'reconciliation_required', 'absent'
  )),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, repository_id, service_id, branch),
  FOREIGN KEY (tenant_id, current_job_id) REFERENCES orchestration_jobs (tenant_id, job_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, last_successful_job_id) REFERENCES orchestration_jobs (tenant_id, job_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, repository_id, service_id, last_successful_snapshot_id)
    REFERENCES catalog_snapshots (tenant_id, repository_id, service_id, snapshot_id) ON DELETE RESTRICT,
  CHECK ((order_kind IS NULL) = (order_value IS NULL)),
  CHECK (current_job_id IS NULL OR analysis_generation > 0),
  CHECK ((desired_state = 'present' AND desired_revision IS NOT NULL) OR (desired_state = 'absent' AND desired_revision IS NULL AND current_job_id IS NULL)),
  CHECK ((last_successful_job_id IS NULL) = (last_successful_snapshot_id IS NULL)
    AND (last_successful_job_id IS NULL) = (last_successful_selected_revision IS NULL)
    AND (last_successful_job_id IS NULL) = (last_successful_association_key IS NULL)),
  CHECK (tenant_id <> '' AND repository_id <> '' AND service_id <> '' AND branch <> ''
    AND provider <> '' AND provider_reference <> '' AND (desired_revision IS NULL OR desired_revision <> '')
    AND (order_value IS NULL OR order_value <> ''))
);

CREATE TABLE orchestration_pr_checkpoints (
  tenant_id text NOT NULL, repository_id text NOT NULL, service_id text NOT NULL, pull_request_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('open', 'updated', 'closed', 'merged')),
  base_branch text NOT NULL, base_revision text NOT NULL, head_branch text NOT NULL, head_revision text NOT NULL,
  provider text NOT NULL, provider_reference text NOT NULL,
  order_kind text CHECK (order_kind IN ('sequence', 'cursor', 'effective_version')), order_value text,
  checkpoint_version bigint NOT NULL CHECK (checkpoint_version > 0), analysis_generation bigint NOT NULL CHECK (analysis_generation >= 0),
  reconciliation_generation bigint NOT NULL CHECK (reconciliation_generation >= 0), current_job_id text, last_preview_result_job_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, repository_id, service_id, pull_request_id),
  FOREIGN KEY (tenant_id, current_job_id) REFERENCES orchestration_jobs (tenant_id, job_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, last_preview_result_job_id) REFERENCES orchestration_jobs (tenant_id, job_id) ON DELETE RESTRICT,
  CHECK ((order_kind IS NULL) = (order_value IS NULL)),
  CHECK (current_job_id IS NULL OR analysis_generation > 0),
  CHECK (tenant_id <> '' AND repository_id <> '' AND service_id <> '' AND pull_request_id <> ''
    AND base_branch <> '' AND base_revision <> '' AND head_branch <> '' AND head_revision <> ''
    AND provider <> '' AND provider_reference <> '' AND (order_value IS NULL OR order_value <> ''))
);

CREATE TABLE orchestration_reconciliation_checkpoints (
  tenant_id text NOT NULL, repository_id text NOT NULL, service_id text NOT NULL, branch text NOT NULL,
  requested_provider_snapshot_reference text NOT NULL, generation bigint NOT NULL CHECK (generation > 0),
  current_job_id text, last_completed_reference text,
  last_outcome text CHECK (last_outcome IN ('no_work', 'repaired', 'absent', 'obsolete', 'failed')),
  safe_last_error_code text CHECK (orchestration_safe_error_code(safe_last_error_code)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, repository_id, service_id, branch),
  FOREIGN KEY (tenant_id, current_job_id) REFERENCES orchestration_jobs (tenant_id, job_id) ON DELETE RESTRICT,
  CHECK ((last_outcome = 'failed' AND safe_last_error_code IS NOT NULL)
    OR (last_outcome IS DISTINCT FROM 'failed' AND safe_last_error_code IS NULL)),
  CHECK (tenant_id <> '' AND repository_id <> '' AND service_id <> '' AND branch <> ''
    AND requested_provider_snapshot_reference <> '')
);

CREATE TABLE orchestration_revision_snapshots (
  tenant_id text NOT NULL, repository_id text NOT NULL, service_id text NOT NULL, service_root text NOT NULL,
  immutable_revision text NOT NULL, source_digest text NOT NULL CHECK (source_digest ~ '^sha256:[0-9a-f]{64}$'),
  analyzer_adapter_id text NOT NULL, analyzer_adapter_version text NOT NULL, exchange_version text NOT NULL,
  ir_version text NOT NULL, identity_version text NOT NULL, config_version text NOT NULL, config_fingerprint text NOT NULL,
  snapshot_id text NOT NULL, analyzer_status text NOT NULL CHECK (analyzer_status IN ('success', 'partial')),
  association_kind text NOT NULL CHECK (association_kind IN ('analyzed', 'reused')), producing_job_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, repository_id, service_id, service_root, immutable_revision, source_digest,
    analyzer_adapter_id, analyzer_adapter_version, exchange_version, ir_version, identity_version, config_version, config_fingerprint),
  FOREIGN KEY (tenant_id, repository_id, service_id, snapshot_id)
    REFERENCES catalog_snapshots (tenant_id, repository_id, service_id, snapshot_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, producing_job_id) REFERENCES orchestration_jobs (tenant_id, job_id) ON DELETE RESTRICT
  ,FOREIGN KEY (tenant_id, config_fingerprint, config_version)
    REFERENCES orchestration_configurations (tenant_id, config_fingerprint, config_version) ON DELETE RESTRICT
  ,CHECK (tenant_id <> '' AND repository_id <> '' AND service_id <> '' AND service_root <> ''
    AND immutable_revision <> '' AND analyzer_adapter_id <> '' AND analyzer_adapter_version <> ''
    AND exchange_version <> '' AND ir_version <> '' AND identity_version <> '' AND config_version <> ''
    AND config_fingerprint <> '' AND snapshot_id <> '' AND producing_job_id <> '')
);

CREATE TRIGGER orchestration_revision_snapshots_immutable
BEFORE UPDATE OR DELETE ON orchestration_revision_snapshots
FOR EACH ROW EXECUTE FUNCTION orchestration_immutable_row();

CREATE TABLE orchestration_job_results (
  tenant_id text NOT NULL, job_id text NOT NULL,
  repository_id text NOT NULL, service_id text NOT NULL,
  scope_kind text NOT NULL CHECK (scope_kind IN ('baseline', 'branch', 'pr_preview')),
  plan_version text, difference_version text, plan_document jsonb, difference_document jsonb,
  target_snapshot_id text NOT NULL, coverage_status text NOT NULL CHECK (coverage_status IN ('complete', 'incomplete', 'unknown')),
  completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, job_id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES orchestration_jobs (tenant_id, job_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, repository_id, service_id, target_snapshot_id)
    REFERENCES catalog_snapshots (tenant_id, repository_id, service_id, snapshot_id) ON DELETE RESTRICT,
  CHECK ((plan_version IS NULL) = (plan_document IS NULL)),
  CHECK ((difference_version IS NULL) = (difference_document IS NULL)),
  CHECK (tenant_id <> '' AND job_id <> '' AND repository_id <> '' AND service_id <> '' AND target_snapshot_id <> '')
);

CREATE TRIGGER orchestration_job_results_immutable
BEFORE UPDATE OR DELETE ON orchestration_job_results
FOR EACH ROW EXECUTE FUNCTION orchestration_immutable_row();

CREATE TABLE orchestration_outbox (
  tenant_id text NOT NULL, outbox_id text NOT NULL,
  dedupe_key text NOT NULL CHECK (dedupe_key ~ '^sha256:[0-9a-f]{64}$'),
  message_kind text NOT NULL CHECK (message_kind IN (
    'event.disposition', 'configuration.activated', 'job.state_changed', 'reconciliation.state_changed'
  )),
  event_producer_id text, event_id text, job_id text,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  state text NOT NULL CHECK (state IN ('pending', 'leased', 'retry_wait', 'delivered', 'exhausted')),
  attempt_count bigint NOT NULL DEFAULT 0 CHECK (attempt_count >= 0), max_attempts bigint NOT NULL CHECK (max_attempts > 0),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(), lease_worker_id text, lease_instance_id text,
  lease_token text, lease_expires_at timestamptz,
  safe_last_error_code text CHECK (orchestration_safe_error_code(safe_last_error_code)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), delivered_at timestamptz,
  PRIMARY KEY (tenant_id, outbox_id), UNIQUE (tenant_id, dedupe_key),
  FOREIGN KEY (tenant_id, event_producer_id, event_id)
    REFERENCES orchestration_events (tenant_id, producer_id, event_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, job_id) REFERENCES orchestration_jobs (tenant_id, job_id) ON DELETE RESTRICT,
  CHECK ((event_producer_id IS NULL) = (event_id IS NULL)),
  CHECK (message_kind <> 'event.disposition' OR event_id IS NOT NULL),
  CHECK (message_kind NOT IN ('job.state_changed', 'reconciliation.state_changed') OR job_id IS NOT NULL),
  CHECK ((lease_worker_id IS NULL) = (lease_instance_id IS NULL)
    AND (lease_worker_id IS NULL) = (lease_token IS NULL)
    AND (lease_worker_id IS NULL) = (lease_expires_at IS NULL)),
  CHECK ((state = 'leased') = (lease_worker_id IS NOT NULL)),
  CHECK ((state = 'delivered') = (delivered_at IS NOT NULL)),
  CHECK (attempt_count <= max_attempts),
  CHECK (safe_last_error_code IS NULL OR state IN ('retry_wait', 'exhausted')),
  CHECK (tenant_id <> '' AND outbox_id <> '')
);

CREATE INDEX orchestration_outbox_claim_idx
  ON orchestration_outbox (tenant_id, state, available_at, created_at, outbox_id)
  WHERE state IN ('pending', 'retry_wait', 'leased');

CREATE TABLE orchestration_concurrency_policies (
  tenant_id text PRIMARY KEY, policy_version bigint NOT NULL DEFAULT 1 CHECK (policy_version > 0),
  global_limit integer NOT NULL DEFAULT 16 CHECK (global_limit > 0),
  repository_limit integer NOT NULL DEFAULT 4 CHECK (repository_limit > 0),
  service_limit integer NOT NULL DEFAULT 1 CHECK (service_limit > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (service_limit <= repository_limit AND repository_limit <= global_limit),
  CHECK (tenant_id <> '')
);

CREATE FUNCTION orchestration_job_dependency_is_acyclic()
RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
BEGIN
  IF EXISTS (
    WITH RECURSIVE descendants(job_id) AS (
      SELECT NEW.prerequisite_job_id
      UNION
      SELECT dependency.prerequisite_job_id
      FROM orchestration_job_dependencies dependency
      JOIN descendants prior ON dependency.tenant_id = NEW.tenant_id AND dependency.job_id = prior.job_id
    )
    SELECT 1 FROM descendants WHERE job_id = NEW.job_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'cyclic job dependency';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER orchestration_job_dependency_acyclic
BEFORE INSERT ON orchestration_job_dependencies
FOR EACH ROW EXECUTE FUNCTION orchestration_job_dependency_is_acyclic();
