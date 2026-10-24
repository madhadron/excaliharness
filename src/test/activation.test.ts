import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import type { ExcaliharnessApi } from "../extension";

suite("activation", () => {
  test("activates in a workspace with TASKS.md and reaches the worker", async () => {
    const extension = vscode.extensions.getExtension<ExcaliharnessApi>("madhadron.excaliharness");
    assert.ok(extension, "extension is installed");
    const api = await extension.activate();
    // Generous timeout: it includes the worker's cold start under xvfb.
    assert.equal(await api.ping(15_000), "pong");
  });
});
