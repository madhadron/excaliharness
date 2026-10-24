// Bundles the extension and the orchestrator worker (D-021, D-025), plus the
// VS Code integration tests. Type checking is separate (`npm run typecheck`).
import { globSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import * as esbuild from "esbuild";

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
  esbuild.build({ ...common, entryPoints: ["src/worker/main.ts"], outfile: "dist/worker.js" }),
  esbuild.build({
    ...common,
    entryPoints: globSync("src/test/**/*.test.ts"),
    outdir: "dist/test",
    outbase: "src/test",
  }),
]);
