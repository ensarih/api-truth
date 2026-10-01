import { expect, test } from "vitest";
import { matchControllerGlob } from "../../analyzers/routing-controllers/src/controller-selection.js";

const root = "/selected/service";
const paths = [
  `${root}/api/controllers/PetController.ts`,
  `${root}/api/controllers/admin/AdminController.ts`,
  `${root}/other/DeadController.ts`,
];

test("bounded controller glob includes direct and nested files but excludes siblings", () => {
  expect(matchControllerGlob(`${root}/api/controllers/**/*Controller{.js,.ts}`, root, paths)).toEqual(paths.slice(0, 2));
});

test.each([
  "../outside/*Controller.ts",
  `${root}/../other/*Controller.ts`,
  `${root}/api/controllers/**/**/PetController.ts`,
  `${root}/api/controllers/[PD]*Controller.ts`,
  `${root}/api/controllers/*Controller{.js,.json}`,
])("rejects unsupported or escaping glob %s", pattern => {
  expect(matchControllerGlob(pattern, root, paths)).toBeUndefined();
});
