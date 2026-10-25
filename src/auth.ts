// Claude sign-in for the extension (D-022, D-049, D-050, D-054, D-055). The
// worker runs the sign-in container; this shows the UI and keeps the token in
// SecretStorage.
import * as vscode from "vscode";
import type { Notification } from "./worker/protocol";
import { WorkerError, type WorkerClient } from "./workerClient";

export const SIGN_IN_COMMAND = "excaliharness.signIn";
export const SIGN_OUT_COMMAND = "excaliharness.signOut";
// What the status bar item runs: sign in, or when signed in, ask what to do.
export const ACCOUNT_COMMAND = "excaliharness.claudeAccount";
const SECRET_KEY = "excaliharness.claudeOAuthToken";
// Longer than the worker's own 10-minute deadline plus building the image.
const SIGN_IN_TIMEOUT_MS = 40 * 60_000;
const SUBMIT_TIMEOUT_MS = 60_000;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class AuthManager implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem("excaliharness.auth", vscode.StatusBarAlignment.Left, 100);
  private readonly subscriptions: vscode.Disposable[] = [];
  private inflight: Promise<string | undefined> | undefined;
  private report: ((message: string) => void) | undefined;
  // Cancelled when the current sign-in ends, closing its prompts.
  private prompts: vscode.CancellationTokenSource | undefined;
  private signedIn = false;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly worker: WorkerClient,
    private readonly output: vscode.LogOutputChannel,
  ) {
    this.item.name = "Excaliharness: Claude sign-in";
    this.item.command = ACCOUNT_COMMAND;
    this.item.show();
    this.subscriptions.push(
      this.item,
      secrets.onDidChange((e) => {
        if (e.key === SECRET_KEY) void this.refresh();
      }),
    );
    void this.refresh();
  }

  get isSignedIn(): boolean {
    return this.signedIn;
  }

  // The stored token, signing in first if there is none (D-049).
  async getToken(): Promise<string | undefined> {
    return (await this.secrets.get(SECRET_KEY)) ?? this.signIn();
  }

  // Starts a sign-in, or joins the one already running.
  signIn(): Promise<string | undefined> {
    this.inflight ??= this.run().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  // The status bar item: signs in, or if already signed in, offers to sign
  // in again or sign out (D-057).
  async account(): Promise<void> {
    if (!this.signedIn) {
      await this.signIn();
      return;
    }
    const again = "Sign in again";
    const out = "Sign out";
    const choice = await vscode.window.showInformationMessage(
      "Excaliharness is signed in to Claude.",
      {
        modal: true,
        detail:
          "Sign in again to replace the stored token with a new one. Sign out to remove it from VS Code; the token itself stays valid until you revoke it on claude.ai.",
      },
      again,
      out,
    );
    if (choice === again) await this.signIn();
    else if (choice === out) await this.signOut();
  }

  async signOut(): Promise<void> {
    await this.secrets.delete(SECRET_KEY);
    await this.refresh();
    void vscode.window.showInformationMessage("Signed out of Claude. The token was removed from VS Code.");
  }

  // Gives the worker the token for the egress proxy (D-066), if there is one.
  async pushToken(): Promise<void> {
    const token = await this.secrets.get(SECRET_KEY);
    if (token) await this.worker.request("auth/setToken", { token }).catch((error: unknown) => this.output.warn(`couldn't give the worker the token: ${message(error)}`));
  }

  handleNotification(notification: Notification): void {
    if (notification.method === "auth/required") {
      // A task needs to start: use the stored token, or sign in (D-049).
      void this.getToken().then((token) => {
        if (token) void this.pushToken();
      });
      return;
    }
    if (notification.method === "auth/prompt" && this.prompts) {
      void this.askForCode(notification.params.url, notification.params.attempt, this.prompts.token);
    }
    else if (notification.method === "progress") this.report?.(notification.params.message);
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose();
  }

  private async run(): Promise<string | undefined> {
    const prompts = new vscode.CancellationTokenSource();
    this.prompts = prompts;
    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Signing in to Claude", cancellable: true },
        async (progress, cancellation) => {
          this.report = (text) => progress.report({ message: text });
          const onCancel = cancellation.onCancellationRequested(() => this.cancelInWorker());
          try {
            return await this.worker.request("auth/signIn", undefined, SIGN_IN_TIMEOUT_MS);
          } finally {
            onCancel.dispose();
          }
        },
      );
      const token = (result as { token?: unknown } | null)?.token;
      if (typeof token !== "string" || token === "") throw new Error("the worker returned no token");
      await this.secrets.store(SECRET_KEY, token);
      await this.refresh();
      void this.pushToken();
      void vscode.window.showInformationMessage("Signed in to Claude.");
      return token;
    } catch (error) {
      // If only this side gave up (its own timeout), stop the worker too, so
      // the next attempt isn't refused as "already in progress".
      if (!(error instanceof WorkerError)) this.cancelInWorker();
      this.reportFailure(error);
      return undefined;
    } finally {
      this.report = undefined;
      this.prompts = undefined;
      prompts.cancel();
      prompts.dispose();
    }
  }

  private cancelInWorker(attempt?: number): void {
    void this.worker.request("auth/cancel", attempt === undefined ? undefined : { attempt }).catch(() => undefined);
  }

  // Opens the sign-in page on request, then asks for the code (D-054).
  // Everything here belongs to one attempt: when it ends, `ended` closes the
  // input box, and cancelling only ever cancels that attempt.
  private async askForCode(url: string, attempt: number, ended: vscode.CancellationToken): Promise<void> {
    const open = "Open sign-in page";
    const host = vscode.Uri.parse(url, true).authority;
    const choice = await vscode.window.showInformationMessage(`Sign in to Claude at ${host} in your browser, then paste the code it shows.`, open);
    if (ended.isCancellationRequested) return;
    if (choice !== open) {
      this.cancelInWorker(attempt);
      return;
    }
    // Strict parsing; the first manual sign-in confirmed the OAuth query
    // reaches the browser intact.
    if (!(await vscode.env.openExternal(vscode.Uri.parse(url, true)))) {
      void vscode.window.showWarningMessage(`Couldn't open the browser. Open this address yourself: ${url}`);
    }
    this.codeBox(attempt, ended);
  }

  // The box for the code. After Enter it stays open, greyed out with VS
  // Code's progress bar, while the code is checked and then the new token;
  // it closes when the sign-in ends, and becomes editable again if the code
  // is rejected (D-054 as amended).
  private codeBox(attempt: number, ended: vscode.CancellationToken): void {
    const box = vscode.window.createInputBox();
    box.title = "Paste the code shown after you sign in";
    box.prompt = "From the page that opened in your browser";
    box.password = true;
    box.ignoreFocusOut = true;
    let working = false;
    const setWorking = (prompt: string) => {
      working = true;
      box.enabled = false;
      box.busy = true;
      box.prompt = prompt;
      box.validationMessage = undefined;
    };
    const askAgain = (prompt: string, problem: string) => {
      working = false;
      box.enabled = true;
      box.busy = false;
      box.value = "";
      box.prompt = prompt;
      box.validationMessage = problem;
    };
    const subscriptions: vscode.Disposable[] = [];
    let closed = false;
    // Disposing the box also fires onDidHide; `closed` keeps that from being
    // taken as the human closing it.
    const close = () => {
      if (closed) return;
      closed = true;
      for (const s of subscriptions) s.dispose();
      box.dispose();
    };
    subscriptions.push(
      ended.onCancellationRequested(close),
      box.onDidAccept(() => {
        if (working || box.value.trim() === "") return;
        const code = box.value;
        setWorking("Checking the code with Claude…");
        this.worker.request("auth/submitCode", { attempt, code }, SUBMIT_TIMEOUT_MS).then(
          (outcome) => {
            if (ended.isCancellationRequested) return;
            if (outcome === "accepted") setWorking("Code accepted. Checking the new token…");
            else if (outcome === "invalid") askAgain("Paste the code from the browser again.", "That code didn't work.");
            else askAgain("Paste it again, or get a new one from the browser.", "Claude didn't answer that code.");
          },
          (error: unknown) => {
            this.output.info(`code not accepted: ${message(error)}`);
            // If the sign-in itself ended, run() reports that and `ended`
            // closes the box. Otherwise say what went wrong and ask again.
            if (!ended.isCancellationRequested) askAgain("Paste the code again.", `That code couldn't be used: ${message(error)}.`);
          },
        );
      }),
      box.onDidHide(() => {
        if (closed) return;
        // Closed by the human (Escape) before the sign-in finished.
        if (!ended.isCancellationRequested) this.cancelInWorker(attempt);
        close();
      }),
    );
    if (ended.isCancellationRequested) close();
    else box.show();
  }

  private reportFailure(error: unknown): void {
    const code = error instanceof WorkerError ? error.code : undefined;
    if (code === "cancelled") return;
    this.output.error(`sign-in failed: ${message(error)}`);
    const retry = "Retry";
    const showLog = "Show log";
    const text =
      code === "docker-unavailable"
        ? "Docker isn't running, so Excaliharness can't sign in to Claude."
        : code === "timeout"
          ? "Sign-in timed out."
          : code === "token-rejected"
            ? "You signed in, but the new token didn't work. Try signing in again."
            : `Sign-in failed: ${message(error)}.`;
    void vscode.window.showErrorMessage(text, retry, showLog).then((choice) => {
      if (choice === retry) void this.signIn();
      else if (choice === showLog) this.output.show();
    });
  }

  private async refresh(): Promise<void> {
    this.signedIn = Boolean(await this.secrets.get(SECRET_KEY));
    // Shows "Sign Out of Claude" in the command palette only when it applies.
    void vscode.commands.executeCommand("setContext", "excaliharness.signedIn", this.signedIn);
    this.item.text = this.signedIn ? "$(check) Claude: signed in" : "$(key) Claude: sign in";
    this.item.tooltip = this.signedIn
      ? "Excaliharness is signed in to Claude. Click to sign in again or sign out."
      : "Sign in to Claude so Excaliharness can run agents.";
  }
}
