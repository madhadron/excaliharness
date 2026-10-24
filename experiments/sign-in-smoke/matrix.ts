// Throwaway (D-019 exception): which way of typing a long code makes the real
// CLI submit it? Uses a fake code; no token is created.
import { DockerClient } from "../../src/worker/docker";
import { stripAnsi, streamTerminal } from "../../src/worker/signIn";

const docker = new DockerClient("/var/run/docker.sock");
const IMAGE = process.argv[2] ?? "";
const CODE = `${"x".repeat(60)}#${"y".repeat(31)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function attempt(name: string, cmd: string[], send: (write: (s: string) => void) => Promise<void>) {
  const id = await docker.createContainer({ image: IMAGE, cmd, tty: true, role: "sign-in", noLogs: true, autoRemove: true });
  try {
    const { stream, head } = await docker.attach(id);
    const term = streamTerminal(stream, head);
    let raw = "";
    term.onData((c) => (raw += c));
    await docker.start(id);
    await docker.resize(id);
    for (let i = 0; i < 100 && !stripAnsi(raw).includes("Paste code here"); i++) await sleep(100);
    await sleep(2_000);
    const before = stripAnsi(raw).length;
    await send((s) => term.write(s));
    await sleep(8_000);
    const after = stripAnsi(raw).slice(before);
    const answered = /Invalid|OAuth error|error|failed|token/i.test(after);
    console.log(`${answered ? "ANSWERED" : "silent  "}  ${name}${answered ? `: ${(/(OAuth error[^\n]*|Invalid[^\n]*|[Ee]rror[^\n]*)/.exec(after)?.[1] ?? "").slice(0, 90)}` : ""}`);
    term.close();
  } finally {
    await docker.remove(id).catch(() => undefined);
  }
}

const withTimeout = ["timeout", "--foreground", "120", "claude", "setup-token"];
const plain = ["claude", "setup-token"];
const quiet = () => sleep(1_500);

(async () => {
  await attempt("timeout, code then Enter", withTimeout, async (w) => { w(CODE); await quiet(); w("\r"); });
  await attempt("plain, code+Enter in one write", plain, async (w) => { w(`${CODE}\r`); });
  await attempt("plain, code then Enter", plain, async (w) => { w(CODE); await quiet(); w("\r"); });
  await attempt("timeout, bracketed paste then Enter", withTimeout, async (w) => { w(`\x1b[200~${CODE}\x1b[201~`); await quiet(); w("\r"); });
  await attempt("timeout, typed in small pieces then Enter", withTimeout, async (w) => { for (let i = 0; i < CODE.length; i += 8) { w(CODE.slice(i, i + 8)); await sleep(30); } await quiet(); w("\r"); });
  await attempt("timeout, short code then Enter", withTimeout, async (w) => { w("not-a-real-code"); await quiet(); w("\r"); });
})();
