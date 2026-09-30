-- Hold inserts through trigger installation and the historical catch-up query.
-- Otherwise an event committed between those two snapshots can miss both paths.
LOCK TABLE orchestration_events IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE environment_serving_checkpoints
  ADD COLUMN explicit_reconciliation_requested boolean NOT NULL DEFAULT false,
  ADD COLUMN request_generation bigint NOT NULL DEFAULT 0 CHECK (request_generation >= 0);

CREATE FUNCTION environment_schedule_requested_scope()
RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
BEGIN
  IF NEW.event_type <> 'reconciliation.requested' THEN RETURN NEW; END IF;

  INSERT INTO environment_serving_checkpoints AS checkpoint
    (tenant_id,repository_id,service_id,environment,reconciliation_required,
     explicit_reconciliation_requested,request_generation)
  SELECT DISTINCT NEW.tenant_id,repository.document->>'repository_id',
         service.document->>'service_id',environment.document->>'name',true,true,1
  FROM orchestration_active_configurations active
  JOIN orchestration_configurations configuration ON configuration.tenant_id=active.tenant_id
    AND configuration.config_fingerprint=active.config_fingerprint
  CROSS JOIN LATERAL jsonb_array_elements(configuration.document->'repositories') repository(document)
  CROSS JOIN LATERAL jsonb_array_elements(repository.document->'services') service(document)
  CROSS JOIN LATERAL jsonb_array_elements(service.document->'environments') environment(document)
  JOIN LATERAL jsonb_array_elements_text(NEW.document #> '{payload,scope,service_ids}') requested_service(id)
    ON requested_service.id=service.document->>'service_id'
  JOIN LATERAL jsonb_array_elements_text(NEW.document #> '{payload,scope,environments}') requested_environment(name)
    ON requested_environment.name=environment.document->>'name'
  WHERE active.tenant_id=NEW.tenant_id
    AND (NEW.repository_id IS NULL OR repository.document->>'repository_id'=NEW.repository_id)
  ON CONFLICT (tenant_id,repository_id,service_id,environment) DO UPDATE SET
    reconciliation_required=true,explicit_reconciliation_requested=true,
    request_generation=checkpoint.request_generation+1,
    version=checkpoint.version+1,updated_at=clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER environment_schedule_requested_scope
AFTER INSERT ON orchestration_events
FOR EACH ROW EXECUTE FUNCTION environment_schedule_requested_scope();

WITH requested AS (
  SELECT event.tenant_id,repository.document->>'repository_id' AS repository_id,
         service.document->>'service_id' AS service_id,
         environment.document->>'name' AS environment,
         max(event.first_received_at) AS requested_at
  FROM orchestration_events event
  JOIN orchestration_active_configurations active ON active.tenant_id=event.tenant_id
  JOIN orchestration_configurations configuration ON configuration.tenant_id=active.tenant_id
    AND configuration.config_fingerprint=active.config_fingerprint
  CROSS JOIN LATERAL jsonb_array_elements(configuration.document->'repositories') repository(document)
  CROSS JOIN LATERAL jsonb_array_elements(repository.document->'services') service(document)
  CROSS JOIN LATERAL jsonb_array_elements(service.document->'environments') environment(document)
  JOIN LATERAL jsonb_array_elements_text(event.document #> '{payload,scope,service_ids}') requested_service(id)
    ON requested_service.id=service.document->>'service_id'
  JOIN LATERAL jsonb_array_elements_text(event.document #> '{payload,scope,environments}') requested_environment(name)
    ON requested_environment.name=environment.document->>'name'
  WHERE event.event_type='reconciliation.requested'
    AND (event.repository_id IS NULL OR repository.document->>'repository_id'=event.repository_id)
  GROUP BY event.tenant_id,repository.document->>'repository_id',
           service.document->>'service_id',environment.document->>'name'
)
INSERT INTO environment_serving_checkpoints AS checkpoint
  (tenant_id,repository_id,service_id,environment,reconciliation_required,
   explicit_reconciliation_requested,request_generation,updated_at)
SELECT requested.tenant_id,requested.repository_id,requested.service_id,
       requested.environment,true,true,1,requested.requested_at
FROM requested
ON CONFLICT (tenant_id,repository_id,service_id,environment) DO UPDATE SET
  reconciliation_required=true,explicit_reconciliation_requested=true,
  request_generation=checkpoint.request_generation+1,
  version=checkpoint.version+1,updated_at=clock_timestamp()
WHERE checkpoint.updated_at<EXCLUDED.updated_at;
