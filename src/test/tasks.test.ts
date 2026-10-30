import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
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

  test("a parked task shows an error and offers Mark ready and Back to draft (D-076)", async () => {
    await api();
    const uri = vscode.Uri.file(file("tasks/T-003.md"));
    await vscode.window.showTextDocument(uri);
    const diagnostic = await waitFor(() => vscode.languages.getDiagnostics(uri).find((d) => d.message.includes("is parked")), "the parked diagnostic");
    assert.equal(diagnostic.severity, vscode.DiagnosticSeverity.Error);
    const titles = await waitFor(async () => {
      const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", uri);
      const found = lenses.map((l) => l.command?.title ?? "");
      return found.length ? found : undefined;
    }, "the parked task's CodeLens");
    assert.deepEqual(titles, ["Mark ready", "Back to draft"]);
  });
});

suite("review", () => {
  const lensTitles = async (uri: vscode.Uri, line: number) => {
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", uri);
    return lenses.filter((l) => l.range.start.line === line).map((l) => l.command?.title ?? "");
  };

  test("a task in review offers Open review above its status line (D-027)", async () => {
    await api();
    const uri = vscode.Uri.file(file("tasks/T-004.md"));
    await vscode.window.showTextDocument(uri);
    const titles = await waitFor(async () => {
      const found = await lensTitles(uri, 2);
      return found.includes("Open review") ? found : undefined;
    }, "the Open review CodeLens");
    assert.deepEqual(titles, ["Mark done", "Open review"]);
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", uri);
    const open = lenses.find((l) => l.command?.title === "Open review");
    assert.equal(open?.command?.command, "excaliharness.openReview");
    assert.deepEqual(open?.command?.arguments, [{ id: "T-004" }]);
  });

  test("the TASKS.md entry of a task in review offers Open review, and no other entry does", async () => {
    await api();
    const uri = vscode.Uri.file(file("TASKS.md"));
    await vscode.window.showTextDocument(uri);
    const line = await waitFor(() => {
      const index = fs.readFileSync(file("TASKS.md"), "utf8").split("\n").findIndex((l) => l.startsWith("* [[T-004]]"));
      return index >= 0 ? index : undefined;
    }, "T-004's index line");
    await waitFor(async () => ((await lensTitles(uri, line)).includes("Open review") ? true : undefined), "the index CodeLens");
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", uri);
    assert.deepEqual(
      lenses.map((l) => [l.range.start.line, l.command?.title, l.command?.arguments]),
      [[line, "Open review", [{ id: "T-004" }]]],
    );
  });
});

suite("receiving a review", () => {
  test("the window on a review's worktree takes it and opens the diff, leaving out symbolic links (D-027)", async () => {
    const ext = await api();
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-base-"));
    fs.mkdirSync(path.join(baseDir, "tasks"));
    fs.writeFileSync(path.join(baseDir, "tasks", "T-002.md"), "# T-002: Old title\n");
    fs.symlinkSync(file("tasks/T-001.md"), file("link.md"));
    try {
      // This test window stands in for the worktree's.
      const review = {
        id: "T-004",
        worktree: root(),
        baseDir,
        base: "0123456789abcdef",
        files: [
          { path: "tasks/T-002.md", change: "modified" as const },
          { path: "link.md", change: "added" as const },
        ],
        truncated: false,
      };
      assert.equal(await ext.receiveReview(review), true);
      const tabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs);
      await waitFor(() => tabs().find((t) => t.label.startsWith("T-004: changes since 0123456789ab")), "the diff editor");
      // A review for another folder isn't this window's to take.
      assert.equal(await ext.receiveReview({ ...review, id: "T-005", worktree: baseDir }), false);
    } finally {
      fs.rmSync(file("link.md"), { force: true });
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });
});

suite("attention", () => {
  test('"Open task" opens the task file at its questions (D-084)', async () => {
    await api();
    await vscode.commands.executeCommand("excaliharness.openTaskAt", file("tasks/T-002.md"), 2);
    const editor = await waitFor(() => vscode.window.activeTextEditor, "an editor");
    assert.equal(editor.document.uri.fsPath, file("tasks/T-002.md"));
    assert.equal(editor.selection.active.line, 2);
  });
});
