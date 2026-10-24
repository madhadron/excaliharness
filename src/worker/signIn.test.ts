import { Duplex } from "node:stream";
import { describe, expect, it } from "vitest";
import type { BaseImage } from "./agentImage";
import type { DockerClient } from "./docker";
import type { Notification } from "./protocol";
import { SignInError, SignInService, SignInSession, signInUrl, stripAnsi, type Terminal } from "./signIn";

const TOKEN = `sk-ant-oat01-${"x".repeat(95)}`;
const URL = "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz";
// Shaped like the real CLI output from E-001: words placed with column jumps.
const INTRO = `\x1b[2GThis\x1b[7Gwill\x1b[12Gguide\x1b[18Gyou\r\r\n\x1b]8;id=1;${URL}\x07${URL}\x1b]8;;\x07\r\r\n\x1b[2GPaste\x1b[8Gcode\x1b[13Ghere\x1b[18Gif\x1b[21Gprompted\x1b[30G>\r\r\n`;
const INVALID = "\x1b[2GOAuth error: Invalid code. Please make sure the full code was copied\r\n Press Enter to retry.\r\n";
// What the CLI prints when the server rejects a well-formed code (E-004).
const SERVER_REJECTED = "\x1b[38;5;211mOAuth error: Request failed with status code 400\r\n Press Enter to retry.\r\n";
const SUCCESS = `\x1b[2G✓ Long-lived authentication token created successfully!\r\n Your OAuth token (valid for 1 year):\r\n ${TOKEN}\r\n`;

class FakeTerminal implements Terminal {
  written: string[] = [];
  closed = false;
  private data: ((chunk: string) => void)[] = [];
  private end: (() => void)[] = [];
  onData(listener: (chunk: string) => void): void {
    this.data.push(listener);
  }
  onEnd(listener: () => void): void {
    this.end.push(listener);
  }
  write(text: string): void {
    this.written.push(text);
    // The CLI echoes a typed code as asterisks.
    if (text !== "\r") setTimeout(() => this.emit("*".repeat(text.length)), 1);
  }
  close(): void {
    this.closed = true;
  }
  emit(chunk: string): void {
    for (const l of this.data) l(chunk);
  }
  finish(): void {
    for (const l of this.end) l();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await sleep(5);
  }
}

function session(terminal: FakeTerminal, extra: { deadlineMs?: number; quietMs?: number; answerTimeoutMs?: number } = {}) {
  const urls: string[] = [];
  const logs: string[] = [];
  const s = new SignInSession(terminal, { onUrl: (u) => urls.push(u), log: (l) => logs.push(l), quietMs: 30, pollMs: 5, ...extra });
  return { s, urls, logs };
}

describe("output handling", () => {
  it("turns column jumps into spaces and drops other escapes", () => {
    expect(stripAnsi("\x1b[2GPaste\x1b[8Gcode\x1b[1m!\x1b[22m\r\n")).toBe(" Paste code!\n");
  });

  it("offers only the https sign-in page on Claude's own sites", () => {
    expect(signInUrl(`see ${URL} now`)).toBe(URL);
    expect(signInUrl("https://claude.ai/oauth/authorize?x=1 ")).toBe("https://claude.ai/oauth/authorize?x=1");
    expect(signInUrl("https://claude.com/help ")).toBeUndefined();
    expect(signInUrl("https://support.claude.com/oauth/authorize ")).toBeUndefined();
    expect(signInUrl("http://claude.com/oauth/authorize ")).toBeUndefined();
    expect(signInUrl("https://claude.com.evil.example/oauth/authorize ")).toBeUndefined();
    expect(signInUrl("https://user@claude.com/oauth/authorize ")).toBeUndefined();
    expect(signInUrl("https://evil.example/claude.com/oauth/authorize ")).toBeUndefined();
  });

  it("waits for the whole URL before taking it", () => {
    expect(signInUrl("https://claude.com/cai/oauth/authorize?code=true&cli")).toBeUndefined();
  });
});

describe("SignInSession", () => {
  it("shows the URL, waits for quiet before typing the code, and returns the token", async () => {
    const terminal = new FakeTerminal();
    const { s, urls, logs } = session(terminal, { quietMs: 300 });
    terminal.emit(INTRO);
    const shownAt = Date.now();
    expect(urls).toEqual([URL]);
    const submitted = s.submit(" the-code#state ");
    await until(() => terminal.written.length > 0);
    expect(Date.now() - shownAt).toBeGreaterThanOrEqual(290); // Not before the output went quiet.
    await until(() => terminal.written.length === 2);
    // Enter is a separate write, after the echo has gone quiet (E-004).
    expect(terminal.written).toEqual(["the-code#state", "\r"]);
    terminal.emit(SUCCESS);
    await expect(submitted).resolves.toBe("accepted");
    await expect(s.result).resolves.toBe(TOKEN);
    expect(terminal.closed).toBe(true);
    expect(logs.join("\n")).not.toContain("sk-ant");
  });

  it("presses Enter after a wrong code and reports it, then accepts the next one", async () => {
    const terminal = new FakeTerminal();
    const { s } = session(terminal);
    terminal.emit(INTRO);
    const first = s.submit("wrong");
    await until(() => terminal.written.length === 2);
    terminal.emit(INVALID);
    await until(() => terminal.written.length === 3);
    expect(terminal.written).toEqual(["wrong", "\r", "\r"]);
    terminal.emit(INTRO); // The CLI shows a fresh prompt.
    await expect(first).resolves.toBe("invalid");
    const second = s.submit("right");
    await until(() => terminal.written.length === 5);
    terminal.emit(SUCCESS);
    await expect(second).resolves.toBe("accepted");
    await expect(s.result).resolves.toBe(TOKEN);
  });

  it("takes a URL and a token only once each has fully arrived", async () => {
    const terminal = new FakeTerminal();
    const { s, urls } = session(terminal);
    terminal.emit(INTRO.slice(0, INTRO.indexOf("state=") + 3));
    expect(urls).toEqual([]);
    terminal.emit(INTRO.slice(INTRO.indexOf("state=") + 3));
    expect(urls).toEqual([URL]);
    const submitted = s.submit("code");
    await until(() => terminal.written.length === 2);
    terminal.emit(SUCCESS.slice(0, SUCCESS.indexOf(TOKEN) + 50));
    terminal.emit(SUCCESS.slice(SUCCESS.indexOf(TOKEN) + 50));
    await expect(submitted).resolves.toBe("accepted");
    await expect(s.result).resolves.toBe(TOKEN);
  });

  it("treats a server rejection like an invalid code", async () => {
    const terminal = new FakeTerminal();
    const { s } = session(terminal);
    terminal.emit(INTRO);
    const submitted = s.submit("x#y");
    await until(() => terminal.written.length === 2);
    terminal.emit(SERVER_REJECTED);
    await until(() => terminal.written.length === 3);
    terminal.emit(INTRO);
    await expect(submitted).resolves.toBe("invalid");
    s.cancel();
  });

  it("reports no response when the CLI says nothing about a code, and stays usable", async () => {
    const terminal = new FakeTerminal();
    const { s } = session(terminal, { answerTimeoutMs: 100 });
    terminal.emit(INTRO);
    await expect(s.submit("code")).resolves.toBe("no-response");
    const again = s.submit("code");
    await until(() => terminal.written.length === 4);
    terminal.emit(SUCCESS);
    await expect(again).resolves.toBe("accepted");
  });

  it.each(["", "a\nb", "a\x1bb", "a b", "a\u009bb"])("refuses %j as a code", async (code) => {
    const { s } = session(new FakeTerminal());
    await expect(s.submit(code)).rejects.toThrow(/doesn't look like/);
    s.cancel();
  });

  it("times out, closing the terminal and failing a pending submit", async () => {
    const terminal = new FakeTerminal();
    const { s } = session(terminal, { deadlineMs: 50 });
    const pending = s.submit("code"); // No prompt ever shows.
    await expect(s.result).rejects.toMatchObject({ code: "timeout" });
    await expect(pending).rejects.toBeInstanceOf(SignInError);
    expect(terminal.closed).toBe(true);
  });

  it("fails when the CLI exits without a token, and on cancel", async () => {
    const ended = new FakeTerminal();
    const a = session(ended).s;
    ended.finish();
    await expect(a.result).rejects.toMatchObject({ code: "ended" });
    const b = session(new FakeTerminal()).s;
    b.cancel();
    await expect(b.result).rejects.toMatchObject({ code: "cancelled" });
  });
});

describe("SignInService", () => {
  const IMAGE = `sha256:${"a".repeat(64)}`;

  // A fake Docker in which the sign-in container prints the CLI's output and,
  // once a code is typed, the token; the check container prints `checkOutput`.
  function fakeDocker(checkOutput: string, checkExit = 0) {
    const removed: string[] = [];
    const created: { cmd: string[]; env?: string[] }[] = [];
    const docker = {
      ping: () => Promise.resolve(),
      containersWithRole: (role: string) => Promise.resolve(role === "sign-in" ? ["leftover"] : []),
      createContainer: (spec: { cmd: string[]; env?: string[] }) => {
        created.push(spec);
        return Promise.resolve(spec.cmd.includes("setup-token") ? "signin" : "check");
      },
      attach: () => {
        // The container's terminal: typing a code followed by Enter prints
        // the token.
        const terminal: Duplex = new Duplex({
          read() {},
          write(chunk: Buffer, _encoding, done) {
            const text = chunk.toString();
            // Like the real CLI, a lone Enter submits; one inside a longer
            // chunk is taken as part of a paste and does nothing (E-004).
            if (text === "\r") setTimeout(() => terminal.push(SUCCESS), 5);
            else setTimeout(() => terminal.push("*".repeat(text.length)), 1);
            done();
          },
        });
        return Promise.resolve({ stream: terminal, head: Buffer.from(INTRO) });
      },
      start: () => Promise.resolve(),
      resize: () => Promise.resolve(),
      wait: () => Promise.resolve(checkExit),
      logs: () => Promise.resolve(checkOutput),
      remove: (id: string) => {
        removed.push(id);
        return Promise.resolve();
      },
    };
    return { docker: docker as unknown as DockerClient, removed, created };
  }

  const image = { ensure: () => Promise.resolve(IMAGE) } as unknown as BaseImage;

  const promptOf = (notes: Notification[]) => {
    const prompt = notes.find((n) => n.method === "auth/prompt");
    return prompt?.method === "auth/prompt" ? prompt.params : undefined;
  };

  async function run(checkOutput: string, checkExit = 0) {
    const fake = fakeDocker(checkOutput, checkExit);
    const notes: Notification[] = [];
    const logs: string[] = [];
    const service = new SignInService({ docker: fake.docker, image, notify: (n) => notes.push(n), log: (l) => logs.push(l), quietMs: 20 });
    const result = service.signIn();
    await until(() => promptOf(notes) !== undefined);
    const attempt = promptOf(notes)?.attempt ?? -1;
    await expect(service.submitCode(attempt + 1, "code#state")).rejects.toThrow(/no sign-in/); // A stale prompt's attempt.
    await expect(service.submitCode(attempt, "code#state")).resolves.toBe("accepted");
    return { result, fake, notes, logs };
  }

  it("signs in, checks the token in a fresh container, and removes both containers", async () => {
    const { result, fake, notes, logs } = await run("ok\n");
    await expect(result).resolves.toEqual({ token: TOKEN });
    expect(fake.removed.sort()).toEqual(["check", "leftover", "signin"]);
    expect(fake.created[1]?.env).toEqual([`CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}`]);
    expect(notes.map((n) => (n.method === "progress" ? n.params.message : n.method))).toEqual([
      "Preparing the agent image…",
      "Waiting for you to sign in…",
      "auth/prompt",
      "Checking the token…",
    ]);
    expect(logs.join("\n")).not.toContain("sk-ant");
  });

  it("reports a token the check rejects, without logging the token", async () => {
    const { result, fake, logs } = await run(`401 OAuth access token is invalid: ${TOKEN}\n`, 1);
    await expect(result).rejects.toMatchObject({ code: "token-rejected" });
    expect(fake.removed.sort()).toEqual(["check", "leftover", "signin"]);
    expect(logs.join("\n")).not.toContain(TOKEN);
  });

  it.each([
    ["exit 0 without ok", "something else\n", 0],
    ["ok but a failing exit", "ok\n", 1],
  ])("rejects a check with %s", async (_name, output, exit) => {
    const { result } = await run(output, exit);
    await expect(result).rejects.toMatchObject({ code: "token-rejected" });
  });

  it("allows only one sign-in at a time, and cancel works before the prompt", async () => {
    const service = new SignInService({ docker: fakeDocker("ok").docker, image, notify: () => {}, log: () => {}, quietMs: 20 });
    const first = service.signIn();
    first.catch(() => {}); // Asserted below; avoid an "unhandled" report meanwhile.
    await expect(service.signIn()).rejects.toThrow(/already in progress/);
    service.cancel();
    await expect(first).rejects.toMatchObject({ code: "cancelled" });
  });

  it("cancels during the image build without ever prompting", async () => {
    const notes: Notification[] = [];
    const slowImage = { ensure: () => new Promise<string>(() => {}) } as unknown as BaseImage;
    const service = new SignInService({ docker: fakeDocker("ok").docker, image: slowImage, notify: (n) => notes.push(n), log: () => {} });
    const attempt = service.signIn();
    attempt.catch(() => {});
    await sleep(20);
    service.cancel(999); // Another attempt's cancel is ignored.
    await sleep(20);
    expect(service.isRunning).toBe(true);
    service.cancel();
    await expect(attempt).rejects.toMatchObject({ code: "cancelled" });
    expect(notes.some((n) => n.method === "auth/prompt")).toBe(false);
    expect(service.isRunning).toBe(false);
  });

  it("removes its containers on shutdown", async () => {
    const fake = fakeDocker("ok");
    const notes: Notification[] = [];
    const service = new SignInService({ docker: fake.docker, image, notify: (n) => notes.push(n), log: () => {}, quietMs: 20 });
    const attempt = service.signIn();
    attempt.catch(() => {});
    await until(() => promptOf(notes) !== undefined);
    await service.shutdown();
    expect(fake.removed).toContain("signin");
    await expect(attempt).rejects.toMatchObject({ code: "cancelled" });
  });
});
