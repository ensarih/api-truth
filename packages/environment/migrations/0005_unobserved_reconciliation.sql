DO $$
DECLARE old_constraint text;
BEGIN
  SELECT constraint_row.conname INTO old_constraint
  FROM pg_catalog.pg_constraint constraint_row
  WHERE constraint_row.conrelid = 'environment_serving_checkpoints'::regclass
    AND constraint_row.contype = 'c'
    AND pg_catalog.pg_get_constraintdef(constraint_row.oid)
      LIKE '%reconciliation_required = (pending_event_id IS NOT NULL)%';
  IF old_constraint IS NULL THEN
    RAISE EXCEPTION 'missing serving reconciliation constraint';
  END IF;
  EXECUTE format('ALTER TABLE environment_serving_checkpoints DROP CONSTRAINT %I', old_constraint);
END;
$$;

ALTER TABLE environment_serving_checkpoints
  ADD CONSTRAINT environment_serving_reconciliation_pending
  CHECK (reconciliation_required OR pending_event_id IS NULL);
