// Mark ready / Mark done (D-043, D-045) and Restart Worker (D-046).
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { statusOf, taskIdOf } from "./editorText";
import { COMMANDS } from "./statusLens";
import type { TaskState } from "./taskState";
import { isStatus } from "./worker/tasks/model";
import type { HumanStatus } from "./worker/tasks/transitions";
import type { WorkerClient } from "./workerClient";

export const RESTART_COMMAND = "excaliharness.restartWorker";
// Generous: the worker may be busy with a pass, and the request is safe to
// apply late because it is compare-and-set.
const SET_STATUS_TIMEOUT_MS = 15_000;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function registerCommands(root: string, worker: WorkerClient, state: TaskState): vscode.Disposable[] {
  const mark = async (to: HumanStatus, arg?: { id?: unknown }) => {
    const id = typeof arg?.id === "string" ? arg.id : undefined;
    const file = id
      ? path.join(root, "tasks", `${id}.md`)
      : vscode.window.activeTextEditor?.document.uri.fsPath;
    const taskId = file ? taskIdOf(root, file) : undefined;
    if (!file || !taskId) {
      void vscode.window.showWarningMessage(`Open a task file (tasks/T-NNN.md) to mark it ${to}.`);
      return;
    }
    if (state.readOnly) {
      void vscode.window.showInformationMessage("Another VS Code window is orchestrating this repository, so tasks can't be changed here.");
      return;
    }
    const document = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === file);
    if (document?.isDirty) {
      const save = `Save and mark ${to}`;
      const choice = await vscode.window.showWarningMessage(`${taskId} has unsaved changes.`, save);
      if (choice !== save) return;
      if (!(await document.save())) {
        void vscode.window.showErrorMessage(`Couldn't save ${taskId}, so it wasn't marked ${to}.`);
        return;
      }
    }
    try {
      // Hash what's on disk now, so the worker refuses if it changes first.
      const bytes = await fs.readFile(file);
      const status = statusOf(bytes.toString("utf8"), taskId)?.value;
      if (!status || !isStatus(status)) {
        void vscode.window.showErrorMessage(`${taskId} doesn't parse (see the Problems panel), so it can't be marked ${to}.`);
        return;
      }
      await worker.request(
        "tasks/setStatus",
        { id: taskId, to, expectedStatus: status, expectedHash: createHash("sha256").update(bytes).digest("hex") },
        SET_STATUS_TIMEOUT_MS,
      );
    } catch (error) {
      void vscode.window.showErrorMessage(`Couldn't mark ${taskId} ${to}: ${message(error)}.`);
    }
  };

  return [
    vscode.commands.registerCommand(COMMANDS.ready, (arg?: { id?: unknown }) => mark("ready", arg)),
    vscode.commands.registerCommand(COMMANDS.done, (arg?: { id?: unknown }) => mark("done", arg)),
    vscode.commands.registerCommand(RESTART_COMMAND, () => worker.restart()),
  ];
}
