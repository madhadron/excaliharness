import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TEMP_PREFIX } from "./store";
import { TaskWatcher } from "./watch";

let root: string;
let watcher: TaskWatcher | undefined;
let changes = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => boolean, ms = 3_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out");
    await sleep(20);
  }
}

// Replaces a file the way the store and many editors do.
function atomicWrite(file: string, text: string) {
  const tmp = path.join(path.dirname(file), `${TEMP_PREFIX}x.tmp`);
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "watch-"));
  fs.mkdirSync(path.join(root, "tasks"));
  fs.writeFileSync(path.join(root, "TASKS.md"), "# Tasks\n");
  changes = 0;
  watcher = new TaskWatcher(
    root,
    { onChange: () => changes++, onError: () => {} },
    { debounceMs: 30, maxWaitMs: 100, rescanMs: 60_000, rearmMs: 30 },
  );
});

afterEach(() => {
  watcher?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("TaskWatcher", () => {
  it("keeps seeing TASKS.md after it is replaced by a rename", async () => {
    watcher?.start();
    for (let i = 1; i <= 3; i++) {
      const before = changes;
      atomicWrite(path.join(root, "TASKS.md"), `# Tasks ${i}\n`);
      await waitFor(() => changes > before);
    }
  });

  it("keeps seeing task files after tasks/ is deleted and recreated", async () => {
    watcher?.start();
    fs.rmSync(path.join(root, "tasks"), { recursive: true });
    fs.mkdirSync(path.join(root, "tasks"));
    await sleep(150);
    const before = changes;
    fs.writeFileSync(path.join(root, "tasks", "T-1.md"), "# T-1: x\n");
    await waitFor(() => changes > before);
  });

  it("notices tasks/ being created after start", async () => {
    fs.rmSync(path.join(root, "tasks"), { recursive: true });
    watcher?.start();
    fs.mkdirSync(path.join(root, "tasks"));
    await sleep(150);
    const before = changes;
    fs.writeFileSync(path.join(root, "tasks", "T-1.md"), "# T-1: x\n");
    await waitFor(() => changes > before);
  });

  it("debounces a burst into one change", async () => {
    watcher?.start();
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(root, "tasks", "T-1.md"), `${i}\n`);
    await waitFor(() => changes > 0);
    await sleep(150);
    expect(changes).toBe(1);
  });
});
