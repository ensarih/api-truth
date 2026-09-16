import { type Static, Type } from "@sinclair/typebox";
import { issue, parserFor, type ValidationIssue } from "./validation.js";
import { ConfigVersionSchema } from "./versions.js";

const SecretReferenceSchema = Type.Object({ secret_ref: Type.String({ minLength: 1 }) }, { additionalProperties: false });

const InferenceConfigSchema = Type.Union([
  Type.Object({ enabled: Type.Literal(false) }, { additionalProperties: false }),
  Type.Object({
    enabled: Type.Literal(true),
    provider: Type.Union([Type.Literal("openai"), Type.Literal("gemini"), Type.Literal("claude")]),
    model: Type.String({ minLength: 1 }),
    credential: SecretReferenceSchema,
  }, { additionalProperties: false }),
]);

const LogsConfigSchema = Type.Union([
  Type.Object({ enabled: Type.Literal(false) }, { additionalProperties: false }),
  Type.Object({
    enabled: Type.Literal(true),
    adapter_id: Type.String({ minLength: 1 }),
    credential: SecretReferenceSchema,
  }, { additionalProperties: false }),
]);

const DeploymentAuthoritySchema = Type.Object({
  adapter_id: Type.String({ minLength: 1 }),
  access_scope_id: Type.String({ minLength: 1 }),
  credential: Type.Optional(SecretReferenceSchema),
}, { additionalProperties: false });

const EnvironmentConfigSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  intended_branch: Type.Optional(Type.String({ minLength: 1 })),
  deployment_authority: DeploymentAuthoritySchema,
}, { additionalProperties: false });

const ServiceConfigSchema = Type.Object({
  service_id: Type.String({ minLength: 1 }),
  root: Type.String({ minLength: 1 }),
  analyzer: Type.Object({
    adapter_id: Type.String({ minLength: 1 }),
    adapter_version: Type.String({ minLength: 1 }),
  }, { additionalProperties: false }),
  intended_branches: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
  environments: Type.Array(EnvironmentConfigSchema),
}, { additionalProperties: false });

const RepositoryConfigSchema = Type.Object({
  repository_id: Type.String({ minLength: 1 }),
  provider: Type.String({ minLength: 1 }),
  locator: Type.String({ minLength: 1 }),
  access_scope_id: Type.String({ minLength: 1 }),
  services: Type.Array(ServiceConfigSchema, { minItems: 1 }),
}, { additionalProperties: false });

export const InstallationConfigSchema = Type.Object({
  config_version: ConfigVersionSchema,
  access_scopes: Type.Array(Type.Object({
    access_scope_id: Type.String({ minLength: 1 }),
    label: Type.String({ minLength: 1 }),
  }, { additionalProperties: false }), { minItems: 1 }),
  repositories: Type.Array(RepositoryConfigSchema, { minItems: 1 }),
  inference: Type.Optional(InferenceConfigSchema),
  logs: Type.Optional(LogsConfigSchema),
}, { $id: "https://api-truth.dev/schemas/installation-config-1.0.0.json", additionalProperties: false });

export type InstallationConfig = Static<typeof InstallationConfigSchema>;
const duplicates = (values: string[]) => values.filter((value, index) => values.indexOf(value) !== index);

const validateConfigReferences = (config: InstallationConfig): ValidationIssue[] => {
  const issues: ValidationIssue[] = [];
  const scopeIds = config.access_scopes.map((scope) => scope.access_scope_id);
  for (const _id of duplicates(scopeIds)) issues.push(issue("/access_scopes", "semantic.duplicate_id", "duplicate access scope ID"));
  for (const _id of duplicates(config.repositories.map((repository) => repository.repository_id))) {
    issues.push(issue("/repositories", "semantic.duplicate_id", "duplicate repository ID"));
  }
  for (const _id of duplicates(config.repositories.flatMap((repository) => repository.services.map((service) => service.service_id)))) {
    issues.push(issue("/repositories", "semantic.duplicate_id", "duplicate service ID"));
  }
  config.repositories.forEach((repository, repositoryIndex) => {
    if (!scopeIds.includes(repository.access_scope_id)) {
      issues.push(issue(`/repositories/${repositoryIndex}/access_scope_id`, "semantic.dangling_reference", "unknown access scope"));
    }
    repository.services.forEach((service, serviceIndex) => {
      for (const _id of duplicates(service.environments.map((environment) => environment.name))) {
        issues.push(issue(`/repositories/${repositoryIndex}/services/${serviceIndex}/environments`, "semantic.duplicate_id", "duplicate environment name"));
      }
      service.environments.forEach((environment, environmentIndex) => {
        if (!scopeIds.includes(environment.deployment_authority.access_scope_id)) {
          issues.push(issue(
            `/repositories/${repositoryIndex}/services/${serviceIndex}/environments/${environmentIndex}/deployment_authority/access_scope_id`,
            "semantic.dangling_reference",
            "unknown access scope",
          ));
        }
      });
    });
  });
  return issues;
};

export const parseConfig = parserFor(InstallationConfigSchema, validateConfigReferences);
export const validateConfig = parseConfig;
