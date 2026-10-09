export type DependencyDiagnosticSeverity = "informational" | "gap";
export type DependencyInventoryDiagnostic = Readonly<{
  code: string;
  package: string;
  severity: DependencyDiagnosticSeverity;
}>;
export type LockedDependencyInventory = Readonly<{
  schemaVersion: 1;
  scope: Readonly<{
    lockfile: "package-lock.json";
    lockfileVersion: 3;
    dependencyCount: number;
    workspaceCount: number;
    isolatedFixturesIncluded: false;
    javaRuntimeIncluded: false;
    note: string;
  }>;
  rootLockMetadataComplete: boolean;
  unresolvedLicenseCount: number;
  diagnostics: readonly DependencyInventoryDiagnostic[];
  packages: readonly Readonly<{
    name: string;
    version: string;
    dependencyKind: "optional_development" | "optional_production" | "development" | "production";
    optional: boolean;
    resolvedDomain: string | null;
    installed: boolean;
    license: Readonly<{
      value: string | null;
      source: "package_lock" | "installed_package_manifest";
      assessment: "spdx_expression_candidate" | "non_spdx";
    }> | null;
    diagnostics: readonly string[];
  }>[];
  workspaces: readonly Readonly<{name:string;version:string}>[];
}>;
export function buildDependencyInventory(options?:{projectRoot?:string}):Promise<LockedDependencyInventory>;
