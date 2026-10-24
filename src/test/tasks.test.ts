import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ExcaliharnessApi } from "../extension";

const root = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
const file = (rel: string) => path.join(root(), rel);

async function waitFor<T>(get: () => T | undefined | Promise<T | undefined>, what: string, ms = 15_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = await get();
    if (value !== undefined) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function api(): Promise<ExcaliharnessApi> {
  const extension = vscode.extensions.getExtension<ExcaliharnessApi | undefined>("madhadron.excaliharness");
  assert.ok(extension);
  const exported = await extension.activate();
  assert.ok(exported, "extension found TASKS.md");
  await waitFor(() => exported.snapshot(), "the first task snapshot");
  return exported;
}

suite("task files", () => {
  test("[[T-001]] links to tasks/T-001.md", async () => {
    await api();
    const uri = vscode.Uri.file(file("tasks/T-002.md"));
    const document = await vscode.workspace.openTextDocument(uri);
    assert.equal(document.languageId, "markdown");
    const links = await vscode.commands.executeCommand<vscode.DocumentLink[]>("vscode.executeLinkProvider", uri);
    const targets = links.map((l) => l.target?.fsPath);
    assert.ok(targets.includes(file("tasks/T-001.md")), `links: ${JSON.stringify(targets)}`);
  });

  test("the index is generated from the task files", async () => {
    await api();
    await waitFor(() => (fs.readFileSync(file("TASKS.md"), "utf8").includes("* [[T-002]] Password reset flow · draft") ? true : undefined), "the index");
  });

  test("a draft shows Mark ready, and the command marks it", async () => {
    const ext = await api();
    const uri = vscode.Uri.file(file("tasks/T-001.md"));
    await vscode.window.showTextDocument(uri);
    const titles = await waitFor(async () => {
      const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", uri);
      const found = lenses.map((l) => l.command?.title);
      return found.includes("Mark ready") ? found : undefined;
    }, "the Mark ready CodeLens");
    assert.deepEqual(titles, ["Mark ready"]);

    await vscode.commands.executeCommand("excaliharness.markReady", { id: "T-001" });
    const text = fs.readFileSync(file("tasks/T-001.md"), "utf8");
    assert.match(text, /^\* status: ready$/m);
    assert.match(text, /· human · status: draft → ready$/m);
    // T-002 is still a draft: the orchestrator never promotes drafts.
    await waitFor(() => ext.snapshot()?.tasks.find((t) => t.id === "T-001" && t.status === "ready"), "the new snapshot");
    assert.equal(ext.snapshot()?.tasks.find((t) => t.id === "T-002")?.status, "draft");
  });
});
