import { defineConfig } from "@vscode/test-cli";

export default defineConfig({
  files: "dist/test/**/*.test.js",
  // Oldest version allowed by engines.vscode, so the minimum is what's tested.
  version: "1.137.0",
  // A copy made by `npm run test:vscode`: the tests change files, and the
  // checkout is read-only in the dev container.
  workspaceFolder: ".vscode-test/workspace",
  // Headless Electron in a container: no GPU, no setuid sandbox, small /dev/shm.
  launchArgs: ["--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage", "--disable-extensions"],
  mocha: { timeout: 20_000 },
});
