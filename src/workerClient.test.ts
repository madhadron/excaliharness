import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Notification } from "./worker/protocol";
import { WorkerClient } from "./workerClient";

let dir: string;
const clients: WorkerClient[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "client-"));
});

afterEach(() => {
  for (const c of clients.splice(0)) c.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

function script(name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
}

async function waitFor(check: () => boolean, ms = 5_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const policy = { baseDelayMs: 10, maxDelayMs: 40, crashLimit: 3, windowMs: 60_000 };

describe("WorkerClient", () => {
  it("restarts a crashing worker with backoff, then gives up, until restart()", async () => {
    const counter = path.join(dir, "starts");
    const crash = script("crash.cjs", `require("fs").appendFileSync(${JSON.stringify(counter)}, "x"); process.exit(3);`);
    let gaveUp = 0;
    let exits = 0;
    const client = new WorkerClient({
      workerPath: crash,
      root: dir,
      dockerfile: "unused",
      log: () => {},
      onNotification: () => {},
      onExit: () => exits++,
      onGiveUp: () => gaveUp++,
      restart: policy,
    });
    clients.push(client);
    await waitFor(() => gaveUp === 1);
    expect(fs.readFileSync(counter, "utf8")).toHaveLength(3);
    expect(exits).toBe(3);
    await expect(client.request("ping")).rejects.toThrow(/not running/);
    client.restart();
    await waitFor(() => gaveUp === 2);
    expect(fs.readFileSync(counter, "utf8")).toHaveLength(6);
  });

  it("delivers notifications in version order, dropping older ones, and answers requests", async () => {
    const worker = script(
      "worker.cjs",
      `const send = (m) => process.send(m);
       send({ method: "tasks/changed", params: { version: 2, readOnly: false, tasks: [] } });
       send({ method: "tasks/changed", params: { version: 1, readOnly: false, tasks: [] } });
       send({ method: "bogus" });
       process.on("message", (m) => send({ id: m.id, result: "pong" }));`,
    );
    const seen: Notification[] = [];
    const logs: string[] = [];
    const client = new WorkerClient({ workerPath: worker, root: dir, dockerfile: "unused", log: (l) => logs.push(l), onNotification: (n) => seen.push(n), restart: policy });
    clients.push(client);
    await expect(client.request("ping")).resolves.toBe("pong");
    await waitFor(() => logs.some((l) => l.includes("malformed")));
    expect(seen.map((n) => ("version" in n.params ? n.params.version : undefined))).toEqual([2]);
  });
});
