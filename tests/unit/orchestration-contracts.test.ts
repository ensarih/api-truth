import { describe, expect, test, vi } from "vitest";
import * as orchestrationApi from "../../packages/orchestration/src/index.js";
import {
  authorizeNormalizedEvent,
  calculateConfigurationImpact,
  canonicalOrchestrationHash,
  classifyProviderUpdate,
  computeRetryDelayMs,
  createOrchestrationRepository,
  eventSha256,
  isMonotoneProviderConfirmation,
  isConfiguredBranch,
  parseAuthenticatedEventContext,
  parseJobStatus,
  reduceOutboxState,
  requireControlCapability,
  requireWorkerCapability,
  reduceJobState,
  selectBranchlessBaseline,
  selectPullRequestScope,
  selectReconciliationBranches,
} from "../../packages/orchestration/src/index.js";
import { catalogBranchAdvisoryKey } from "../../packages/catalog/src/index.js";
import {
  advisoryLockIdentity,
  canonicalAdvisoryLocks,
  catalogBranchLock,
  requireDiscoveredLocks,
} from "../../packages/orchestration/src/locking.js";
import { OrchestrationError } from "../../packages/orchestration/src/errors.js";

const config = () => ({
  config_version: "1.0.0",
  access_scopes: [{ access_scope_id: "engineering", label: "Engineering" }],
  repositories: [{
    repository_id: "commerce",
    provider: "github",
    locator: "acme/commerce",
    access_scope_id: "engineering",
    services: [{
      service_id: "orders",
      root: "services/orders",
      analyzer: { adapter_id: "typescript", adapter_version: "1" },
      intended_branches: ["main", "release/*"],
      environments: [{
        name: "uat",
        intended_branch: "main",
        deployment_authority: { adapter_id: "deploy", access_scope_id: "engineering" },
      }],
    }],
  }],
  inference: { enabled: false },
  logs: { enabled: false },
});

const context = () => ({
  tenantId: "tenant-1",
  principalId: "principal-1",
  producerId: "connector-1",
  allowedEventTypes: ["branch.updated"],
  allowedRepositories: ["commerce"],
  allowedServices: ["orders"],
  deploymentAuthorityGrants: [],
  capabilities: ["event.ingest"],
});

const branchEvent = () => ({
  event_version: "1.0.0",
  event_id: "event-1",
  event_type: "branch.updated",
  producer: { producer_id: "connector-1", adapter_version: "1" },
  occurred_at: "2026-01-01T00:00:00.000Z",
  received_at: "2026-01-01T00:00:01.000Z",
  subjects: { repository_id: "commerce", service_ids: ["orders"] },
  provider_evidence: {
    provider: "github",
    provider_reference: "delivery-1",
    order: { kind: "sequence", value: "123" },
  },
  payload: {
    branch: "main",
    prior_revision: null,
    new_revision: "a".repeat(40),
    reference_state: "created",
  },
});

describe("D08 orchestration contracts", () => {
  test("exports only the reviewed package-root API", () => {
    expect(Object.keys(orchestrationApi).sort()).toEqual([
      "ActiveConfigurationSummarySchema",
      "AuthenticatedEventContextSchema",
      "CaptureVerificationAdmissionError",
      "CaptureVerificationLeaseError",
      "CaptureVerificationRunnerError",
      "ControlContextSchema",
      "DeploymentAuthorityGrantSchema",
      "EVENT_TYPES",
      "EventReceiptSchema",
      "EventStatusSchema",
      "JobStatusSchema",
      "ObservedCaptureAssociationError",
      "ObservedCaptureVerificationError",
      "OutboxStatusSchema",
      "ProviderEvidenceSchema",
      "WorkerIdentitySchema",
      "applyOrchestrationMigrationManifest",
      "applyOrchestrationMigrations",
      "authorizeNormalizedEvent",
      "calculateConfigurationImpact",
      "canonicalOrchestrationHash",
      "classifyProviderUpdate",
      "computeRetryDelayMs",
      "createCaptureVerificationAdmissionStore",
      "createCaptureVerificationLeaseStore",
      "createCaptureVerificationRunner",
      "createObservedCaptureAssociationStore",
      "createObservedCaptureVerificationStore",
      "createOrchestrationRepository",
      "createOrchestrationWorker",
      "createReconciliationScheduler",
      "eventSha256",
      "isConfiguredBranch",
      "isMonotoneProviderConfirmation",
      "normalizedEventIdentityProjection",
      "parseActiveConfigurationSummary",
      "parseAuthenticatedEventContext",
      "parseControlContext",
      "parseEventReceipt",
      "parseEventStatus",
      "parseJobStatus",
      "parseOutboxStatus",
      "parseProviderEvidence",
      "parseWorkerIdentity",
      "reduceJobState",
      "reduceOutboxState",
      "requireControlCapability",
      "requireWorkerCapability",
      "selectBranchlessBaseline",
      "selectPullRequestScope",
      "selectReconciliationBranches",
      "semanticOrchestrationId",
    ]);
    expect(Object.isFrozen(orchestrationApi.EVENT_TYPES)).toBe(true);
    expect(orchestrationApi).not.toHaveProperty("OrchestrationError");
    expect(orchestrationApi).not.toHaveProperty("compareCanonicalSequence");
    expect(orchestrationApi).not.toHaveProperty("compareUtf8");
    expect(orchestrationApi).not.toHaveProperty("canonicalStringSet");
    expect(orchestrationApi).not.toHaveProperty("isCanonicalStringSet");
    expect(orchestrationApi).not.toHaveProperty("orchestrationValidationError");
    expect(orchestrationApi).not.toHaveProperty("orchestrationStorageError");
    expect(orchestrationApi).not.toHaveProperty("sanitizeOrchestrationIssuePath");
  });

  test("parses and detaches canonical authenticated contexts", () => {
    const input = context();
    const parsed = parseAuthenticatedEventContext(input);
    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) return;
    input.allowedServices[0] = "changed";
    expect(parsed.value.allowedServices).toEqual(["orders"]);
    expect(Object.isFrozen(parsed.value.allowedServices)).toBe(true);
    expect(parseAuthenticatedEventContext({ ...context(), allowedServices: ["orders", "orders"] }).ok).toBe(false);
    expect(parseAuthenticatedEventContext({ ...context(), surprise: true }).ok).toBe(false);
  });

  test("requires event.ingest before reading hostile event input", () => {
    const touched = vi.fn();
    const event = Object.defineProperty({}, "event_type", { enumerable: true, get: () => { touched(); return "branch.updated"; } });
    expect(() => authorizeNormalizedEvent(
      { ...context(), capabilities: [] },
      event,
      config(),
    )).toThrowError(expect.objectContaining({ code: "EVENT_UNAUTHORIZED" }));
    expect(touched).not.toHaveBeenCalled();
  });

  test("denies configuration events without configuration.admin before database access", async () => {
    const connect = vi.fn();
    const repository = createOrchestrationRepository({ connect } as never, { schema: "api_truth_test_unit" });
    const event = {
      ...branchEvent(),
      event_type: "configuration.changed",
      subjects: { service_ids: ["orders"] },
      payload: {
        config_version: "1.0.0", config_fingerprint: "candidate",
        affected_service_ids: ["orders"], affected_scope: "installation",
      },
    };
    await expect(repository.ingestEvent({
      ...context(), allowedEventTypes: ["configuration.changed"], capabilities: ["event.ingest"],
    }, event)).rejects.toMatchObject({ code: "EVENT_UNAUTHORIZED" });
    expect(connect).not.toHaveBeenCalled();
  });

  test("authorizes exact repository/service scope and rejects widening", () => {
    expect(authorizeNormalizedEvent(context(), branchEvent(), config())).toMatchObject({
      event: { event_type: "branch.updated" },
      targets: [{ repositoryId: "commerce", serviceId: "orders" }],
    });
    const widened = branchEvent();
    widened.subjects.service_ids = ["orders", "unknown"];
    expect(() => authorizeNormalizedEvent(context(), widened, config())).toThrowError(
      expect.objectContaining({ code: "EVENT_SUBJECT_MISMATCH" }),
    );
  });

  test("binds configuration events to administrator capability and exact computed impact", () => {
    const event = branchEvent() as Record<string, unknown>;
    event.event_type = "configuration.changed";
    event.payload = {
      config_version: "1.0.0",
      config_fingerprint: "candidate",
      affected_service_ids: ["orders"],
      affected_scope: "installation",
    };
    const admin = {
      ...context(),
      allowedEventTypes: ["configuration.changed"],
      capabilities: ["configuration.admin", "event.ingest"],
    };
    expect(() => authorizeNormalizedEvent(
      { ...admin, capabilities: ["event.ingest"] }, event, config(),
    )).toThrowError(expect.objectContaining({ code: "EVENT_UNAUTHORIZED" }));
    expect(() => authorizeNormalizedEvent(admin, event, config())).toThrowError(
      expect.objectContaining({ code: "EVENT_SUBJECT_MISMATCH" }),
    );
    expect(() => authorizeNormalizedEvent(admin, event, config(), {
      activeConfiguration: { fingerprint: "active", document: config() },
    })).toThrowError(expect.objectContaining({ code: "EVENT_SUBJECT_MISMATCH" }));
    expect(() => authorizeNormalizedEvent(admin, event, config(), {
      candidateConfiguration: { fingerprint: "candidate", document: config() },
    })).toThrowError(expect.objectContaining({ code: "EVENT_SUBJECT_MISMATCH" }));
    expect(authorizeNormalizedEvent(admin, event, config(), {
      activeConfiguration: { fingerprint: "active", document: config() },
      candidateConfiguration: { fingerprint: "candidate", document: config() },
    })).toMatchObject({ targets: [{ serviceId: "orders" }] });
    expect(() => authorizeNormalizedEvent(admin, event, config(), {
      activeConfiguration: { fingerprint: "candidate", document: config() },
      candidateConfiguration: { fingerprint: "candidate", document: config() },
    })).toThrowError(expect.objectContaining({ code: "EVENT_SUBJECT_MISMATCH" }));
    expect(() => authorizeNormalizedEvent(admin, event, config(), {
      activeConfiguration: { fingerprint: "active", document: config() },
      candidateConfiguration: { fingerprint: "different", document: config() },
    })).toThrowError(expect.objectContaining({ code: "EVENT_SUBJECT_MISMATCH" }));
    const wrongRegisteredActive = config();
    wrongRegisteredActive.repositories[0]!.services[0]!.root = "different/orders";
    expect(() => authorizeNormalizedEvent(admin, event, config(), {
      activeConfiguration: { fingerprint: "active", document: wrongRegisteredActive },
      candidateConfiguration: { fingerprint: "candidate", document: config() },
    })).toThrowError(expect.objectContaining({ code: "EVENT_SUBJECT_MISMATCH" }));

    const multiService = config();
    multiService.repositories[0]!.services.push({
      ...structuredClone(multiService.repositories[0]!.services[0]!),
      service_id: "payments",
      root: "services/payments",
    });
    event.subjects = { repository_id: "commerce", service_ids: ["orders", "payments"] };
    event.payload = {
      config_version: "1.0.0",
      config_fingerprint: "candidate",
      affected_service_ids: ["orders", "payments"],
      affected_scope: "installation",
    };
    expect(authorizeNormalizedEvent({
      ...admin,
      allowedServices: ["orders", "payments"],
    }, event, multiService, {
      activeConfiguration: { fingerprint: "active", document: multiService },
      candidateConfiguration: { fingerprint: "candidate", document: multiService },
    })).toMatchObject({
      targets: [{ serviceId: "orders" }, { serviceId: "payments" }],
    });

    event.subjects = { repository_id: "commerce", service_ids: ["orders"] };
    event.payload = {
      config_version: "1.0.0",
      config_fingerprint: "candidate",
      affected_service_ids: ["orders"],
      affected_scope: "installation",
    };
    (event.payload as { affected_service_ids: string[] }).affected_service_ids = ["unrelated"];
    expect(() => authorizeNormalizedEvent(admin, event, config(), {
      activeConfiguration: { fingerprint: "active", document: config() },
      candidateConfiguration: { fingerprint: "candidate", document: config() },
    })).toThrowError(expect.objectContaining({ code: "EVENT_SUBJECT_MISMATCH" }));
  });

  test("binds reconciliation environments without cross-service widening", () => {
    const event = branchEvent() as Record<string, unknown>;
    event.event_type = "reconciliation.requested";
    event.subjects = { service_ids: ["orders"], environment: "uat" };
    event.payload = {
      scope: { service_ids: ["orders"], environments: ["uat"] },
      provider_snapshot_reference: "snapshot-1",
    };
    const reconContext = { ...context(), allowedEventTypes: ["reconciliation.requested"] };
    expect(authorizeNormalizedEvent(reconContext, event, config())).toMatchObject({ targets: [{ serviceId: "orders" }] });
    (event.payload as { scope: { service_ids: string[]; environments: string[] } }).scope.environments = ["production"];
    expect(() => authorizeNormalizedEvent(reconContext, event, config())).toThrowError(
      expect.objectContaining({ code: "EVENT_SUBJECT_MISMATCH" }),
    );
  });

  test("binds deployment adapters and observation authorities before deferral", () => {
    const event = branchEvent() as Record<string, unknown>;
    event.event_type = "deployment.changed";
    event.producer = { producer_id: "deploy", adapter_version: "1" };
    event.subjects = { repository_id: "commerce", service_ids: ["orders"], environment: "uat" };
    event.payload = {
      change_kind: "serving_observation", observation_id: "observation-1", environment: "uat",
      source: { authority_id: "inventory", reference: "ref", access_label: "engineering" },
      completeness: "complete", effective_order: "1",
      serving_state: { status: "known", inventory: [] },
    };
    const deploymentContext = {
      ...context(), producerId: "deploy", allowedEventTypes: ["deployment.changed"],
      deploymentAuthorityGrants: [{
        repositoryId: "commerce", serviceId: "orders", environment: "uat", adapterId: "deploy",
        sourceAuthorityIds: ["inventory"],
      }],
    };
    expect(authorizeNormalizedEvent(deploymentContext, event, config())).toMatchObject({ targets: [{ serviceId: "orders" }] });
    (event.payload as { source: { authority_id: string } }).source.authority_id = "untrusted";
    expect(() => authorizeNormalizedEvent(deploymentContext, event, config())).toThrowError(
      expect.objectContaining({ code: "EVENT_UNAUTHORIZED" }),
    );
  });

  test("uses exact case-sensitive branches, blocks glob expansion, and isolates PR heads", () => {
    const service = config().repositories[0]!.services[0]!;
    expect(selectPullRequestScope(service, "main", "feature/payments")).toEqual({
      configuredBaseBranch: "main", isolatedHeadBranch: "feature/payments",
    });
    expect(selectPullRequestScope(service, "Main", "feature/payments")).toBeUndefined();
    expect(selectPullRequestScope(service, "release/2026", "feature/payments")).toBeUndefined();
    expect(selectReconciliationBranches(service, [])).toEqual(["main", "release/*"]);
    expect(selectReconciliationBranches(service, ["uat"])).toEqual(["main"]);
    expect(selectReconciliationBranches({
      ...service,
      intended_branches: [],
      environments: service.environments.map(({ intended_branch: _branch, ...environment }) => environment),
    }, [])).toEqual([]);
  });

  test("computes complete configuration impact including external identity", () => {
    expect(calculateConfigurationImpact(
      { fingerprint: "one", document: config() },
      { fingerprint: "two", document: config() },
    )).toEqual(["orders"]);
    const next = config();
    next.repositories[0]!.services[0]!.root = "apps/orders";
    expect(calculateConfigurationImpact(
      { fingerprint: "one", document: config() },
      { fingerprint: "one", document: next },
    )).toEqual(["orders"]);
    expect(calculateConfigurationImpact(
      { fingerprint: "one", document: config() },
      { fingerprint: "one", document: config() },
    )).toEqual([]);
  });

  test("wire version changes invalidate the configured service",()=>{
    const next=config();
    Object.assign(next.repositories[0]!.services[0]!.analyzer,{ir_version:"1.1.0"});
    expect(calculateConfigurationImpact({fingerprint:"same",document:config()},{fingerprint:"same",document:next})).toEqual(["orders"]);
  });

  test.each([
    {production_entrypoint:"src/app.ts"},
    {resolution_inputs:[{kind:"type_manifest",path:"api/swagger.yaml"}]},
  ])("analyzer option changes invalidate the configured service",options=>{
    const next=config();
    Object.assign(next.repositories[0]!.services[0]!.analyzer,options);
    expect(calculateConfigurationImpact({fingerprint:"same",document:config()},{fingerprint:"same",document:next})).toEqual(["orders"]);
  });

  test("contains every malformed configuration pair behind a safe error", () => {
    const marker = "secret://configuration-pair";
    const validPair = { fingerprint: "valid", document: config() };
    const hostile = new Proxy({}, { ownKeys: () => { throw new Error(marker); } });
    const accessor = Object.defineProperty({ fingerprint: "value" }, "document", {
      enumerable: true,
      get: () => { throw new Error(marker); },
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const malformed of [null, "value", [], hostile, accessor, cyclic]) {
      for (const operation of [
        () => calculateConfigurationImpact(malformed, validPair),
        () => calculateConfigurationImpact(validPair, malformed),
      ]) {
        let caught: unknown;
        try { operation(); } catch (error) { caught = error; }
        expect(caught).toBeInstanceOf(OrchestrationError);
        expect(caught).toMatchObject({
          code: "INVALID_ORCHESTRATION_INPUT",
          issues: expect.arrayContaining([expect.objectContaining({ path: expect.any(String), code: expect.any(String) })]),
        });
        expect(`${String(caught)} ${JSON.stringify(caught)}`).not.toContain(marker);
      }
    }
  });

  test("contains hostile calls made through the package root", () => {
    const marker = "secret://package-root";
    const hostile = new Proxy({}, { ownKeys: () => { throw new Error(marker); } });
    const parserNames = [
      "parseActiveConfigurationSummary", "parseAuthenticatedEventContext", "parseControlContext",
      "parseEventReceipt", "parseEventStatus", "parseJobStatus", "parseOutboxStatus",
      "parseProviderEvidence", "parseWorkerIdentity",
    ] as const;
    for (const name of parserNames) {
      const result = orchestrationApi[name](hostile);
      expect(result).toMatchObject({ ok: false });
      expect(JSON.stringify(result)).not.toContain(marker);
    }
    for (const operation of [
      () => orchestrationApi.canonicalOrchestrationHash(hostile),
      () => orchestrationApi.semanticOrchestrationId(marker as never, {}),
    ]) {
      let caught: unknown;
      try { operation(); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(OrchestrationError);
      expect(caught).toMatchObject({ code: "INVALID_ORCHESTRATION_INPUT" });
      expect(`${String(caught)} ${JSON.stringify(caught)}`).not.toContain(marker);
    }
  });

  test("classifies every provider ordering outcome without numeric conversion", () => {
    const evidence = (value?: string) => ({
      provider: "github", provider_reference: "ref",
      ...(value === undefined ? {} : { order: { kind: "sequence" as const, value } }),
    });
    expect(classifyProviderUpdate(undefined, { evidence: evidence("1"), relevantPayload: { revision: "a" } })).toBe("first");
    expect(classifyProviderUpdate(undefined, { evidence: evidence(), relevantPayload: { revision: "a" } })).toBe("incomparable");
    expect(classifyProviderUpdate(undefined, {
      evidence: { provider: "github", provider_reference: "ref", order: { kind: "cursor", value: "opaque" } },
      relevantPayload: { revision: "a" },
    })).toBe("incomparable");
    expect(classifyProviderUpdate(undefined, {
      evidence: { provider: "github", provider_reference: "ref", order: { kind: "effective_version", value: "opaque" } },
      relevantPayload: { revision: "a" },
    })).toBe("incomparable");
    const current = { evidence: evidence("9"), relevantPayload: { revision: "a" } };
    expect(classifyProviderUpdate(current, { evidence: evidence("9"), relevantPayload: { revision: "a" } })).toBe("exact_replay");
    expect(classifyProviderUpdate(current, { evidence: evidence("10"), relevantPayload: { revision: "b" } })).toBe("newer");
    expect(classifyProviderUpdate(current, { evidence: evidence("8"), relevantPayload: { revision: "b" } })).toBe("stale");
    expect(classifyProviderUpdate(current, { evidence: evidence("9"), relevantPayload: { revision: "b" } })).toBe("conflict");
    expect(classifyProviderUpdate(current, { evidence: evidence(), relevantPayload: { revision: "b" } })).toBe("incomparable");
    const cursor = { evidence: { provider: "github", provider_reference: "ref", order: { kind: "cursor" as const, value: "opaque" } }, relevantPayload: { revision: "a" } };
    expect(classifyProviderUpdate(cursor, structuredClone(cursor))).toBe("exact_replay");
    expect(classifyProviderUpdate(cursor, { ...structuredClone(cursor), evidence: { ...cursor.evidence, order: { kind: "cursor", value: "changed" } } })).toBe("incomparable");
    const huge = "9".repeat(500);
    expect(classifyProviderUpdate(current, { evidence: evidence(huge), relevantPayload: { revision: "b" } })).toBe("newer");
    expect(classifyProviderUpdate(current, { evidence: evidence("01"), relevantPayload: { revision: "b" } })).toBe("incomparable");
  });

  test("accepts only monotone confirmation of the same semantic observation", () => {
    const evidence = (value: string) => ({
      provider: "github", provider_reference: `ref-${value}`, order: { kind: "sequence" as const, value },
    });
    const payload = { state: "present", revision: "a".repeat(40) };
    const origin = { evidence: evidence("9"), relevantPayload: payload };
    expect(isMonotoneProviderConfirmation(origin, {
      evidence: evidence("10"), relevantPayload: structuredClone(payload),
    })).toBe(true);
    expect(isMonotoneProviderConfirmation(origin, structuredClone(origin))).toBe(true);
    expect(isMonotoneProviderConfirmation(origin, {
      evidence: evidence("8"), relevantPayload: structuredClone(payload),
    })).toBe(false);
    expect(isMonotoneProviderConfirmation(origin, {
      evidence: evidence("10"), relevantPayload: { ...payload, revision: "b".repeat(40) },
    })).toBe(false);
  });

  test("orders global advisory namespaces and preserves the exact D06 branch lock identity", () => {
    const catalog = catalogBranchLock("tenant-1", "commerce", "orders", "main");
    const locks = canonicalAdvisoryLocks([
      catalog,
      { namespace: "subject.branch", parts: ["tenant-1", "commerce", "orders", "main"] },
      { namespace: "configuration.tenant", parts: ["tenant-1"] },
      { namespace: "subject.branch", parts: ["tenant-1", "commerce", "orders", "Main"] },
    ]);
    expect(locks.map((lock) => lock.namespace)).toEqual([
      "configuration.tenant", "subject.branch", "subject.branch", "catalog.branch",
    ]);
    expect(catalog.advisoryIdentity).toBe(catalogBranchAdvisoryKey({
      tenantId: "tenant-1", repositoryId: "commerce", serviceId: "orders", branch: "main",
    }));
    const acquired = new Set([advisoryLockIdentity(locks[0]!)]);
    expect(() => requireDiscoveredLocks(acquired, locks)).toThrowError(
      expect.objectContaining({ name: "OrchestrationLockRestart" }),
    );
    expect(() => requireDiscoveredLocks(new Set(locks.map(advisoryLockIdentity)), locks)).not.toThrow();
  });

  test("applies state precedence, idempotence, and deterministic retry", () => {
    expect(reduceJobState({ state: "queued" }, { kind: "dependency_failed" })).toEqual({ state: "failed", errorCode: "JOB_DEPENDENCY_FAILED" });
    expect(reduceJobState({ state: "retry_wait" }, { kind: "dependency_failed" })).toEqual({ state: "failed", errorCode: "JOB_DEPENDENCY_FAILED" });
    expect(reduceJobState({ state: "queued" }, { kind: "dependency_failed", cancellationRequested: true, supersedingJobId: "j2" })).toEqual({ state: "superseded", supersedingJobId: "j2" });
    expect(reduceJobState({ state: "succeeded" }, { kind: "dependency_failed" })).toEqual({ state: "succeeded" });
    expect(computeRetryDelayMs({ attempt: 1, baseDelayMs: 1000, maxDelayMs: 5000 })).toBe(1000);
    expect(computeRetryDelayMs({ attempt: 1000, baseDelayMs: 1000, maxDelayMs: 5000 })).toBe(5000);
    expect(reduceOutboxState("pending", "lease")).toBe("leased");
    expect(reduceOutboxState("leased", "deliver")).toBe("delivered");
    expect(() => reduceOutboxState("pending", "deliver")).toThrowError(
      expect.objectContaining({ code: "OUTBOX_LEASE_CONFLICT" }),
    );
  });

  test("separates control and worker capabilities", () => {
    expect(requireControlCapability({
      tenantId: "tenant-1", principalId: "admin", capabilities: ["configuration.admin"],
    }, "configuration.admin")).toMatchObject({ tenantId: "tenant-1" });
    expect(() => requireWorkerCapability({
      workerId: "worker-1", instanceId: "instance-1", capabilities: ["outbox.deliver"],
    }, "jobs.execute")).toThrowError(expect.objectContaining({ code: "WORKER_UNAUTHORIZED" }));
  });

  test("normalizes event set order and excludes receiver time from event identity", () => {
    const first = branchEvent();
    const second = branchEvent();
    second.received_at = "2026-01-02T00:00:00.000Z";
    expect(eventSha256(first)).toBe(eventSha256(second));
    second.occurred_at = "2026-01-02T00:00:00.000Z";
    expect(eventSha256(first)).not.toBe(eventSha256(second));
  });

  test("keeps hashes deterministic and public status strict", () => {
    expect(canonicalOrchestrationHash({ b: 2, a: 1 })).toBe(canonicalOrchestrationHash({ a: 1, b: 2 }));
    const status = { jobId: "job-1", kind: "branch_analysis", state: "failed", attemptCount: "2", maxAttempts: "3", safeErrorCode: "JOB_EXECUTION_FAILED" };
    expect(parseJobStatus(status)).toEqual({ ok: true, value: status });
    expect(parseJobStatus({ ...status, branch: "secret" }).ok).toBe(false);
    const marker = "credential=hunter2";
    const error = new OrchestrationError("INVALID_ORCHESTRATION_INPUT", { issues: [{ path: `/${marker}`, code: marker }] });
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(marker);
  });

  test("contains hostile pure-policy inputs behind constant errors", () => {
    const marker = "secret://orchestration-policy";
    const hostile = new Proxy({}, { ownKeys: () => { throw new Error(marker); } });
    const service = config().repositories[0]!.services[0]!;
    for (const operation of [
      () => classifyProviderUpdate(undefined, hostile),
      () => selectPullRequestScope(hostile, "main", "feature"),
      () => isConfiguredBranch(service, hostile),
      () => selectPullRequestScope(service, hostile, "feature"),
      () => selectPullRequestScope(service, "main", hostile),
      () => selectBranchlessBaseline(service, hostile),
      () => reduceJobState(hostile, { kind: "lease" }),
      () => computeRetryDelayMs(hostile),
      () => selectReconciliationBranches(service, new Proxy(["uat"], {
        ownKeys: () => { throw new Error(marker); },
        get: () => { throw new Error(marker); },
      })),
    ]) {
      let caught: unknown;
      try { operation(); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(OrchestrationError);
      expect(caught).toMatchObject({ code: "INVALID_ORCHESTRATION_INPUT" });
      expect(`${String(caught)} ${JSON.stringify(caught)}`).not.toContain(marker);
    }
  });
});
