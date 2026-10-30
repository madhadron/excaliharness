import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { OPEN_TASK_COMMAND, openTaskAt, showAttention } from "./attention";
import { ACCOUNT_COMMAND, AuthManager, SIGN_IN_COMMAND, SIGN_OUT_COMMAND } from "./auth";
import { registerCommands, RESTART_COMMAND } from "./commands";
import { TaskDiagnostics } from "./diagnostics";
import { WikilinkProvider } from "./links";
import { registerOpenReview, ReviewReceiver } from "./review";
import { StatusLensProvider } from "./statusLens";
import { TaskState } from "./taskState";
import type { TasksSnapshot } from "./worker/protocol";
import { WorkerClient } from "./workerClient";

// Returned from activate() so integration tests can reach the worker.
export interface ExcaliharnessApi {
  ping(timeoutMs?: number): Promise<unknown>;
  snapshot(): TasksSnapshot | undefined;
  signedIn(): boolean;
}

function findRoot(): string | undefined {
  return vscode.workspace.workspaceFolders
    ?.map((f) => f.uri.fsPath)
    .find((dir) => fs.existsSync(path.join(dir, "TASKS.md")));
}

export function activate(context: vscode.ExtensionContext): ExcaliharnessApi | undefined {
  const output = vscode.window.createOutputChannel("Excaliharness", { log: true });
  // In every window, trusted or not: a review the trusted window left for
  // this one (D-027).
  const receiver = new ReviewReceiver(context.globalState, output);
  // Disposed in order: what the trusted part starts goes before the channel
  // it logs to.
  const trusted: vscode.Disposable[] = [];
  context.subscriptions.push({ dispose: () => trusted.forEach((d) => d.dispose()) }, receiver, output);
  void receiver.check();
  if (vscode.workspace.isTrusted) return activateTrusted(context, output, receiver, trusted);
  // Limited mode (package.json): no worker, watcher or commands in a folder
  // VS Code doesn't trust, such as a review's worktree.
  let started = false;
  trusted.push(
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      if (started) return;
      started = true;
      activateTrusted(context, output, receiver, trusted);
    }),
  );
  return undefined;
}

function activateTrusted(
  context: vscode.ExtensionContext,
  output: vscode.LogOutputChannel,
  receiver: ReviewReceiver,
  subscriptions: vscode.Disposable[],
): ExcaliharnessApi | undefined {
  const root = findRoot();
  if (!root) {
    output.info("No workspace folder contains TASKS.md; nothing to orchestrate.");
    return undefined;
  }
  // Shows the commands in the palette only where they work.
  void vscode.commands.executeCommand("setContext", "excaliharness.active", true);

  const state = new TaskState();
  const diagnostics = new TaskDiagnostics(root);
  // Sign-in notifications go to the AuthManager, created right after the
  // worker; none can arrive before then, since they need a sign-in request.
  const forAuth: { manager?: AuthManager } = {};
  const maxParallelTasks = () => vscode.workspace.getConfiguration("excaliharness").get<number>("maxParallelTasks", 2);
  const stateDir = (context.storageUri ?? context.globalStorageUri).fsPath;
  fs.mkdirSync(stateDir, { recursive: true });
  const worker = new WorkerClient({
    workerPath: context.asAbsolutePath("dist/worker.js"),
    root,
    dockerfile: context.asAbsolutePath("agent-image/Dockerfile"),
    stateDir,
    maxParallelTasks,
    // Each new worker process needs the token and settings again.
    onSpawn: () => {
      void forAuth.manager?.pushToken();
      void worker.request("settings/update", { maxParallelTasks: maxParallelTasks() }).catch(() => undefined);
    },
    log: (line) => output.info(line),
    onNotification: (n) => {
      if (n.method === "tasks/changed") state.update(n.params);
      else if (n.method === "tasks/diagnostics") diagnostics.update(n.params);
      else if (n.method === "task/attention") showAttention(root, n.params, output);
      else forAuth.manager?.handleNotification(n);
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

  const signIn = new AuthManager(context.secrets, worker, output);
  forAuth.manager = signIn;
  // The first worker started before the AuthManager existed.
  void signIn.pushToken();
  void worker.request("settings/update", { maxParallelTasks: maxParallelTasks() }).catch(() => undefined);

  const markdown: vscode.DocumentSelector = { scheme: "file", language: "markdown" };
  const lens = new StatusLensProvider(root, state);
  // The worker goes first so it is stopped before the channel it logs to.
  subscriptions.push(
    { dispose: () => worker.dispose() },
    state,
    diagnostics,
    lens,
    vscode.languages.registerDocumentLinkProvider(markdown, new WikilinkProvider(root)),
    vscode.languages.registerCodeLensProvider({ ...markdown, pattern: new vscode.RelativePattern(root, "tasks/T-*.md") }, lens),
    vscode.languages.registerCodeLensProvider({ ...markdown, pattern: new vscode.RelativePattern(root, "TASKS.md") }, lens),
    ...registerCommands(root, worker, state),
    ...registerOpenReview(root, worker, receiver),
    signIn,
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("excaliharness.maxParallelTasks")) {
        void worker.request("settings/update", { maxParallelTasks: maxParallelTasks() }).catch(() => undefined);
      }
    }),
    vscode.commands.registerCommand(SIGN_IN_COMMAND, () => signIn.signIn()),
    vscode.commands.registerCommand(SIGN_OUT_COMMAND, () => signIn.signOut()),
    vscode.commands.registerCommand(ACCOUNT_COMMAND, () => signIn.account()),
    vscode.commands.registerCommand(OPEN_TASK_COMMAND, (file: string, line?: number) => openTaskAt(root, file, line)),
  );

  return {
    ping: (timeoutMs) => worker.request("ping", undefined, timeoutMs),
    snapshot: () => state.snapshot,
    signedIn: () => signIn.isSignedIn,
  };
}

export function deactivate(): void {
  // Everything is disposed through context.subscriptions.
}
