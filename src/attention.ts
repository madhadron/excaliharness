// Tells the human a task needs them (D-077, D-084): a notification with a
// button, spoken through macOS `say` unless excaliharness.speakNotifications
// is off.
import { execFile } from "node:child_process";
import * as path from "node:path";
import * as vscode from "vscode";
import { attentionAction, attentionMessage, spokenMessage } from "./attentionText";
import type { TaskAttention } from "./worker/protocol";

export const OPEN_TASK_COMMAND = "excaliharness.openTaskAt";

export function speakNotifications(): boolean {
  return vscode.workspace.getConfiguration("excaliharness").get<boolean>("speakNotifications", true);
}

function say(text: string, output: vscode.LogOutputChannel): void {
  if (process.platform !== "darwin" || !speakNotifications()) return;
  execFile("say", [text], (error) => {
    if (error) output.warn(`couldn't speak the notification: ${error.message}`);
  });
}

export function showAttention(root: string, a: TaskAttention, output: vscode.LogOutputChannel): void {
  const message = attentionMessage(a);
  say(spokenMessage(a), output);
  const action = attentionAction(a);
  const failed = (error: unknown) => output.warn(`couldn't open ${a.id}: ${error instanceof Error ? error.message : String(error)}`);
  vscode.window.showInformationMessage(`${message}: ${a.title}`, action).then((choice) => {
    if (choice === "Open review" && a.worktree) {
      // A new window on a folder VS Code doesn't trust yet: its tasks and
      // workspace settings stay off until the human trusts it (D-084).
      vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(a.worktree), { forceNewWindow: true }).then(undefined, failed);
    } else if (choice === "Open task") {
      vscode.commands.executeCommand(OPEN_TASK_COMMAND, path.join(root, a.path), a.status === "needs-decision" ? a.questionsLine : undefined).then(undefined, failed);
    }
  }, failed);
}

// Opens a task file, at a 0-based line if given. Only files in tasks/.
export async function openTaskAt(root: string, file: string, line?: number): Promise<void> {
  const rel = path.relative(path.join(root, "tasks"), path.resolve(file));
  if (rel.startsWith("..") || path.isAbsolute(rel) || !/^T-\d+\.md$/.test(rel)) throw new Error(`${file} isn't a task file`);
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const at = new vscode.Position(Math.min(Math.max(line ?? 0, 0), Math.max(document.lineCount - 1, 0)), 0);
  await vscode.window.showTextDocument(document, { selection: new vscode.Range(at, at) });
}
