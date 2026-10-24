// Shows the worker's parse errors and warnings in the Problems panel (D-038).
import * as path from "node:path";
import * as vscode from "vscode";
import type { DiagnosticsSnapshot } from "./worker/protocol";

export class TaskDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection("excaliharness");
  private version = 0;

  constructor(private readonly root: string) {}

  update(snapshot: DiagnosticsSnapshot): void {
    if (snapshot.version <= this.version) return;
    this.version = snapshot.version;
    this.collection.clear();
    for (const file of snapshot.files) {
      const uri = vscode.Uri.file(path.join(this.root, file.path));
      this.collection.set(
        uri,
        file.diagnostics.map((d) => {
          const diagnostic = new vscode.Diagnostic(
            new vscode.Range(d.line, 0, d.line, Number.MAX_SAFE_INTEGER),
            d.message,
            d.severity === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
          );
          diagnostic.source = "Excaliharness";
          return diagnostic;
        }),
      );
    }
  }

  // The worker exited: what it reported may no longer be true.
  clear(): void {
    this.version = 0;
    this.collection.clear();
  }

  dispose(): void {
    this.collection.dispose();
  }
}
