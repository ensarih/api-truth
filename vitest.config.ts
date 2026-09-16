import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/unit/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "contract",
          environment: "node",
          include: ["tests/contract/**/*.test.ts"],
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: [
        "packages/**/*.ts",
        "apps/**/*.ts",
        "analyzers/**/*.ts",
        "connectors/**/*.ts"
      ],
    },
  },
});
