// The capability check (D-065): what an agent needs from its image, checked
// once per image in a throwaway locked-down container, with a specific
// message for each problem. Results are cached by image ID.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { AGENT_HOME, PROXY_SERVICE } from "./compose";
import type { TaskProject } from "./project";

export interface CapabilityResult {
  ok: boolean;
  problems: string[];
}

const PROGRAM = /^[\w./+-]+$/;

// A POSIX shell script printing one `name=ok` or `name=fail:detail` line per
// check. Gate program names are validated before they're put in it.
export function checkScript(gatePrograms: string[]): string {
  const programs = gatePrograms.filter((p) => PROGRAM.test(p));
  const lines = [
    'say() { printf "%s=%s\\n" "$1" "$2"; }',
    'if v=$(claude --version 2>&1); then say claude "ok:$v"; else say claude "fail:$v"; fi',
    // The native binary is a glibc build; musl (Alpine) images aren't supported (D-064).
    'if [ -e /lib/ld-musl-x86_64.so.1 ] || [ -e /lib/ld-musl-aarch64.so.1 ]; then say libc "fail:musl"; else say libc ok; fi',
    "for p in git timeout; do if command -v $p >/dev/null 2>&1; then say $p ok; else say $p fail:missing; fi; done",
    'u=$(id -u); if [ "$u" = 0 ]; then say user fail:root; else say user "ok:$u"; fi',
    `if touch "${AGENT_HOME}/.excaliharness-probe" 2>/dev/null; then rm -f "${AGENT_HOME}/.excaliharness-probe"; say home ok; else say home fail:read-only; fi`,
    `if touch "${AGENT_HOME}/.claude/.excaliharness-probe" 2>/dev/null; then rm -f "${AGENT_HOME}/.claude/.excaliharness-probe"; say session ok; else say session fail:read-only; fi`,
    'if touch /workspace/.excaliharness-probe 2>/dev/null; then rm -f /workspace/.excaliharness-probe; say workspace ok; else say workspace fail:read-only; fi',
    `if getent hosts ${PROXY_SERVICE} >/dev/null 2>&1; then say proxy ok; else say proxy fail:unreachable; fi`,
    ...programs.map((p) => `if command -v '${p}' >/dev/null 2>&1; then say 'gate:${p}' ok; else say 'gate:${p}' fail:missing; fi`),
  ];
  return lines.join("\n");
}

// Agents run through the dev image's entrypoint, which may set up the
// environment (D-079).
const ENTRYPOINT_HINT = "If the dev service or its image sets an ENTRYPOINT, it must run the command it is given (end it with `exec \"$@\"`).";

const MESSAGES: Record<string, (detail: string) => string> = {
  claude: (d) => `Claude Code doesn't run in the agent image (${d.slice(0, 200)}). ${ENTRYPOINT_HINT}`,
  libc: () => "The dev image is based on musl (Alpine); only Debian or Ubuntu-based (glibc) dev images are supported.",
  git: () => "git isn't installed in the agent image, and it couldn't be added.",
  timeout: () => "The agent image has no `timeout` command (from coreutils); add coreutils to the Dockerfile.",
  user: () => "The agent runs as root in the dev image; it must run as a normal user.",
  home: () => "The agent's home directory isn't writable.",
  session: () => "The agent's session folder (~/.claude) isn't writable, so its session can't be saved. The base and derived images create it for uid 1000; check the dev image doesn't change /home/agent.",
  workspace: () => "The task's worktree isn't writable inside the container (check file ownership; agents run as uid 1000).",
  proxy: () => "The agent container can't resolve the egress proxy's name.",
};

export function interpret(output: string): CapabilityResult {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const m = /^([\w:./+-]+)=(ok|fail)(?::(.*))?$/.exec(line.trim());
    if (!m?.[1]) continue;
    seen.add(m[1]);
    if (m[2] !== "fail") continue;
    const detail = m[3] ?? "";
    if (m[1].startsWith("gate:")) problems.push(`The gate command \`${m[1].slice(5)}\` (README Quick reference) isn't installed in the dev image.`);
    else problems.push(MESSAGES[m[1]]?.(detail) ?? `Check ${m[1]} failed: ${detail}`);
  }
  if (!seen.has("claude")) problems.push(`The capability check didn't run in the agent image. ${ENTRYPOINT_HINT}`);
  return { ok: problems.length === 0, problems };
}

export class CapabilityCheck {
  constructor(private readonly cacheDir: string) {}

  async check(project: TaskProject, devService: string, image: string, gatePrograms: string[], signal?: AbortSignal): Promise<CapabilityResult> {
    const key = createHash("sha256").update(`${image}\n${[...gatePrograms].sort().join("\n")}`).digest("hex").slice(0, 32);
    const file = path.join(this.cacheDir, `${key}.json`);
    try {
      const cached = JSON.parse(fs.readFileSync(file, "utf8")) as CapabilityResult;
      if (cached.ok) return cached; // Failures are re-checked: the human may have fixed them.
    } catch {
      // Not cached yet.
    }
    let output: string;
    try {
      output = await project.compose(["run", "--rm", "-T", "--no-deps", devService, "sh", "-c", checkScript(gatePrograms)], {
        what: "the capability check",
        timeoutMs: 2 * 60_000,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      return { ok: false, problems: [`The capability check couldn't run: ${error instanceof Error ? error.message : String(error)}`] };
    }
    const result = interpret(output);
    if (result.ok) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(result));
    }
    return result;
  }
}
