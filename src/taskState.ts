// The extension's copy of the worker's latest task snapshot.
import * as vscode from "vscode";
import type { TasksSnapshot, TaskSummary } from "./worker/protocol";

export class TaskState implements vscode.Disposable {
  private current: TasksSnapshot | undefined;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  get snapshot(): TasksSnapshot | undefined {
    return this.current;
  }

  get readOnly(): boolean {
    return this.current?.readOnly ?? false;
  }

  task(id: string): TaskSummary | undefined {
    return this.current?.tasks.find((t) => t.id === id);
  }

  // Ignores snapshots older than the one held (they can arrive out of order).
  update(snapshot: TasksSnapshot): void {
    if (this.current && snapshot.version <= this.current.version) return;
    this.current = snapshot;
    this.changed.fire();
  }

  // The worker restarted; its versions start again from 1.
  reset(): void {
    this.current = undefined;
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
  }
}
