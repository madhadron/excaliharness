// Reading git state directly from the git directory, without running git.
import * as fs from "node:fs";
import * as path from "node:path";

// The repository's git directory. A `.git` file (a linked worktree) may
// only point into some repository's `.git/worktrees/`, so a crafted one can't
// send the worker probing arbitrary paths.
export function gitDir(root: string): string | undefined {
  const dotGit = path.join(root, ".git");
  try {
    const stat = fs.lstatSync(dotGit);
    if (stat.isDirectory()) return dotGit;
    if (!stat.isFile() || stat.size > 4096) return undefined;
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, "utf8"));
    if (!m?.[1]) return undefined;
    const target = path.resolve(root, m[1]);
    const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`;
    return target.includes(marker) ? target : undefined;
  } catch {
    return undefined;
  }
}

// The commit checked out, or undefined if it can't be told (no repo yet, an
// unborn branch). Branch refs are read loose or from packed-refs.
export function resolveHead(git: string): string | undefined {
  try {
    const head = fs.readFileSync(path.join(git, "HEAD"), "utf8").trim();
    const ref = /^ref:\s*(refs\/\S+)$/.exec(head)?.[1];
    if (!ref) return /^[0-9a-f]{40,64}$/.test(head) ? head : undefined;
    if (ref.split("/").includes("..")) return undefined;
    // Linked worktrees keep refs in the main repository's git directory.
    const common = fs.existsSync(path.join(git, "commondir"))
      ? path.resolve(git, fs.readFileSync(path.join(git, "commondir"), "utf8").trim())
      : git;
    for (const dir of [git, common]) {
      const loose = path.join(dir, ref);
      if (fs.existsSync(loose)) return fs.readFileSync(loose, "utf8").trim();
    }
    const packed = fs.readFileSync(path.join(common, "packed-refs"), "utf8");
    return packed.split("\n").find((line) => line.endsWith(` ${ref}`))?.split(" ")[0];
  } catch {
    return undefined;
  }
}
