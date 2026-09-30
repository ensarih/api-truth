CREATE TABLE environment_deployment_inbox (
  tenant_id text NOT NULL,
  producer_id text NOT NULL,
  event_id text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'leased', 'retry_wait', 'delivered', 'exhausted')),
  attempt_count bigint NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts bigint NOT NULL DEFAULT 8 CHECK (max_attempts > 0),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_token text,
  lease_expires_at timestamptz,
  safe_last_error_code text CHECK (safe_last_error_code IN
    ('INVALID_ENVIRONMENT_INPUT', 'ENVIRONMENT_NOT_FOUND_OR_DENIED',
     'ENVIRONMENT_STORAGE_ERROR', 'ARTIFACT_BINDING_CONFLICT')),
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, producer_id, event_id),
  FOREIGN KEY (tenant_id, producer_id, event_id)
    REFERENCES orchestration_events (tenant_id, producer_id, event_id) ON DELETE RESTRICT,
  CHECK (tenant_id <> '' AND producer_id <> '' AND event_id <> ''),
  CHECK ((state = 'leased') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((state = 'delivered') = (delivered_at IS NOT NULL))
);

CREATE INDEX environment_deployment_inbox_due_idx ON environment_deployment_inbox
  (available_at, created_at, tenant_id, producer_id, event_id)
  WHERE state IN ('pending', 'retry_wait', 'leased');

CREATE FUNCTION environment_enqueue_deployment_target()
RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
BEGIN
  IF NEW.scope_key = 'deferred' AND NEW.disposition = 'deferred_handler'
    AND EXISTS (
      SELECT 1 FROM orchestration_events event
      WHERE event.tenant_id = NEW.tenant_id AND event.producer_id = NEW.producer_id
        AND event.event_id = NEW.event_id AND event.event_type = 'deployment.changed'
    ) THEN
    INSERT INTO environment_deployment_inbox (tenant_id, producer_id, event_id)
    VALUES (NEW.tenant_id, NEW.producer_id, NEW.event_id)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER environment_enqueue_deployment_target
AFTER INSERT ON orchestration_event_targets
FOR EACH ROW EXECUTE FUNCTION environment_enqueue_deployment_target();

INSERT INTO environment_deployment_inbox (tenant_id, producer_id, event_id)
SELECT event.tenant_id, event.producer_id, event.event_id
FROM orchestration_events event
JOIN orchestration_event_targets target ON target.tenant_id = event.tenant_id
  AND target.producer_id = event.producer_id AND target.event_id = event.event_id
WHERE event.event_type = 'deployment.changed'
  AND target.scope_key = 'deferred' AND target.disposition = 'deferred_handler'
ON CONFLICT DO NOTHING;
