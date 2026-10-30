// Task worktrees and commits (D-069, D-075, D-079). Git runs on the host only,
// never in a container, and never runs anything an agent could have planted:
// hooks, fsmonitor, signing programs, system or global config, and the
// worktree's own `.git` file are all left out. Every call names the git
// directory and work tree itself, found from the main repository.
import * as fs from "node:fs";
import * as path from "node:path";
import { READ_ONLY_PATHS } from "./compose";
import { inertLine } from "./clean";
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
      throw new TaskBlocked(`the agent created a git repository inside ${taskId}'s worktree (${nested.slice(0, 5).map((n) => inertLine(n, 200)).join(", ")}); git won't run there until it is removed`);
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
  // The commit the task's branch points at.
  async head(taskId: string): Promise<string> {
    return this.git(["rev-parse", "--verify", `refs/heads/${this.branch(taskId)}^{commit}`], this.root, "rev-parse");
  }

  // Where the task's branch left the main checkout's branch: the human's own
  // code (D-080).
  async startCommit(taskId: string): Promise<string> {
    const main = await this.git(["rev-parse", "HEAD"], this.root, "rev-parse");
    return this.git(["merge-base", main, `refs/heads/${this.branch(taskId)}`], this.root, "merge-base");
  }

  // The committed changes on the task's branch, for reviewers (D-082). Run in
  // the main repository: it reads commits only, never the worktree.
  async branchDiff(taskId: string): Promise<string> {
    const base = await this.startCommit(taskId);
    const diff = await this.git(["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", base, `refs/heads/${this.branch(taskId)}`], this.root, "diff");
    return diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n… (diff truncated)` : diff;
  }

  // Whether a commit still exists (a reset branch may have lost it).
  async exists(commit: string): Promise<boolean> {
    return (await this.exec(["cat-file", "-e", `${commit}^{commit}`], this.root)).code === 0;
  }

  // The build inputs (D-080) that changed between two commits: manifests and
  // Dockerfiles by name, Compose files, and what each build's Dockerfile
  // copies (paths relative to the repository). This decides whether the image
  // is stale; whether a build may use the network is decided by which commit
  // is built, not by this list.
  async changedBuildInputs(from: string, to: string, builds: BuildSpec[] = [{ context: ".", dockerfile: "Dockerfile" }]): Promise<string[]> {
    if (from === to) return [];
    const listed = await this.exec(["diff", "--name-only", "-z", "--no-renames", from, to], this.root);
    if (listed.code !== 0) throw new Error(`git diff failed:\n${tail(listed)}`);
    if (listed.truncated) return ["(more changed files than can be listed)"];
    const changed = listed.stdout.split("\0").filter(Boolean);
    if (!changed.length) return [];
    const copied: CopiedPath[] = [];
    const dockerfiles = new Set<string>();
    for (const build of builds) {
      const dockerfile = path.posix.normalize(path.posix.join(build.context, build.dockerfile));
      dockerfiles.add(dockerfile);
      const text = await this.exec(["show", `${to}:${dockerfile}`], this.root);
      if (text.code !== 0) continue;
      for (const c of copiedPaths(text.stdout)) copied.push({ ...c, path: path.posix.normalize(path.posix.join(build.context, c.path)) });
    }
    return changed.filter((file) => dockerfiles.has(file) || isBuildInput(file, copied));
  }

  // The tree of `commit`, checked out into `dir` (replacing it) for the gates
  // (D-081). A separate index, so the main checkout's isn't touched; not
  // `git archive`, whose in-tree export-ignore could leave files out.
  async exportCommit(commit: string, dir: string): Promise<void> {
    // An agent could commit a tree big enough to fill the disk.
    // Counted line by line as it streams, so the size of the listing itself
    // doesn't matter.
    let files = 0;
    let bytes = 0;
    const listing = await this.run("git", [...SAFE_CONFIG, "ls-tree", "-r", "-l", commit], {
      cwd: this.root,
      env: this.env(),
      timeoutMs: 5 * 60_000,
      onLine: (line) => {
        if (!line) return;
        files++;
        bytes += Number(/^\S+ \S+ \S+ +(\d+)\t/.exec(line)?.[1]) || 0;
      },
    });
    if (listing.code !== 0) throw new Error(`git ls-tree failed:\n${tail(listing)}`);
    if (files > MAX_EXPORT_FILES || bytes > MAX_EXPORT_BYTES) {
      throw new TaskBlocked(`commit ${commit.slice(0, 12)} is too big to check out (${files} files, ${Math.round(bytes / 1e6)} MB)`);
    }
    removeQuietly(dir, this.log);
    fs.mkdirSync(dir, { recursive: true });
    const index = `${dir}.index`;
    fs.rmSync(index, { force: true });
    const env = { GIT_INDEX_FILE: index, GIT_WORK_TREE: dir };
    try {
      await this.git(["read-tree", commit], this.root, "read-tree", env);
      await this.git(["checkout-index", "--all", "--force"], this.root, "checkout-index", env);
    } finally {
      fs.rmSync(index, { force: true });
    }
  }
}

const MAX_EXPORT_FILES = 500_000;
const MAX_EXPORT_BYTES = 4e9;

// Removes a folder the gates or a build used, making what a container left
// read-only writable first; logs instead of failing.
export function removeQuietly(dir: string, log?: (line: string) => void): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  } catch {
    // Try again below.
  }
  try {
    const chmod = (p: string) => {
      const stat = fs.lstatSync(p, { throwIfNoEntry: false });
      if (!stat || stat.isSymbolicLink()) return;
      if (stat.isDirectory()) {
        fs.chmodSync(p, 0o700);
        for (const name of fs.readdirSync(p)) chmod(path.join(p, name));
      }
    };
    chmod(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    log?.(`couldn't remove ${dir}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// A service's build: its context and Dockerfile, relative to the repository.
export interface BuildSpec {
  context: string;
  dockerfile: string;
}

export interface CopiedPath {
  path: string;
  // A directory or glob: everything under or matching it counts.
  tree: boolean;
}

// Dependency manifests, lockfiles, Compose files and Dockerfiles, by name
// (D-080).
const MANIFESTS = new Set([
  "Dockerfile",
  ".dockerignore",
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
  ".env",
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "bun.lockb",
  "bun.lock",
  ".npmrc",
  ".yarnrc.yml",
  "pyproject.toml",
  "poetry.lock",
  "uv.lock",
  "Pipfile",
  "Pipfile.lock",
  "setup.py",
  "setup.cfg",
  "Cargo.toml",
  "Cargo.lock",
  "go.mod",
  "go.sum",
  "Gemfile",
  "Gemfile.lock",
  "composer.json",
  "composer.lock",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "gradle.properties",
  "packages.lock.json",
  "Directory.Packages.props",
  "mix.exs",
  "mix.lock",
]);
const MANIFEST_PATTERNS = [
  /^requirements.*\.txt$/,
  /^constraints.*\.txt$/,
  /\.gemspec$/,
  /\.csproj$/,
  /\.fsproj$/,
  /(^|\.)Dockerfile(\.|$)/i,
  /\.dockerfile$/i,
  /^(docker-)?compose\..*\.ya?ml$/,
  /^\.env\./,
];

// Whether a path matches a glob, or is under something that does. Every
// `*` may cross directories and a character class matches any character,
// so it matches at least what Docker would (over-matching only offers a
// rebuild). Two-pointer matching with no backtracking beyond the last star:
// at most pattern × path steps, whatever the agent's Dockerfile says.
export function globMatches(glob: string, file: string): boolean {
  const pattern = glob.replace(/\[[^\]/]*\]?/g, "?");
  const matches = (text: string) => {
    let p = 0;
    let t = 0;
    let star = -1;
    let mark = 0;
    while (t < text.length) {
      if (p < pattern.length && (pattern[p] === "?" || pattern[p] === text[t])) {
        p++;
        t++;
      } else if (p < pattern.length && pattern[p] === "*") {
        star = p++;
        mark = t;
      } else if (star >= 0) {
        p = star + 1;
        t = ++mark;
      } else return false;
    }
    while (p < pattern.length && pattern[p] === "*") p++;
    return p === pattern.length;
  };
  if (matches(file)) return true;
  // A matched directory takes everything under it.
  for (let i = file.indexOf("/"); i > 0; i = file.indexOf("/", i + 1)) if (matches(file.slice(0, i))) return true;
  return false;
}

export function isBuildInput(file: string, copied: readonly CopiedPath[]): boolean {
  const base = path.posix.basename(file);
  if (MANIFESTS.has(base) || MANIFEST_PATTERNS.some((p) => p.test(base))) return true;
  return copied.some((c) => {
    if (/[*?[]/.test(c.path)) return globMatches(c.path, file);
    // A directory or a file: `config.d` may well be a directory.
    return file === c.path || file.startsWith(`${c.path}/`);
  });
}

// What a Dockerfile's COPY and ADD lines take from the build context: paths,
// directories and globs, in shell or JSON form. `.` (everything) is left out:
// that the whole context goes in is the reason a rebuild needs approval, not
// a change to list. URLs, other stages and heredocs are skipped.
export function copiedPaths(dockerfile: string): CopiedPath[] {
  const found: CopiedPath[] = [];
  const joined = dockerfile.replace(/\\\r?\n/g, " ");
  for (const line of joined.split(/\r?\n/)) {
    const m = /^\s*(?:COPY|ADD)\s+(.*)$/i.exec(line);
    if (!m?.[1]) continue;
    let rest = m[1].trim();
    const flags: string[] = [];
    while (rest.startsWith("--")) {
      const flag = /^\S+/.exec(rest)?.[0] ?? "";
      flags.push(flag);
      rest = rest.slice(flag.length).trim();
    }
    if (flags.some((f) => /^--from=/i.test(f))) continue;
    let args: string[];
    if (rest.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(rest);
        args = Array.isArray(parsed) ? parsed.filter((a): a is string => typeof a === "string") : [];
      } catch {
        continue;
      }
    } else args = rest.split(/\s+/);
    for (const source of args.slice(0, -1)) {
      if (source.startsWith("<<") || /^[a-z]+:\/\//i.test(source)) continue;
      const clean = source.replace(/^\.\//, "").replace(/\/+$/, "");
      if (!clean || clean === ".") continue;
      // Without a file extension it may well be a directory.
      found.push({ path: path.posix.normalize(clean), tree: source.endsWith("/") || !/\.[^/]+$/.test(clean) || /[*?[]/.test(clean) });
    }
  }
  return found;
}

// The files a Dockerfile copies by name (for tests and messages).
export function copiedFiles(dockerfile: string): Set<string> {
  return new Set(copiedPaths(dockerfile).filter((c) => !c.tree).map((c) => c.path));
}
