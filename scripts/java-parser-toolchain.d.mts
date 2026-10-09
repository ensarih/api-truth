export const JAVAPARSER_VERSION:string;
export const JAVAPARSER_SHA256:string;
export const HELPER_SHA256:string;
export const HELPER_CLASSES:readonly {name:string;sha256:string}[];
export function upJavaParserToolchain(root?:string):Promise<{java:string;jar:string;classes:string;version:string}>;
export function verifyPinnedParserArtifacts(root?:string):Promise<{jar:string;classes:string}>;
export function checkJavaParserToolchain(root?:string,rebuild?:boolean):Promise<{
  java:string;jar:string;classes:string;version:string}>;
