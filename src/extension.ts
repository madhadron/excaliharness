import * as vscode from "vscode";
import { WorkerClient } from "./workerClient";

// Returned from activate() so integration tests can reach the worker.
export interface ExcaliharnessApi {
  ping(timeoutMs?: number): Promise<unknown>;
}

export function activate(context: vscode.ExtensionContext): ExcaliharnessApi {
  const output = vscode.window.createOutputChannel("Excaliharness", { log: true });
  const worker = new WorkerClient(context.asAbsolutePath("dist/worker.js"), (line) => output.info(line));
  // The worker goes first so it is stopped before the channel it logs to.
  context.subscriptions.push({ dispose: () => worker.dispose() }, output);

  worker.request("ping").then(
    (reply) => output.info(`worker answered ping: ${String(reply)}`),
    (error: unknown) => output.error(`worker ping failed: ${error instanceof Error ? error.message : String(error)}`),
  );

  return { ping: (timeoutMs) => worker.request("ping", timeoutMs) };
}

export function deactivate(): void {
  // Everything is disposed through context.subscriptions.
}
