import { defineConfig } from "@vscode/test-cli";

export default defineConfig({
  files: "dist/test/**/*.test.js",
  // Oldest version allowed by engines.vscode, so the minimum is what's tested.
  version: "1.137.0",
  workspaceFolder: "src/test/fixtures/workspace",
  // Headless Electron in a container: no GPU, no setuid sandbox, small /dev/shm.
  launchArgs: ["--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage", "--disable-extensions"],
  mocha: { timeout: 20_000 },
});
