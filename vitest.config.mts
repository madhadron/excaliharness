import { defineConfig } from "vitest/config";

// Unit tests live next to the code they test. Tests that need a real VS Code
// live in src/test/ and run through @vscode/test-cli instead (D-026).
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["src/test/**", "node_modules/**"],
  },
});
