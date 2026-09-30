import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

const explicitExecutable = process.env.API_TRUTH_BROWSER_EXECUTABLE;
const candidates = explicitExecutable === undefined ? [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  process.env.LOCALAPPDATA
    ? `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe` : undefined,
].filter((candidate): candidate is string => candidate !== undefined && candidate.length > 0)
  : [explicitExecutable];
const executablePath = candidates.find((candidate) => existsSync(candidate));

if (executablePath === undefined) {
  throw new Error(explicitExecutable === undefined
    ? "API Truth browser tests require Chrome or Chromium. Install one, or run "
      + "API_TRUTH_BROWSER_EXECUTABLE=/absolute/path/to/browser npm run test:browser"
    : `API_TRUTH_BROWSER_EXECUTABLE does not exist: ${explicitExecutable}`);
}

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 15_000,
  use: {
    headless: true,
    launchOptions: { executablePath },
  },
});
