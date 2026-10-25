// Agent definitions in agents/*.md (D-008), in the Claude Code subagent
// format: a frontmatter block of `key: value` lines, then the role prompt.
// Always read from the main checkout, never a task worktree (D-068, D-078).
import * as path from "node:path";
import { readFile } from "../store";

export interface AgentDef {
  // The link target, e.g. "agents/implementer".
  name: string;
  model?: string;
  tools: string[];
  prompt: string;
}

export type AgentResult = { ok: true; agent: AgentDef } | { ok: false; error: string };

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

const unquote = (s: string) => s.trim().replace(/^(["'])(.*)\1$/, "$2");

export function parseAgent(name: string, text: string): AgentResult {
  const m = FRONTMATTER.exec(text);
  const agent: Omit<AgentDef, "tools"> & { tools?: string[] } = { name, prompt: (m ? text.slice(m[0].length) : text).trim() };
  let key: string | undefined;
  for (const raw of (m?.[1] ?? "").split(/\r?\n/)) {
    // Comments and blank lines don't end a list.
    const line = raw.replace(/(^|[ \t])#.*$/, "").trimEnd();
    if (!line.trim()) continue;
    // A YAML list item continues the key above it (`tools:` then `- Read`).
    const item = /^[ \t]*-[ \t]+(.*?)[ \t]*$/.exec(line);
    if (item?.[1] && key === "tools") {
      (agent.tools ??= []).push(unquote(item[1]));
      continue;
    }
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*?)[ \t]*$/.exec(line);
    key = kv?.[1];
    if (!kv?.[1]) continue;
    const value = kv[2] ?? "";
    if (kv[1] === "model" && value) agent.model = unquote(value);
    // `Read, Edit` or the flow list `[Read, Edit]`.
    if (kv[1] === "tools" && value) agent.tools = value.replace(/^\[(.*)\]$/, "$1").split(",").map(unquote).filter(Boolean);
    if (kv[1] === "tools" && value === "[]") agent.tools = [];
  }
  if (!agent.prompt) return { ok: false, error: `${name}.md has no role prompt after its frontmatter` };
  // Without tools the agent could change nothing (D-079).
  if (agent.tools?.length === 0) return { ok: false, error: `${name}.md lists no tools, so its agent couldn't change anything` };
  if (!agent.tools?.length) return { ok: false, error: `${name}.md has no tools: line in its frontmatter (e.g. tools: Read, Edit, Write, Bash, Glob, Grep)` };
  return { ok: true, agent: { ...agent, tools: agent.tools } };
}

// `target` comes from a [[link]] in TASKS.md; it must stay inside agents/.
export function readAgent(root: string, target: string): AgentResult {
  const parts = target.split("/");
  if (parts[0] !== "agents" || parts.length !== 2 || parts.some((p) => p === "" || p === "." || p === "..")) {
    return { ok: false, error: `[[${target}]] isn't an agent link like [[agents/implementer]]` };
  }
  const read = readFile(path.join(root, `${target}.md`));
  if (read.status === "missing") return { ok: false, error: `${target}.md doesn't exist` };
  if (read.status === "unusable") return { ok: false, error: `${target}.md can't be used: ${read.reason}` };
  return parseAgent(target, read.content.text);
}
