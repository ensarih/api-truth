ALTER TABLE openapi_publications
  ADD COLUMN environment_scope_ids text[];

ALTER TABLE openapi_publications
  ADD CONSTRAINT openapi_environment_scope_ids_valid CHECK (
    (selector_kind = 'environment' AND environment_scope_ids IS NOT NULL
      AND cardinality(environment_scope_ids) > 0)
    OR (selector_kind <> 'environment' AND environment_scope_ids IS NULL)
  ) NOT VALID;
