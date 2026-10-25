// Task worktrees and commits (D-069, D-075, D-079). Git runs on the host only,
// never in a container, and never runs anything an agent could have planted:
// hooks, fsmonitor, signing programs, system or global config, and the
// worktree's own `.git` file are all left out. Every call names the git
// directory and work tree itself, found from the main repository.
import * as fs from "node:fs";
import * as path from "node:path";
import { READ_ONLY_PATHS } from "./compose";
import { printableLine } from "./clean";
import { TaskBlocked } from "./errors";
import { tail, type Run } from "./exec";

const SAFE_CONFIG = [
  "core.hooksPath=/dev/null",
  "core.fsmonitor=false",
  "core.untrackedCache=false",
  "core.attributesFile=/dev/null",
  "commit.gpgSign=false",
  "tag.gpgSign=false",
  "core.sshCommand=false",
  "credential.helper=",
  // Never look inside nested repositories, whose own config could name
  // programs to run (D-079).
  "diff.ignoreSubmodules=all",
  "status.submoduleSummary=false",
  "submodule.recurse=false",
  "protocol.file.allow=never",
].flatMap((c) => ["-c", c]);


const SAFE_ENV: NodeJS.ProcessEnv = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  // Paths given to git are names, never pathspec magic like ":!x".
  GIT_LITERAL_PATHSPECS: "1",
};

const MAX_DIFF_CHARS = 60_000;

// `.git` entries below the worktree's root: a nested repository the agent
// made. Host git would read its config (and run filters it names), so a
// worktree that has one isn't touched (D-079). Symbolic links aren't followed.
// Names compare case-insensitively: macOS disks are, so `.GIT` is `.git`
// there. A folder that can't be read is an error: it might hide one.
const MAX_SCAN = 2_000_000;

export function nestedRepositories(worktree: string): string[] {
  const found: string[] = [];
  let seen = 0;
  const walk = (dir: string, rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return;
      throw new TaskBlocked(`${rel || "the worktree"} can't be read, so it can't be checked for nested repositories: ${(error as Error).message}`);
    }
    seen += entries.length;
    if (seen > MAX_SCAN) throw new TaskBlocked(`the worktree has more than ${MAX_SCAN} files, too many to check for nested repositories`);
    for (const entry of entries) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.name.toLowerCase() === ".git") {
        if (rel) found.push(child);
        continue;
      }
      if (entry.isDirectory()) walk(path.join(dir, entry.name), child);
    }
  };
  walk(worktree, "");
  return found;
}

// Paths compared after resolving symlinks (macOS's /var is /private/var).
const real = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

export interface CommitResult {
  committed: boolean;
  // Changes under the read-only paths (D-068), left out of the commit.
  refused: string[];
}

export class Worktrees {
  private commonDir: string | undefined;

  constructor(
    private readonly run: Run,
    private readonly root: string,
    // Where worktrees live: the extension's storage, outside the repository.
    private readonly dir: string,
    private readonly log?: (line: string) => void,
  ) {}

  path(taskId: string): string {
    return path.join(this.dir, taskId);
  }

  branch(taskId: string): string {
    return `task/${taskId}`;
  }

  private env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
    return { ...env, ...SAFE_ENV, ...extra };
  }

  private async exec(args: string[], cwd: string, extra?: NodeJS.ProcessEnv) {
    return this.run("git", [...SAFE_CONFIG, ...args], { cwd, env: this.env(extra), timeoutMs: 5 * 60_000 });
  }

  private async git(args: string[], cwd: string, what: string, extra?: NodeJS.ProcessEnv): Promise<string> {
    const result = await this.exec(args, cwd, extra);
    if (result.code !== 0) throw new Error(`git ${what} failed:\n${tail(result)}`);
    return result.stdout.trim();
  }

  // The main repository's git directory, from the main checkout (trusted).
  private async common(): Promise<string> {
    this.commonDir ??= path.resolve(this.root, await this.git(["rev-parse", "--git-common-dir"], this.root, "rev-parse"));
    return this.commonDir;
  }

  // The worktree's administrative directory in the main repository: the one
  // whose `gitdir` file points at the worktree. Never read from the worktree.
  private async adminDir(taskId: string): Promise<string | undefined> {
    const base = path.join(await this.common(), "worktrees");
    const expected = real(path.join(this.path(taskId), ".git"));
    let names: string[];
    try {
      names = fs.readdirSync(base);
    } catch {
      return undefined;
    }
    for (const name of names) {
      try {
        // A relative gitdir is relative to the admin directory.
        const gitdir = path.resolve(base, name, fs.readFileSync(path.join(base, name, "gitdir"), "utf8").trim());
        if (real(gitdir) === expected) return path.join(base, name);
      } catch {
        // Not a worktree entry.
      }
    }
    return undefined;
  }



  private async worktreeEnv(taskId: string): Promise<NodeJS.ProcessEnv> {
    const nested = nestedRepositories(this.path(taskId));
    if (nested.length) {
      throw new TaskBlocked(`the agent created a git repository inside ${taskId}'s worktree (${nested.slice(0, 5).map(printableLine).join(", ")}); git won't run there until it is removed`);
    }
    const admin = await this.adminDir(taskId);
    if (!admin) throw new Error(`${taskId}'s worktree isn't registered in the repository`);
    this.repairGitFile(taskId, admin);
    return { GIT_DIR: admin, GIT_WORK_TREE: this.path(taskId) };
  }

  // Puts back the worktree's `.git` file as git wrote it. The agent can't
  // write /workspace/.git, but on a case-insensitive disk it can reach the
  // file as `.GIT`; whatever it left there would run for anyone who later
  // runs git in the worktree (D-079).
  private repairGitFile(taskId: string, admin: string): void {
    const dir = this.path(taskId);
    const file = path.join(dir, ".git");
    const wanted = `gitdir: ${admin}\n`;
    let repaired = false;
    for (const name of fs.readdirSync(dir)) {
      if (name !== ".git" && name.toLowerCase() === ".git") {
        fs.rmSync(path.join(dir, name), { recursive: true, force: true });
        repaired = true;
      }
    }
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (stat && !stat.isFile()) {
      fs.rmSync(file, { recursive: true, force: true });
      repaired = true;
    }
    const current = stat?.isFile() ? fs.readFileSync(file, "utf8") : undefined;
    if (current !== wanted) {
      fs.writeFileSync(file, wanted);
      if (current !== undefined) repaired = true;
    }
    if (repaired) this.log?.(`${taskId}: the worktree's .git had been changed; put it back`);
  }

  // The worktree on branch task/T-NNN, created from the main checkout's
  // current commit, or reused if it already exists.
  async ensure(taskId: string): Promise<string> {
    const dir = this.path(taskId);
    const admin = fs.existsSync(dir) ? await this.adminDir(taskId) : undefined;
    if (admin) {
      // A `git worktree add` that died midway leaves a partial checkout;
      // committing it would delete everything not checked out.
      const locked = (() => {
        try {
          return fs.readFileSync(path.join(admin, "locked"), "utf8");
        } catch {
          return "";
        }
      })();
      const head = await this.exec(["rev-parse", "--verify", "--quiet", "HEAD"], dir, { GIT_DIR: admin, GIT_WORK_TREE: dir });
      if (!/initializing/i.test(locked)) {
        if (head.code === 0) return dir;
        // Recreating would discard the worktree's changes; only do that for
        // a checkout git never finished.
        throw new TaskBlocked(`${taskId}'s worktree has no usable HEAD (was the ${this.branch(taskId)} branch deleted?); fix or remove ${dir}`);
      }
      this.log?.(`${taskId}'s worktree was left half-created; recreating it`);
      await this.git(["worktree", "remove", "--force", "--force", dir], this.root, "worktree remove");
    }
    // Drops the registration of a worktree whose folder was deleted.
    await this.git(["worktree", "prune"], this.root, "worktree prune");
    if (fs.existsSync(dir)) {
      throw new TaskBlocked(`${dir} exists but isn't a worktree of this repository; move it away so ${taskId} can start`);
    }
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const branch = this.branch(taskId);
    const exists = await this.exec(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], this.root);
    if (exists.code === 0) await this.git(["worktree", "add", dir, branch], this.root, `worktree add for ${taskId}`);
    else await this.git(["worktree", "add", "-b", branch, dir, "HEAD"], this.root, `worktree add for ${taskId}`);
    return dir;
  }

  // Commits everything the agent changed except the read-only paths.
  async commit(taskId: string, role: string, message: string): Promise<CommitResult> {
    const env = await this.worktreeEnv(taskId);
    const dir = this.path(taskId);
    await this.git(["add", "-A"], dir, "add", env);
    // -z: paths as they are, never C-quoted.
    const readOnly = (await this.git(["diff", "--cached", "--name-only", "-z", "--no-renames", "--", ...READ_ONLY_PATHS], dir, "diff", env)).split("\0").filter(Boolean);
    // Gitlinks (nested repositories) are never committed either. With -z,
    // --raw gives ":<modes and ids>\0<path>\0" per file.
    const raw = (await this.git(["diff", "--cached", "--raw", "-z", "--no-renames", "--ignore-submodules=none"], dir, "diff", env)).split("\0");
    const links: string[] = [];
    for (let i = 0; i + 1 < raw.length; i += 2) {
      if (/^:\d{6} 160000 /.test(raw[i] ?? "")) links.push(raw[i + 1] ?? "");
    }
    const refused = [...new Set([...readOnly, ...links])].filter(Boolean);
    if (refused.length) await this.git(["reset", "-q", "--", ...refused], dir, "reset", env);
    const staged = await this.exec(["diff", "--cached", "--quiet"], dir, env);
    if (staged.code === 0) return { committed: false, refused };
    const who = `Excaliharness (${role})`;
    await this.git(["-c", `user.name=${who}`, "-c", "user.email=excaliharness@localhost", "commit", "--no-verify", "-q", "-m", message], dir, "commit", env);
    return { committed: true, refused };
  }

  // What the task's branch changed since it left the main checkout's branch,
  // plus anything not committed yet (a round that stopped early), for the
  // next round's prompt (D-069).
  async diff(taskId: string): Promise<string> {
    // Checked once for the whole operation (the scan walks the worktree).
    const env = await this.worktreeEnv(taskId);
    const dir = this.path(taskId);
    const inWorktree = (args: string[], what: string) => this.git(args, dir, what, env);
    const head = await this.git(["rev-parse", "HEAD"], this.root, "rev-parse");
    const base = await inWorktree(["merge-base", "HEAD", head], "merge-base");
    const committed = await inWorktree(["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", base, "HEAD"], "diff");
    const status = await inWorktree(["status", "--short", "--untracked-files=all", "--ignore-submodules=all"], "status");
    const parts = [committed];
    if (status) parts.push(`# Not committed yet:\n${status}\n${await inWorktree(["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "HEAD"], "diff")}`);
    const diff = parts.filter(Boolean).join("\n\n");
    return diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n… (diff truncated)` : diff;
  }
}
