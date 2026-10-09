import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {expect, test} from "vitest";

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), "utf8");

test("CI changes only the isolated test image source and retains its exact digest", () => {
  const base = read("deploy/compose.test.yml");
  const override = read("deploy/compose.test.ci.yml");
  const baseImage = base.match(/^    image: (\S+)$/m)?.[1];
  const mirrorImage = override.match(/^    image: (\S+)$/m)?.[1];
  expect(baseImage).toMatch(/^postgres:18\.6-bookworm@sha256:[a-f0-9]{64}$/);
  expect(mirrorImage).toBe(baseImage?.replace("postgres:", "public.ecr.aws/docker/library/postgres:"));
  expect(override.split("\n").map(line => line.trimEnd()).filter(line => line && !line.startsWith("#")))
    .toEqual(["services:", "  postgres:", `    image: ${mirrorImage}`]);

  const workflow = read(".github/workflows/check.yml");
  const starts = [...workflow.matchAll(/- name: Start isolated PostgreSQL\n([\s\S]*?)(?=\n      - name:|\n  [a-z][a-z-]*:|$)/g)];
  expect(starts).toHaveLength(2);
  for (const start of starts) {
    expect(start[1]).toContain("--project-name api-truth-test");
    expect(start[1]).toContain("--file deploy/compose.test.yml --file deploy/compose.test.ci.yml");
    expect(start[1]).toContain("up --detach --wait --wait-timeout 60");
  }
  expect(workflow.match(/run: npm run test:env:down/g)).toHaveLength(2);
});
