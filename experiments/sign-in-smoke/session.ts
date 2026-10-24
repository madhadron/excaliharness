// Throwaway (D-019 exception): the real SignInSession against the real CLI,
// with timing, to compare with matrix.ts. Fake code; no token is created.
import { DockerClient } from "../../src/worker/docker";
import { SignInSession, streamTerminal, type Terminal } from "../../src/worker/signIn";

const docker = new DockerClient("/var/run/docker.sock");
const CODE = `${"x".repeat(60)}#${"y".repeat(31)}`;
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`;

(async () => {
  const id = await docker.createContainer({ image: process.argv[2] ?? "", cmd: ["timeout", "--foreground", "120", "claude", "setup-token"], tty: true, role: "sign-in", noLogs: true, autoRemove: true });
  try {
    const { stream, head } = await docker.attach(id);
    const inner = streamTerminal(stream, head);
    const term: Terminal = {
      onData: (l) => inner.onData((c) => { console.log(`${at()} data ${c.length} bytes: ${JSON.stringify(c.slice(0, 60))}`); l(c); }),
      onEnd: (l) => inner.onEnd(l),
      write: (s) => { console.log(`${at()} WRITE ${JSON.stringify(s.length > 20 ? `${s.slice(0, 10)}…(${s.length})` : s)}`); inner.write(s); },
      close: () => inner.close(),
    };
    const session = new SignInSession(term, { onUrl: () => console.log(`${at()} url`), log: (l) => console.log(`${at()} log ${l}`), answerTimeoutMs: 12_000 });
    await docker.start(id);
    await docker.resize(id);
    console.log(`${at()} outcome ${await session.submit(CODE)}`);
    session.cancel();
  } finally {
    await docker.remove(id).catch(() => undefined);
  }
})();
