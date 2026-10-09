import { defineConfig } from "vitest/config";

export default defineConfig({test: {
  name: "java-integration", environment: "node",
  include: ["tests/conformance/java-spring/**/*.integration.test.ts"],
  testTimeout: 120_000, hookTimeout: 90_000, maxWorkers: 1,
}});
