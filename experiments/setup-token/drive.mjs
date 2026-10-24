// Experiment driver: runs `claude setup-token` in a container started through
// the Docker Engine API (no host terminal), relays the sign-in URL and code,
// captures the token, and checks it with `claude -p` in a fresh container.
// Throwaway code (D-019 exception). Node built-ins only.
//
// Usage (from the repo root):
//   docker compose -f experiments/setup-token/compose.yml run --rm driver --variant D
// Options:
//   --variant B|C|D   B: plain pipes, C: `script` pty inside the container,
//                     D: container created with Tty through the API
//   --bad-code        send a fake code when the URL appears (no token minted)
//   --timeout-ms N    never send a code; report what happened after N ms
//   --no-verify       skip the `claude -p` check

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { StringDecoder } from "node:string_decoder";

const SOCKET = "/var/run/docker.sock";
const IMAGE = "excaliharness-agent-base:experiment";
const COLS = 1000;
const ROWS = 50;
const OVERALL_DEADLINE_MS = 10 * 60 * 1000;

// ---------- arguments ----------

const args = process.argv.slice(2);
const opt = (name) => args.includes(name);
const val = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const variant = (val("--variant") ?? "D").toUpperCase();
if (!["B", "C", "D"].includes(variant)) {
  console.error(`Unknown variant ${variant}; use B, C or D.`);
  process.exit(2);
}
const badCode = opt("--bad-code");
const timeoutMs = val("--timeout-ms") ? Number(val("--timeout-ms")) : undefined;
const verify = !opt("--no-verify");
const tty = variant !== "B";
const ENTER = tty ? "\r" : "\n";

// ---------- Docker Engine API over the Unix socket ----------

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: SOCKET,
        path: urlPath,
        method,
        headers: body ? { "Content-Type": "application/json" } : {},
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          if (res.statusCode >= 300) {
            reject(new Error(`${method} ${urlPath}: ${res.statusCode} ${buf}`));
          } else {
            resolve(buf);
          }
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const api = async (method, urlPath, body) => {
  const buf = await request(method, urlPath, body);
  return buf.length ? JSON.parse(buf.toString("utf8")) : null;
};

function attach(id) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath: SOCKET,
      path: `/containers/${id}/attach?stream=1&stdin=1&stdout=1&stderr=1`,
      method: "POST",
      headers: { Connection: "Upgrade", Upgrade: "tcp" },
    });
    req.on("upgrade", (_res, socket, head) => resolve({ socket, head }));
    req.on("response", (res) => reject(new Error(`attach: HTTP ${res.statusCode}`)));
    req.on("error", reject);
    req.end();
  });
}

// Non-Tty containers multiplex stdout/stderr with 8-byte frame headers.
function demuxer(onData) {
  let pending = Buffer.alloc(0);
  return (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 8) {
      const size = pending.readUInt32BE(4);
      if (pending.length < 8 + size) break;
      onData(pending.subarray(8, 8 + size));
      pending = pending.subarray(8 + size);
    }
  };
}

const created = new Set();
async function removeAll() {
  for (const id of created) {
    await request("DELETE", `/containers/${id}?force=1`).catch(() => {});
  }
  created.clear();
}

// ---------- text handling and redaction ----------

function stripAnsi(s) {
  return s
    .replace(/\x1b\[(\d*)C/g, (_m, n) => " ".repeat(Number(n || 1))) // cursor-forward
    .replace(/\x1b\[\d*G/g, " ") // column jumps are how the CLI lays out words
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC (incl. hyperlinks)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "") // CSI
    .replace(/\x1b[@-Z\\-_]/g, "") // other two-byte escapes
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

const knownTokens = [];
function redact(s) {
  let out = s.replace(/sk-ant-[A-Za-z0-9_-]*/g, (m) => `${m.slice(0, 12)}…[redacted]`);
  if (knownTokens.length) {
    out = out.replace(/[A-Za-z0-9_-]{6,}/g, (run) =>
      knownTokens.some((t) => t.includes(run)) ? "[redacted-fragment]" : run,
    );
  }
  return out;
}

const TOKEN_RE = /sk-ant-oat01-[A-Za-z0-9_-]+/;
const URL_RE = /https:\/\/\S+/;

// ---------- the setup-token run ----------

function containerSpec() {
  const base = {
    Image: IMAGE,
    Env: ["TERM=xterm-256color", `COLUMNS=${COLS}`, `LINES=${ROWS}`],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    OpenStdin: true,
    StdinOnce: false,
    Tty: tty,
    HostConfig: { ConsoleSize: [ROWS, COLS] },
  };
  if (variant === "C") {
    base.Cmd = [
      "script",
      "-qfec",
      `stty cols ${COLS} rows ${ROWS}; claude setup-token`,
      "/dev/null",
    ];
  } else {
    base.Cmd = ["claude", "setup-token"];
  }
  return base;
}

async function runSetupToken() {
  const { Id: id } = await api("POST", "/containers/create", containerSpec());
  created.add(id);
  const { socket, head } = await attach(id);

  const decoder = new StringDecoder("utf8");
  let raw = "";
  const rawChunks = [];
  let printed = 0;
  let lastData = Date.now();
  let urlSeen = null;

  const onBytes = (b) => {
    const text = decoder.write(b);
    raw += text;
    rawChunks.push(text);
    lastData = Date.now();
  };
  const feed = tty ? onBytes : demuxer(onBytes);
  if (head?.length) feed(head);
  socket.on("data", feed);

  const send = (s) => socket.write(s);

  // Live view for you: stripped, redacted text, flushed by line or when idle.
  const flush = (force) => {
    const shown = redact(stripAnsi(raw));
    let upto = force ? shown.length : shown.lastIndexOf("\n") + 1;
    if (upto > printed) {
      process.stdout.write(shown.slice(printed, upto));
      printed = upto;
    }
  };
  const ticker = setInterval(() => {
    flush(Date.now() - lastData > 700);
    if (!urlSeen) {
      const m = stripAnsi(raw).match(URL_RE);
      if (m) {
        urlSeen = m[0];
        process.stdout.write(
          `\n\n===== Sign-in URL detected =====\n${urlSeen}\n` +
            (badCode
              ? "(--bad-code: sending a fake code shortly)\n"
              : timeoutMs
                ? `(--timeout-ms: not sending a code; waiting ${timeoutMs} ms)\n`
                : "Open it in your browser, sign in, then type the code here and press Return.\n") +
            "================================\n\n",
        );
        if (badCode) setTimeout(() => send(`not-a-real-code${ENTER}`), Number(val("--code-delay-ms") ?? 2000));
      }
    }
  }, 250);

  // Forward your lines to the CLI. `:enter`, `:up`, `:down`, `:esc`,
  // `:ctrl-c` send keys; anything else is sent followed by Enter.
  let rl;
  if (!badCode && !timeoutMs) {
    rl = readline.createInterface({ input: process.stdin });
    const keys = { ":enter": ENTER, ":up": "\x1b[A", ":down": "\x1b[B", ":esc": "\x1b", ":ctrl-c": "\x03" };
    rl.on("line", (line) => send(keys[line.trim()] ?? `${line.trim()}${ENTER}`));
  }

  await api("POST", `/containers/${id}/start`);
  if (tty) await request("POST", `/containers/${id}/resize?h=${ROWS}&w=${COLS}`).catch(() => {});

  const waitExit = api("POST", `/containers/${id}/wait`).then((r) => r.StatusCode);
  const deadline = timeoutMs ?? OVERALL_DEADLINE_MS;
  const outcome = await Promise.race([
    waitExit.then((code) => ({ exited: true, code })),
    new Promise((r) => setTimeout(() => r({ exited: false }), deadline)),
  ]);

  clearInterval(ticker);
  rl?.close();
  socket.destroy();
  raw += decoder.end();

  const stripped = stripAnsi(raw);
  const plain = stripped.match(TOKEN_RE)?.[0] ?? null;
  const joined = stripped.replace(/\n/g, "").match(TOKEN_RE)?.[0] ?? null;
  for (const t of [plain, joined]) if (t) knownTokens.push(t);
  flush(true);
  process.stdout.write("\n");

  return { outcome, urlSeen: Boolean(urlSeen), plain, joined, stripped, rawChunks };
}

// ---------- verification ----------

async function verifyToken(token) {
  const { Id: id } = await api("POST", "/containers/create", {
    Image: IMAGE,
    Env: [`CLAUDE_CODE_OAUTH_TOKEN=${token}`],
    Cmd: ["claude", "-p", "Reply with exactly: ok"],
    Tty: false,
  });
  created.add(id);
  await api("POST", `/containers/${id}/start`);
  const code = await Promise.race([
    api("POST", `/containers/${id}/wait`).then((r) => r.StatusCode),
    new Promise((r) => setTimeout(() => r("timeout"), 120_000)),
  ]);
  const logs = await request("GET", `/containers/${id}/logs?stdout=1&stderr=1`);
  let out = "";
  demuxer((b) => (out += b.toString("utf8")))(logs);
  return { code, output: redact(out.trim()) };
}

// ---------- main ----------

async function main() {
  console.log(
    `Variant ${variant} (${tty ? "Tty" : "no Tty"}${variant === "C" ? ", script pty inside" : ""})` +
      `${badCode ? ", bad code" : ""}${timeoutMs ? `, timeout ${timeoutMs} ms` : ""}\n`,
  );
  const run = await runSetupToken();

  const report = {
    variant,
    mode: badCode ? "bad-code" : timeoutMs ? `timeout-${timeoutMs}` : "normal",
    exited: run.outcome.exited,
    exitCode: run.outcome.exited ? run.outcome.code : null,
    urlSeen: run.urlSeen,
    tokenFound: Boolean(run.plain || run.joined),
    tokenLength: (run.plain ?? run.joined)?.length ?? null,
    wrapSuspected: Boolean(run.plain && run.joined && run.plain !== run.joined) || (!run.plain && Boolean(run.joined)),
    verify: null,
  };

  if (verify && report.tokenFound) {
    const candidates = [run.plain, run.joined].filter((t, i, a) => t && a.indexOf(t) === i);
    for (const [i, t] of candidates.entries()) {
      const r = await verifyToken(t);
      report.verify = { candidate: i === 0 && run.plain ? "as printed" : "lines joined", ...r };
      if (r.code === 0) break;
    }
  }
  knownTokens.length && (run.plain = run.joined = null); // drop references

  const dir = path.join(path.dirname(new URL(import.meta.url).pathname), "runs");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${variant}-${report.mode}.txt`);
  fs.writeFileSync(
    file,
    `${JSON.stringify(report, null, 2)}\n\n===== stripped output (redacted) =====\n${redact(run.stripped)}\n` +
      `\n===== raw chunks with escapes (redacted, JSON-escaped) =====\n` +
      run.rawChunks.map((c) => JSON.stringify(redact(c))).join("\n") +
      "\n",
  );

  console.log("\n===== Result =====");
  console.log(JSON.stringify(report, null, 2));
  console.log(`Transcript: experiments/setup-token/runs/${path.basename(file)}`);
}

const cleanup = async () => {
  await removeAll();
};
process.on("SIGINT", async () => {
  await cleanup();
  process.exit(130);
});
main()
  .catch((e) => {
    console.error(`Driver error: ${e.message}`);
    process.exitCode = 1;
  })
  .finally(cleanup);
