import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashOf, MAX_FILE_BYTES, readFile, removeLeftoverTempFiles, Store, TEMP_PREFIX } from "./store";

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "store-"));
  file = path.join(dir, "T-1.md");
  fs.writeFileSync(file, "one\n");
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const leftovers = () => fs.readdirSync(dir).filter((n) => n.startsWith(TEMP_PREFIX));

describe("Store.update", () => {
  it("writes the edited text atomically and remembers it", () => {
    const store = new Store();
    expect(store.update(file, (t) => t.replace("one", "two"))).toEqual({ status: "written" });
    expect(fs.readFileSync(file, "utf8")).toBe("two\n");
    expect(leftovers()).toEqual([]);
  });

  it("doesn't write when the edit changes nothing or declines", () => {
    const store = new Store();
    const before = fs.statSync(file).mtimeMs;
    expect(store.update(file, (t) => t)).toEqual({ status: "unchanged" });
    expect(store.update(file, () => undefined)).toEqual({ status: "unchanged" });
    expect(fs.statSync(file).mtimeMs).toBe(before);
  });

  it("recomputes the edit when the file changed between reading and writing", () => {
    const store = new Store();
    let calls = 0;
    const result = store.update(file, (text) => {
      calls++;
      // Someone saves while the first edit is being computed.
      if (calls === 1) fs.writeFileSync(file, "theirs\n");
      return `${text.trim()} + mine\n`;
    });
    expect(result).toEqual({ status: "written" });
    expect(calls).toBe(2);
    expect(fs.readFileSync(file, "utf8")).toBe("theirs + mine\n");
  });

  it("keeps a save that lands in place between the temp write and the rename", () => {
    let saved = false;
    const store = new Store({
      beforeRename: (f) => {
        if (saved) return;
        saved = true;
        fs.writeFileSync(f, "saved in place\n"); // Writes to the old inode.
      },
    });
    const result = store.update(file, (text) => `${text.trim()} + mine\n`);
    expect(result).toEqual({ status: "written" });
    expect(fs.readFileSync(file, "utf8")).toBe("saved in place + mine\n");
    expect(leftovers()).toEqual([]);
  });

  it("gives up after repeated conflicts and says why", () => {
    const store = new Store();
    let n = 0;
    const result = store.update(file, (text) => {
      fs.writeFileSync(file, `change ${n++}\n`);
      return `${text}!`;
    });
    expect(result).toMatchObject({ status: "failed", reason: expect.stringMatching(/kept changing/) as unknown });
  });

  it("keeps the file's read/write permissions but never setuid or execute bits", () => {
    fs.chmodSync(file, 0o600);
    new Store().update(file, () => "two\n");
    expect(fs.statSync(file).mode & 0o7777).toBe(0o600);
    fs.chmodSync(file, 0o4755);
    new Store().update(file, () => "three\n");
    expect(fs.statSync(file).mode & 0o7777).toBe(0o644);
  });

  it("reports a missing file", () => {
    expect(new Store().update(path.join(dir, "nope.md"), () => "x")).toEqual({ status: "failed", reason: "the file is missing" });
  });
});

describe("helpers", () => {
  it("readFile reports a missing file and hashes raw bytes", () => {
    expect(readFile(path.join(dir, "nope"))).toEqual({ status: "missing" });
    expect(readFile(file)).toEqual({ status: "ok", content: { text: "one\n", hash: hashOf(Buffer.from("one\n")) } });
  });

  it("readFile refuses symlinks, directories and oversized files", () => {
    fs.symlinkSync(file, path.join(dir, "link.md"));
    fs.mkdirSync(path.join(dir, "T-2.md"));
    fs.writeFileSync(path.join(dir, "big.md"), Buffer.alloc(MAX_FILE_BYTES + 1));
    expect(readFile(path.join(dir, "link.md"))).toMatchObject({ status: "unusable", reason: expect.stringMatching(/symbolic link/) as unknown });
    expect(readFile(path.join(dir, "T-2.md"))).toMatchObject({ status: "unusable" });
    expect(readFile(path.join(dir, "big.md"))).toMatchObject({ status: "unusable", reason: expect.stringMatching(/larger/) as unknown });
  });

  it("update never writes through a symlink", () => {
    const link = path.join(dir, "link.md");
    fs.symlinkSync(file, link);
    expect(new Store().update(link, () => "changed\n")).toMatchObject({ status: "failed" });
    expect(fs.readFileSync(file, "utf8")).toBe("one\n");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it("detects a save by rename landing just before ours", () => {
    let replaced = false;
    const store = new Store({
      beforeRename: (f) => {
        if (replaced) return;
        replaced = true;
        fs.writeFileSync(`${f}.x`, "renamed in\n");
        fs.renameSync(`${f}.x`, f);
      },
    });
    expect(store.update(file, (text) => `${text.trim()} + mine\n`)).toEqual({ status: "written" });
    expect(fs.readFileSync(file, "utf8")).toBe("renamed in + mine\n");
  });

  it("returns a failure instead of throwing when the directory is read-only", () => {
    if (process.getuid?.() === 0) return; // Root ignores permissions.
    fs.chmodSync(dir, 0o555);
    try {
      expect(new Store().update(file, () => "two\n")).toMatchObject({ status: "failed" });
    } finally {
      fs.chmodSync(dir, 0o755);
    }
  });

  it("removes temp files a crash left behind, and nothing else", () => {
    fs.writeFileSync(path.join(dir, `${TEMP_PREFIX}abc.tmp`), "partial");
    removeLeftoverTempFiles(dir);
    expect(fs.readdirSync(dir)).toEqual(["T-1.md"]);
  });
});
