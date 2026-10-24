import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { registerCommands, RESTART_COMMAND } from "./commands";
import { TaskDiagnostics } from "./diagnostics";
import { WikilinkProvider } from "./links";
import { StatusLensProvider } from "./statusLens";
import { TaskState } from "./taskState";
import type { TasksSnapshot } from "./worker/protocol";
import { WorkerClient } from "./workerClient";

// Returned from activate() so integration tests can reach the worker.
export interface ExcaliharnessApi {
  ping(timeoutMs?: number): Promise<unknown>;
  snapshot(): TasksSnapshot | undefined;
}

function findRoot(): string | undefined {
  return vscode.workspace.workspaceFolders
    ?.map((f) => f.uri.fsPath)
    .find((dir) => fs.existsSync(path.join(dir, "TASKS.md")));
}

export function activate(context: vscode.ExtensionContext): ExcaliharnessApi | undefined {
  const output = vscode.window.createOutputChannel("Excaliharness", { log: true });
  const root = findRoot();
  if (!root) {
    output.info("No workspace folder contains TASKS.md; nothing to orchestrate.");
    context.subscriptions.push(output);
    return undefined;
  }
  // Shows the commands in the palette only where they work.
  void vscode.commands.executeCommand("setContext", "excaliharness.active", true);

  const state = new TaskState();
  const diagnostics = new TaskDiagnostics(root);
  const worker = new WorkerClient({
    workerPath: context.asAbsolutePath("dist/worker.js"),
    root,
    log: (line) => output.info(line),
    onNotification: (n) => {
      if (n.method === "tasks/changed") state.update(n.params);
      else diagnostics.update(n.params);
    },
    onExit: () => {
      state.reset();
      diagnostics.clear();
    },
    onGiveUp: () => {
      void vscode.window
        .showErrorMessage("The Excaliharness worker keeps crashing, so it has been stopped.", "Restart worker", "Show log")
        .then((choice) => {
          if (choice === "Restart worker") void vscode.commands.executeCommand(RESTART_COMMAND);
          else if (choice === "Show log") output.show();
        });
    },
  });

  const markdown: vscode.DocumentSelector = { scheme: "file", language: "markdown" };
  const lens = new StatusLensProvider(root, state);
  // The worker goes first so it is stopped before the channel it logs to.
  context.subscriptions.push(
    { dispose: () => worker.dispose() },
    output,
    state,
    diagnostics,
    lens,
    vscode.languages.registerDocumentLinkProvider(markdown, new WikilinkProvider(root)),
    vscode.languages.registerCodeLensProvider({ ...markdown, pattern: new vscode.RelativePattern(root, "tasks/T-*.md") }, lens),
    ...registerCommands(root, worker, state),
  );

  return {
    ping: (timeoutMs) => worker.request("ping", undefined, timeoutMs),
    snapshot: () => state.snapshot,
  };
}

export function deactivate(): void {
  // Everything is disposed through context.subscriptions.
}
