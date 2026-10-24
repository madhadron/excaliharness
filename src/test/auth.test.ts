import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import type { ExcaliharnessApi } from "../extension";

suite("sign-in", () => {
  test("offers Sign In to Claude and starts signed out", async () => {
    const extension = vscode.extensions.getExtension<ExcaliharnessApi | undefined>("madhadron.excaliharness");
    assert.ok(extension);
    const api = await extension.activate();
    assert.ok(api);
    const commands = await vscode.commands.getCommands(true);
    for (const command of ["excaliharness.signIn", "excaliharness.signOut", "excaliharness.claudeAccount"]) {
      assert.ok(commands.includes(command), command);
    }
    assert.equal(api.signedIn(), false);
  });
});
