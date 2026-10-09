import {OPENAPI31_ANALYZER, createAnalyzerForDocumentProfile, extractOpenApi31Document} from "../../openapi3/src/index.js";

export const ANALYZER = OPENAPI31_ANALYZER;
export {extractOpenApi31Document};
export function createAnalyzer(options: {projectRoot: string}) {
  return createAnalyzerForDocumentProfile(options, ANALYZER, "3.1");
}
