// E-006: the Agent SDK in the "worker" spawns the CLI inside the task's Compose
// project, and offers one in-process tool.
import { spawn } from "node:child_process";
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const dir = process.argv[2];
const compose = ["compose", "-p", "excaliharness-e005r", "-f", `${dir}/compose.yaml`, "-f", `${dir}/override.yaml`];
let spawned;
const finish = tool("finish", "Report that the round is done, with a one-line summary.", { summary: z.string() }, async ({ summary }) => {
  console.log(`TOOL finish called: ${summary}`);
  return { content: [{ type: "text", text: "recorded" }] };
});
const q = query({
  prompt: "Call the finish tool with the summary 'hello from the container', then reply with exactly: done",
  options: {
    mcpServers: { excaliharness: createSdkMcpServer({ name: "excaliharness", tools: [finish] }) },
    allowedTools: ["mcp__excaliharness__finish"],
    spawnClaudeCodeProcess: ({ command, args, signal }) => {
      // The SDK passes its own CLI path; inside the container the CLI is `claude`.
      const cliArgs = args[0]?.endsWith(".js") || args[0]?.endsWith("cli.js") ? args.slice(1) : args;
      console.log(`spawn: command=${command.split("/").pop()} args=${cliArgs.slice(0, 6).join(" ")} …`);
      spawned = spawn("docker", [...compose, "run", "--rm", "-i", "-T", "dev", "claude", ...cliArgs], { stdio: ["pipe", "pipe", "pipe"], signal });
      spawned.stderr.on("data", (d) => process.stderr.write(`[cli stderr] ${d}`));
      return spawned;
    },
  },
});
try {
  for await (const m of q) {
    if (m.type === "system") console.log(`system: ${m.subtype} model=${m.model ?? ""} tools=${(m.tools ?? []).filter((t) => t.startsWith("mcp__")).join(",")}`);
    else if (m.type === "result") console.log(`result: ${m.subtype} ${m.is_error ? "ERROR" : ""} ${(m.result ?? "").slice(0, 120)}`);
    else if (m.type === "assistant") console.log(`assistant: ${JSON.stringify(m.message.content).slice(0, 160)}`);
  }
} catch (e) {
  console.log(`query threw: ${String(e).slice(0, 300)}`);
}
