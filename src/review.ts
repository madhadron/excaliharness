// "Open review" (D-014, D-027): the trusted window has the worker prepare
// the review, leaves it in global state and opens the worktree in a new
// window. VS Code doesn't trust that folder, so its tasks and workspace
// settings stay off (D-084); there the extension runs in limited mode and
// only takes the review left for it and opens the diff.
import * as fs from "node:fs";
import * as vscode from "vscode";
import { reviewIdOf, taskIdOf } from "./editorText";
import { addPending, diffEntries, takePending, type FileKind, type PendingReview } from "./reviewText";
import { printableLine } from "./worker/runner/clean";
import { isReviewInfo } from "./worker/protocol";
import type { WorkerClient } from "./workerClient";

export const OPEN_REVIEW_COMMAND = "excaliharness.openReview";
const PENDING_KEY = "excaliharness.pendingReviews";
// Exporting the base files can take a while in a big change.
const PREPARE_TIMEOUT_MS = 60_000;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function realpath(p: string): string | undefined {
  try {
    return fs.realpathSync(p);
  } catch {
    return undefined;
  }
}

// A worktree file the diff may open: reached with no symbolic link on the
// way (its real path is the path itself) and a plain file.
function fileKind(file: string): FileKind {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return "missing";
  return stat.isFile() && realpath(file) === file ? "file" : "unsafe";
}

// Takes the review left for this window, if its only folder is that
// review's worktree, and opens the diff. Runs in any window, trusted or not.
export class ReviewReceiver implements vscode.Disposable {
  private checking = false;
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly state: vscode.Memento,
    private readonly output: vscode.LogOutputChannel,
  ) {
    // A window already open on the worktree is focused, not started again.
    this.subscription = vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) void this.check();
    });
  }

  async check(): Promise<boolean> {
    const folders = vscode.workspace.workspaceFolders;
    const folder = folders?.length === 1 ? folders[0] : undefined;
    const here = folder?.uri.scheme === "file" ? realpath(folder.uri.fsPath) : undefined;
    if (this.checking || !here) return false;
    this.checking = true;
    try {
      const { review, rest } = takePending(this.state.get(PENDING_KEY), (worktree) => realpath(worktree) === here, Date.now());
      if (!review) return false;
      await this.state.update(PENDING_KEY, rest);
      await showDiff(review, here, this.output);
      return true;
    } catch (error) {
      this.output.warn(`couldn't open the review: ${message(error)}`);
      void vscode.window.showErrorMessage(`Couldn't open the review: ${message(error)}.`);
      return true;
    } finally {
      this.checking = false;
    }
  }

  // Leaves a review for the window on its worktree.
  async leave(review: Omit<PendingReview, "at">): Promise<void> {
    await this.state.update(PENDING_KEY, addPending(this.state.get(PENDING_KEY), review, Date.now()));
  }

  dispose(): void {
    this.subscription.dispose();
  }
}

async function showDiff(review: PendingReview, worktree: string, output: vscode.LogOutputChannel): Promise<void> {
  const { entries, unsafe } = diffEntries(review, worktree, fileKind);
  if (unsafe.length) {
    // File names come from the agent's commits.
    const names = unsafe.slice(0, 5).map((f) => printableLine(f).slice(0, 200)).join(", ");
    output.warn(`${review.id}: not shown in the diff, as they aren't plain files: ${names}`);
    void vscode.window.showWarningMessage(`${unsafe.length} changed file(s) of ${review.id} aren't plain files (for example, symbolic links), so the diff doesn't show them: ${names}${unsafe.length > 5 ? ", …" : ""}`);
  }
  if (review.truncated) void vscode.window.showWarningMessage(`${review.id} changed more files than the diff shows.`);
  if (!entries.length) {
    void vscode.window.showInformationMessage(`${review.id} has no committed changes to review yet.`);
    return;
  }
  const resources = entries.map((e) => {
    const left = e.left ? vscode.Uri.file(e.left) : undefined;
    const right = e.right ? vscode.Uri.file(e.right) : undefined;
    return [right ?? left, left, right];
  });
  await vscode.commands.executeCommand("vscode.changes", `${review.id}: changes since ${review.base.slice(0, 12)}`, resources);
}

// The trusted window's side: the command, and the vscode:// link (D-027).
export function registerOpenReview(root: string, worker: WorkerClient, receiver: ReviewReceiver): vscode.Disposable[] {
  const open = async (id: string) => {
    try {
      const review = await worker.request("review/prepare", { id }, PREPARE_TIMEOUT_MS);
      if (!isReviewInfo(review) || review.id !== id) throw new Error("the worker's answer wasn't a review");
      await receiver.leave(review);
      // This window may be the worktree's own; then it opens the diff here.
      if (await receiver.check()) return;
      await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(review.worktree), { forceNewWindow: true });
    } catch (error) {
      void vscode.window.showErrorMessage(`Couldn't open the review of ${id}: ${message(error)}.`);
    }
  };
  return [
    vscode.commands.registerCommand(OPEN_REVIEW_COMMAND, (arg?: { id?: unknown }) => {
      const given = typeof arg?.id === "string" && /^T-\d+$/.test(arg.id) ? arg.id : undefined;
      const active = vscode.window.activeTextEditor?.document.uri.fsPath;
      const id = given ?? (active ? taskIdOf(root, active) : undefined);
      if (!id) {
        void vscode.window.showWarningMessage("Open a task file (tasks/T-NNN.md) to open its review.");
        return;
      }
      return open(id);
    }),
    vscode.window.registerUriHandler({
      handleUri: (uri) => {
        const id = reviewIdOf(uri.path);
        if (id) return open(id);
        void vscode.window.showWarningMessage("Excaliharness links open a task's review: vscode://madhadron.excaliharness/review/T-NNN.");
      },
    }),
  ];
}
