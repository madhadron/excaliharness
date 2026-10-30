// "Mark ready" / "Mark done" above a task's status line (D-043), and "Open
// review" there and on the task's TASKS.md index line (D-027). The lens is
// placed from the live document text; which actions it offers comes from the
// worker's latest snapshot, so it agrees with the rules the worker applies.
import * as path from "node:path";
import * as vscode from "vscode";
import { indexEntries, statusOf, taskIdOf } from "./editorText";
import { OPEN_REVIEW_COMMAND } from "./review";
import type { TaskState } from "./taskState";

export const LENS_TITLES = { ready: "Mark ready", done: "Mark done", draft: "Back to draft" } as const;
export const COMMANDS = { ready: "excaliharness.markReady", done: "excaliharness.markDone", draft: "excaliharness.backToDraft" } as const;
export const OPEN_REVIEW_TITLE = "Open review";

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
    if (document.uri.fsPath === path.join(this.root, "TASKS.md")) {
      return indexEntries(document.getText())
        .filter(({ id }) => this.inReview(id))
        .map(({ id, line }) => this.openReview(id, line));
    }
    const id = taskIdOf(this.root, document.uri.fsPath);
    const task = id ? this.state.task(id) : undefined;
    const statusLine = id ? statusOf(document.getText(), id) : undefined;
    if (!id || !task || !statusLine) return [];
    const range = new vscode.Range(statusLine.line, 0, statusLine.line, 0);
    const lenses = task.allowed.map(
      (to) => new vscode.CodeLens(range, { title: LENS_TITLES[to], command: COMMANDS[to], arguments: [{ id }] }),
    );
    return this.inReview(id) ? [...lenses, this.openReview(id, statusLine.line)] : lenses;
  }

  // A task hand-edited into review (parked) may have no worktree.
  private inReview(id: string): boolean {
    const task = this.state.task(id);
    return task?.status === "review" && !task.parked;
  }

  private openReview(id: string, line: number): vscode.CodeLens {
    return new vscode.CodeLens(new vscode.Range(line, 0, line, 0), { title: OPEN_REVIEW_TITLE, command: OPEN_REVIEW_COMMAND, arguments: [{ id }] });
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }
}
