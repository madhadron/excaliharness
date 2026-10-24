// "Mark ready" / "Mark done" above a task's status line (D-043). The lens is
// placed from the live document text; which actions it offers comes from the
// worker's latest snapshot, so it agrees with the rules the worker applies.
import * as vscode from "vscode";
import { statusOf, taskIdOf } from "./editorText";
import type { TaskState } from "./taskState";

export const LENS_TITLES = { ready: "Mark ready", done: "Mark done" } as const;
export const COMMANDS = { ready: "excaliharness.markReady", done: "excaliharness.markDone" } as const;

export class StatusLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly root: string,
    private readonly state: TaskState,
  ) {
    this.subscription = state.onDidChange(() => this.changed.fire());
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const id = taskIdOf(this.root, document.uri.fsPath);
    const task = id ? this.state.task(id) : undefined;
    const statusLine = id ? statusOf(document.getText(), id) : undefined;
    if (!id || !task || !statusLine) return [];
    const range = new vscode.Range(statusLine.line, 0, statusLine.line, 0);
    return task.allowed.map(
      (to) => new vscode.CodeLens(range, { title: LENS_TITLES[to], command: COMMANDS[to], arguments: [{ id }] }),
    );
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }
}
