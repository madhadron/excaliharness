// Bundles the extension, the orchestrator worker (D-021, D-025) and the egress
// proxy (D-066), plus the VS Code integration tests. Type checking is separate
// (`npm run typecheck`). Run directly; importing it only reads its settings.
import { globSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import * as esbuild from "esbuild";

// The Agent SDK is an ES module that uses import.meta.url, which is undefined
// in a CommonJS bundle; give it the bundle's own URL.
export const esmInCjs = {
  banner: { js: 'const __import_meta_url = require("node:url").pathToFileURL(__filename).href;' },
  define: { "import.meta.url": "__import_meta_url" },
};

const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: true,
  external: ["vscode"],
  logLevel: "warning",
};

// Start clean so tests deleted from src/test don't linger in dist/test. Only
// the contents go: in the dev container dist/ itself is a mount point.
mkdirSync("dist", { recursive: true });
for (const entry of readdirSync("dist")) rmSync(`dist/${entry}`, { recursive: true, force: true });

await Promise.all([
  esbuild.build({ ...common, entryPoints: ["src/extension.ts"], outfile: "dist/extension.js" }),
  esbuild.build({
    ...common,
    entryPoints: ["src/worker/main.ts"],
    outfile: "dist/worker.js",
    // The SDK's bundled CLI binaries; the worker always runs the CLI in a
    // container instead (D-067).
    external: [...common.external, "@anthropic-ai/claude-agent-sdk-*"],
    ...esmInCjs,
  }),
  esbuild.build({ ...common, entryPoints: ["src/worker/proxy/main.ts"], outfile: "dist/proxy.js" }),
  esbuild.build({
    ...common,
    entryPoints: globSync("src/test/**/*.test.ts"),
    outdir: "dist/test",
    outbase: "src/test",
  }),
]);
