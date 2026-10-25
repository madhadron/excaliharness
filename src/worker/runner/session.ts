// One agent turn (D-067, D-068, D-071): the Agent SDK runs here in the worker
// and starts the CLI inside the task's Compose project, so the orchestrator's
// tools and state stay out of the agent's reach (E-006).
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createSdkMcpServer, query, tool, type SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { AgentDef } from "../agents/agentDefs";
import { printable } from "./clean";
import type { TaskProject } from "./project";

export const TOOL_SERVER = "excaliharness";
// A round's turn limit (D-079): one turn is one model response and its tool
// calls.
export const MAX_TURNS = 100;
const STDERR_TAIL = 16 * 1024;
export const FINISH_TOOL = `mcp__${TOOL_SERVER}__finish`;

// The SDK checks that its CLI exists before spawning, but the worker never
// runs a CLI on the host (E-006); this stub satisfies the check and explains
// itself if anything ever runs it.
export function cliStub(stateDir: string): string {
  const file = path.join(stateDir, "claude-runs-in-a-container");
  if (!fs.existsSync(file)) {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(file, '#!/bin/sh\necho "Excaliharness runs Claude Code inside the task\'s container, not here." >&2\nexit 1\n', { mode: 0o755 });
  }
  return file;
}

export interface AgentRun {
  project: TaskProject;
  service: string;
  agent: AgentDef;
  systemPrompt: string;
  prompt: string;
  // The session to continue (D-071).
  resume?: string;
  abort: AbortController;
  log: (line: string) => void;
  stateDir: string;
  // Called with the session ID as soon as the CLI reports it (D-071).
  onSession?: (sessionId: string) => void;
}

export interface AgentOutcome {
  sessionId?: string;
  summary?: string;
  error?: string;
  // Whether the model answered at all (a failed resume doesn't get that far).
  answered: boolean;
  // The SDK reported that Claude rejected the token.
  authFailed?: boolean;
  // The end of the CLI's stderr, cleaned: where it explains a failure the SDK
  // doesn't pass on (e.g. a session it can't resume).
  stderr?: string;
}

// The `docker compose run` command that stands in for the CLI. The SDK passes
// its CLI arguments; inside the container the CLI is `claude`.
export function cliCommand(project: TaskProject, service: string, options: Pick<SpawnOptions, "args">): string[] {
  const args = options.args[0]?.endsWith(".js") || options.args[0]?.endsWith(".mjs") ? options.args.slice(1) : options.args;
  return [...project.composeArgs(), "run", "--rm", "-i", "-T", "--no-deps", service, "claude", ...args];
}

export async function runAgent(run: AgentRun): Promise<AgentOutcome> {
  const outcome: AgentOutcome = { answered: false };
  // The SDK reads only stdout from a process it didn't start; stderr is
  // drained here so a full pipe can't stall the CLI.
  let stderr = "";
  const finish = tool(
    "finish",
    "Call this once, when you have finished this round's work, with a one-paragraph summary of what you changed and anything left open.",
    { summary: z.string().max(4_000) },
    // eslint-disable-next-line @typescript-eslint/require-await -- the SDK expects a promise
    async ({ summary }) => {
      outcome.summary = summary;
      return { content: [{ type: "text", text: "Recorded. End your turn now." }] };
    },
  );
  const allowedTools = [...run.agent.tools, FINISH_TOOL];
  // The tools the model sees at all: the agent's own, without any
  // permission patterns like Bash(npm *).
  const tools = [...new Set(run.agent.tools.map((t) => t.replace(/\(.*$/, "")).filter((t) => !t.startsWith("mcp__")))];
  const options: Parameters<typeof query>[0]["options"] = {
    tools,
    // Claude Code's own prompt, then ours (D-079).
    systemPrompt: { type: "preset", preset: "claude_code", append: run.systemPrompt },
    maxTurns: MAX_TURNS,
    allowedTools,
    // Anything not allowed is refused without asking anyone.
    permissionMode: "dontAsk",
    mcpServers: { [TOOL_SERVER]: createSdkMcpServer({ name: TOOL_SERVER, tools: [finish] }) },
    abortController: run.abort,
    // Only what this code passes: no user or project settings files.
    settingSources: [],
    pathToClaudeCodeExecutable: cliStub(run.stateDir),
    spawnClaudeCodeProcess: (spawnOptions) => {
      const child = spawn("docker", cliCommand(run.project, run.service, spawnOptions), {
        env: run.project.env(),
        stdio: ["pipe", "pipe", "pipe"],
        signal: spawnOptions.signal,
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_TAIL);
      });
      return child;
    },
  };
  // "inherit" (subagent format) means the default model.
  if (run.agent.model && run.agent.model !== "inherit") options.model = run.agent.model;
  if (run.resume) options.resume = run.resume;
  try {
    for await (const message of query({ prompt: run.prompt, options })) {
      if ("session_id" in message && typeof message.session_id === "string" && message.session_id !== outcome.sessionId) {
        outcome.sessionId = message.session_id;
        run.onSession?.(message.session_id);
      }
      if (message.type === "assistant") {
        if (message.error === "authentication_failed") outcome.authFailed = true;
        else if (!message.error) outcome.answered = true;
      }
      if (message.type === "result") {
        if (message.subtype === "error_max_turns") outcome.error = `the agent reached its limit of ${MAX_TURNS} turns`;
        else if (message.subtype !== "success" || message.is_error) {
          const errors = "errors" in message && Array.isArray(message.errors) ? message.errors.filter((e): e is string => typeof e === "string") : [];
          outcome.error =
            "result" in message && typeof message.result === "string" ? message.result : errors.length ? errors.join("; ") : `the agent stopped (${message.subtype})`;
        }
      }
    }
  } catch (error) {
    outcome.error ??= error instanceof Error ? error.message : String(error);
  }
  if (outcome.summary !== undefined) outcome.summary = printable(outcome.summary);
  if (outcome.error) {
    outcome.error = printable(outcome.error);
    run.log(`agent ${run.agent.name}: ${outcome.error.slice(0, 300)}`);
    // Agent-controlled text, cleaned before logging.
    const clean = printable(stderr).trim();
    if (clean) outcome.stderr = clean;
    if (clean) run.log(`agent ${run.agent.name} stderr:\n${clean.split("\n").slice(-20).join("\n")}`);
  }
  return outcome;
}
