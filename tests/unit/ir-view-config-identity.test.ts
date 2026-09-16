import { describe, expect, test } from "vitest";

import {
  deriveEndpointIdentity,
  parseConfig,
  parseViewSelector,
} from "../../packages/ir/src/index.js";

const expectInvalidAt = (
  result: ReturnType<typeof parseViewSelector> | ReturnType<typeof parseConfig>,
  path: string,
) => {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.kind).toBe("validation_error");
    expect(result.error.issues.some((issue) => issue.path === path)).toBe(true);
  }
};

describe("ViewSelector", () => {
  test("accepts exactly one environment selector with an explicit service scope", () => {
    expect(
      parseViewSelector({
        view_version: "1.0.0",
        service_id: "orders",
        environment: "production",
        publication_id: "pub-42",
      }),
    ).toMatchObject({ ok: true });
  });

  test("rejects multiple mutable/immutable selectors", () => {
    expectInvalidAt(
      parseViewSelector({
        view_version: "1.0.0",
        service_id: "orders",
        environment: "production",
        branch: "main",
      }),
      "/",
    );
  });

  test("rejects a selector without service scope", () => {
    expectInvalidAt(
      parseViewSelector({ view_version: "1.0.0", revision: "abc123" }),
      "/service_id",
    );
  });
});

describe("installation config", () => {
  const validConfig = {
    config_version: "1.0.0",
    access_scopes: [{ access_scope_id: "orders-read", label: "Orders readers" }],
    repositories: [
      {
        repository_id: "commerce",
        provider: "github",
        locator: "example/commerce",
        access_scope_id: "orders-read",
        services: [
          {
            service_id: "orders",
            root: "services/orders",
            analyzer: { adapter_id: "typescript-express", adapter_version: "1.2.0" },
            intended_branches: ["main", "release/uat"],
            environments: [
              {
                name: "production",
                intended_branch: "main",
                deployment_authority: {
                  adapter_id: "enterprise-cd",
                  access_scope_id: "orders-read",
                },
              },
            ],
          },
        ],
      },
    ],
    inference: { enabled: false },
    logs: { enabled: false },
  } as const;

  test("accepts stable repository/service configuration with explicit authorities", () => {
    expect(parseConfig(validConfig)).toMatchObject({ ok: true });
  });

  test("rejects literal credentials instead of secret references", () => {
    expectInvalidAt(
      parseConfig({
        ...validConfig,
        inference: {
          enabled: true,
          provider: "openai",
          model: "semantic-model",
          credential: { api_key: "do-not-echo-this" },
        },
      }),
      "/inference",
    );
  });

  test("accepts an allowlisted structured secret reference", () => {
    expect(parseConfig({
      ...validConfig,
      inference: {
        enabled: true,
        provider: "openai",
        model: "semantic-model",
        credential: { secret_ref: { scheme: "env", locator: "OPENAI_API_KEY" } },
      },
    })).toMatchObject({ ok: true });
  });

  test("rejects a literal disguised as a secret reference without echoing it", () => {
    const literal = "sk-literal-secret";
    const result = parseConfig({
      ...validConfig,
      inference: {
        enabled: true,
        provider: "openai",
        model: "semantic-model",
        credential: { secret_ref: literal },
      },
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(literal);
  });

  test("rejects an environment branch absent from the service intended branch set", () => {
    const candidate = structuredClone(validConfig) as Record<string, any>;
    candidate.repositories[0].services[0].environments[0].intended_branch = "release/unknown";
    const result = parseConfig(candidate);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.issues.some((item) => item.code === "semantic.intended_branch_mismatch")).toBe(true);
  });

  test("does not echo rejected secret values", () => {
    const secret = "secret-value-must-not-appear";
    const result = parseConfig({ ...validConfig, token: secret });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

describe("endpoint identity", () => {
  test("ignores placeholder spelling while preserving it outside identity", () => {
    const first = deriveEndpointIdentity({
      identity_version: "1.0.0",
      service_id: "orders",
      method: "GET",
      application_path: "/orders/{id}",
      selectors: { headers: [{ name: "X-Channel", operator: "equals", value: "partner" }] },
    });
    const second = deriveEndpointIdentity({
      identity_version: "1.0.0",
      service_id: "orders",
      method: "GET",
      application_path: "/orders/{orderId}",
      selectors: { headers: [{ name: "X-Channel", operator: "equals", value: "partner" }] },
    });
    expect(first.route_key).toBe(second.route_key);
    expect(first.normalized_path_shape).toBe("/orders/{}");
  });

  test("changes identity when method, literal path, or routing selectors change", () => {
    const identity = (method: string, path: string, value: string) =>
      deriveEndpointIdentity({
        identity_version: "1.0.0",
        service_id: "orders",
        method,
        application_path: path,
        selectors: { headers: [{ name: "X-Channel", operator: "equals", value }] },
      }).route_key;
    const base = identity("GET", "/orders/{id}", "partner");
    expect(identity("POST", "/orders/{id}", "partner")).not.toBe(base);
    expect(identity("GET", "/invoices/{id}", "partner")).not.toBe(base);
    expect(identity("GET", "/orders/{id}", "internal")).not.toBe(base);
  });

  test("does not include label, host, or branch in route identity", () => {
    const base = {
      identity_version: "1.0.0",
      service_id: "orders",
      method: "GET",
      application_path: "/orders/:orderId",
      selectors: {},
    } as const;
    expect(deriveEndpointIdentity({ ...base, label: "old", host: "a.test", branch: "main" }).route_key)
      .toBe(deriveEndpointIdentity({ ...base, label: "new", host: "b.test", branch: "release" }).route_key);
  });

  test.each([
    { name: "equals without a value", selector: { name: "X-Channel", operator: "equals" } },
    { name: "present with a value", selector: { name: "X-Channel", operator: "present", value: "partner" } },
  ])("rejects malformed selector: $name", ({ selector }) => {
    expect(() => deriveEndpointIdentity({
      identity_version: "1.0.0",
      service_id: "orders",
      method: "GET",
      application_path: "/orders/{id}",
      selectors: { headers: [selector] },
    } as any)).toThrow();
  });

  test("canonicalizes duplicate selectors with set and header-name case semantics", () => {
    const identity = (headers: any[]) => deriveEndpointIdentity({
      identity_version: "1.0.0",
      service_id: "orders",
      method: "GET",
      application_path: "/orders/{id}",
      selectors: { headers },
    }).route_key;
    expect(identity([
      { name: "X-Channel", operator: "equals", value: "partner" },
      { name: "x-channel", operator: "equals", value: "partner" },
    ])).toBe(identity([{ name: "x-channel", operator: "equals", value: "partner" }]));
  });

  test("preserves Spring placeholder constraints while ignoring parameter spelling", () => {
    const key = (path: string) => deriveEndpointIdentity({
      identity_version: "1.0.0", service_id: "orders", method: "GET", application_path: path, selectors: {},
    }).route_key;
    expect(key("/orders/{id:[0-9]+}")).toBe(key("/orders/{orderId:[0-9]+}"));
    expect(key("/orders/{id:[0-9]+}")).not.toBe(key("/orders/{id:[A-Z]+}"));
  });
});
