// The target's Compose setup, read from the main checkout, and the override
// that locks the dev service down (D-058 to D-061, D-063, D-064, E-007).
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { dockerEnv, tail, type Run } from "./exec";
import { isTagged, override, reset, toYaml, type YamlValue } from "./yaml";

export const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];
export const INTERNAL_NETWORK = "excaliharness-internal-network";
export const EGRESS_NETWORK = "excaliharness-egress-network";
export const PROXY_SERVICE = "excaliharness-egress-proxy";
export const PROXY_PORT = 8080;
// The volume's key in the Compose file; its Docker name is per task (D-079).
export const SESSION_VOLUME = "excaliharness-session";
export const AGENT_HOME = "/home/agent";
export const AGENT_USER = "1000:1000";
// Compose reads the token from its own environment when starting the proxy;
// it is never written into a file (D-066).
export const PROXY_TOKEN_VARIABLE = "EXCALIHARNESS_PROXY_TOKEN";

// The main checkout's files agents may read but never write (D-068).
export const READ_ONLY_PATHS = ["tasks", "TASKS.md", "agents", "docs/decisions.md"];

// `excaliharness-<repo hash>-`: names this repository's projects, so two
// windows on different repositories never share one (D-079).
export function projectPrefix(root: string): string {
  return `excaliharness-${createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 8)}-`;
}

export function projectName(root: string, taskId: string): string {
  return `${projectPrefix(root)}${taskId.toLowerCase()}`;
}

const regularFile = (p: string) => fs.lstatSync(p, { throwIfNoEntry: false })?.isFile() === true;

export type ProjectFiles = { ok: true; compose: string } | { ok: false; missing: string[] };

export function findProjectFiles(root: string): ProjectFiles {
  const missing: string[] = [];
  if (!regularFile(path.join(root, "Dockerfile"))) missing.push("Dockerfile");
  const compose = COMPOSE_FILES.find((f) => regularFile(path.join(root, f)));
  if (!compose) missing.push(`a Compose file (${COMPOSE_FILES.join(", ")})`);
  return compose && missing.length === 0 ? { ok: true, compose } : { ok: false, missing };
}

// The parts of `docker compose config --format json` this code looks at.
export interface ServiceConfig {
  build?: { context?: string; dockerfile?: string; ssh?: unknown; secrets?: unknown; additional_contexts?: unknown; network?: string; entitlements?: unknown; privileged?: boolean };
  secrets?: unknown[];
  configs?: unknown[];
  volumes_from?: unknown[];
  image?: string;
  privileged?: boolean;
  cap_add?: string[];
  devices?: unknown[];
  network_mode?: string;
  pid?: string;
  ipc?: string;
  userns_mode?: string;
  cgroup?: string;
  uts?: string;
  volumes?: { type?: string; source?: string; target?: string }[];
  networks?: Record<string, unknown> | null;
}

export interface ComposeConfig {
  name?: string;
  services: Record<string, ServiceConfig>;
}

// `envFile` replaces the folder's own .env (an agent's could link to a host
// file, D-085).
export async function resolveConfig(run: Run, socket: string, root: string, composeFile: string, envFile?: string): Promise<ComposeConfig> {
  const result = await run("docker", ["compose", "--project-directory", root, ...(envFile ? ["--env-file", envFile] : []), "-f", path.join(root, composeFile), "config", "--format", "json"], {
    cwd: root,
    env: dockerEnv(socket),
    timeoutMs: 60_000,
  });
  if (result.code !== 0) throw new Error(`docker compose config failed:\n${tail(result)}`);
  const parsed = JSON.parse(result.stdout) as Partial<ComposeConfig>;
  if (!parsed.services || typeof parsed.services !== "object") throw new Error("docker compose config returned no services");
  return parsed as ComposeConfig;
}

// D-063: the service built from the root Dockerfile.
export function findDevService(config: ComposeConfig, root: string): { ok: true; name: string } | { ok: false; error: string } {
  const rootDockerfile = path.join(root, "Dockerfile");
  const matches = Object.entries(config.services)
    .filter(([, s]) => s.build?.context !== undefined)
    .filter(([, s]) => path.resolve(root, s.build?.context ?? ".", s.build?.dockerfile ?? "Dockerfile") === rootDockerfile)
    .map(([name]) => name);
  if (matches.length === 1 && matches[0]) return { ok: true, name: matches[0] };
  if (matches.length === 0) return { ok: false, error: "no Compose service builds from the root Dockerfile (build: .), so there's no dev service to run agents in" };
  // Several (e.g. a web service and a worker): the one named dev (D-063).
  if (matches.includes("dev")) return { ok: true, name: "dev" };
  return { ok: false, error: `more than one Compose service builds from the root Dockerfile (${matches.join(", ")}) and none is named dev; name the one agents should work in dev` };
}

// D-059: settings on the dev service that refuse the start.
export function refusals(service: ServiceConfig, root: string): string[] {
  const problems: string[] = [];
  if (service.privileged) problems.push("it is privileged");
  if (service.cap_add?.length) problems.push(`it adds capabilities (${service.cap_add.join(", ")})`);
  if (service.devices?.length) problems.push("it is given host devices");
  // Any network_mode would replace the override's networks.
  if (service.network_mode) problems.push(`it sets network_mode (${service.network_mode}), which would replace the agent's network`);
  for (const [key, value] of [["pid", service.pid], ["ipc", service.ipc], ["userns_mode", service.userns_mode], ["cgroup", service.cgroup], ["uts", service.uts]] as const) {
    const name = key.replace("_mode", "");
    if (value === "host") problems.push(`it uses the host's ${name} namespace`);
    else if (value && /^(service|container):/.test(value)) problems.push(`it shares another container's ${name} namespace (${value})`);
  }
  for (const volume of service.volumes ?? []) {
    if (volume.type !== "bind" || !volume.source) continue;
    const source = path.resolve(volume.source);
    if (/docker\.sock$/.test(source)) problems.push(`it mounts the Docker socket (${source})`);
    else if (source !== root && !source.startsWith(`${root}${path.sep}`)) problems.push(`it mounts a host path outside the repository (${source})`);
  }
  return problems;
}

// Whether `rel` (from path.relative) leaves its base.
export const outside = (rel: string) => rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);

// What an infrastructure task may build: only these of the dev service's
// build settings, from the agent's own Compose file (D-085).
export interface AgentBuild {
  context: string;
  dockerfile: string;
  args?: Record<string, string>;
  target?: string;
}

const AGENT_BUILD_KEYS = new Set(["context", "dockerfile", "args", "target"]);

// What would let `docker compose config` itself read other files or fetch
// remote ones, refused before it runs on an agent's file (D-085). Without a
// YAML parser this is coarse on purpose: the words anywhere (flow style and
// JSON included), and the YAML and JSON forms that could spell a key
// without its plain text (escapes, tags, explicit keys).
export function agentComposeTextProblems(text: string): string[] {
  const problems = new Set<string>();
  for (const m of text.matchAll(/\b(include|extends|env_file|label_file)\b/g)) if (m[1]) problems.add(`it mentions ${m[1]}`);
  if (text.includes("\\")) problems.add("it contains a backslash");
  if (/(^|[\s:[{,-])!/m.test(text)) problems.add("it uses a YAML tag");
  if (/(^|[\s[{,])\?(\s|$)/m.test(text)) problems.add("it uses an explicit YAML key");
  return [...problems];
}

// The dev service's build, checked against the allowlist (D-085). `root` is
// the copy of the commit; context and Dockerfile must be inside it, with no
// symlinks on the way.
export function agentBuild(config: ComposeConfig, devService: string, root: string): { ok: true; build: AgentBuild } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const dev = config.services[devService] ?? {};
  if (dev.image !== undefined) problems.push(`the ${devService} service sets image: ${dev.image}`);
  const build = (dev.build ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(build)) if (!AGENT_BUILD_KEYS.has(key)) problems.push(`its build sets ${key}`);
  const realRoot = fs.realpathSync(root);
  const context = path.resolve(root, typeof build.context === "string" ? build.context : ".");
  const dockerfile = path.resolve(context, typeof build.dockerfile === "string" ? build.dockerfile : "Dockerfile");
  for (const [what, p, kind] of [["build context", context, "directory"], ["Dockerfile", dockerfile, "file"]] as const) {
    let real: string;
    try {
      real = fs.realpathSync(p);
    } catch {
      problems.push(`its ${what} doesn't exist`);
      continue;
    }
    // Symlinks could point anywhere on the host.
    if (real !== path.join(realRoot, path.relative(root, p)) || outside(path.relative(realRoot, real))) problems.push(`its ${what} is outside the repository or reached through a symlink`);
    const stat = fs.lstatSync(real);
    if (kind === "file" ? !stat.isFile() : !stat.isDirectory()) problems.push(`its ${what} isn't a ${kind}`);
  }
  const args: Record<string, string> = {};
  if (build.args !== undefined) {
    if (typeof build.args !== "object" || build.args === null) problems.push("its build args aren't a mapping");
    else for (const [k, v] of Object.entries(build.args as Record<string, unknown>)) args[k] = v === null || v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);
  }
  if (problems.length) return { ok: false, problems };
  const result: AgentBuild = { context: path.relative(root, context) || ".", dockerfile: path.relative(context, dockerfile) };
  if (Object.keys(args).length) result.args = args;
  if (build.target !== undefined) {
    if (typeof build.target !== "string" || !/^[A-Za-z0-9_.-]+$/.test(build.target)) problems.push("its build target isn't a plain stage name");
    else result.target = build.target;
  }
  for (const key of Object.keys(args)) if (!/^[A-Za-z0-9_.-]+$/.test(key)) problems.push(`its build arg ${key} isn't a plain name`);
  if (problems.length) return { ok: false, problems };
  return { ok: true, build: result };
}

// The Compose file an infrastructure task's image is built from: the dev
// service's allowed build settings only (D-085).
export function agentBuildCompose(build: AgentBuild, imageName: string): string {
  const spec: Record<string, YamlValue> = { context: literal(build.context), dockerfile: literal(build.dockerfile) };
  if (build.args) spec.args = Object.fromEntries(Object.entries(build.args).map(([k, v]) => [k, literal(v)]));
  if (build.target) spec.target = literal(build.target);
  return toYaml({ services: { dev: { build: spec, image: imageName } } });
}

// Service, network or volume names that could stand in for ours.
export function reservedNames(config: ComposeConfig & { networks?: Record<string, unknown>; volumes?: Record<string, unknown> }): string[] {
  const names = [...Object.keys(config.services), ...Object.keys(config.networks ?? {}), ...Object.keys(config.volumes ?? {})];
  return names.filter((n) => n.startsWith("excaliharness")).map((n) => `${n} is a name reserved for Excaliharness`);
}

// Images named like ours could stand in for them (D-079).
export function imageRefusals(config: ComposeConfig): string[] {
  return Object.entries(config.services)
    .filter(([, s]) => s.image?.startsWith("excaliharness-"))
    .map(([name, s]) => `the ${name} service uses the image name ${s.image ?? ""}, which is reserved for Excaliharness`);
}

export interface OverrideOptions {
  config: ComposeConfig;
  devService: string;
  devImage: string;
  proxyImage: string;
  root: string;
  worktree: string;
  // The task's project name, which names its session volume.
  project: string;
  // An empty file mounted over the worktree's .git (D-079).
  emptyFile: string;
  readOnly?: boolean;
  session?: boolean;
}

// Compose interpolates `$` in strings; ours are literal.
// (A function, because "$$" as a replacement string means one "$".)
const literal = (s: string) => s.replaceAll("$", () => "$$");

function agentEnvironment(): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: `http://${PROXY_SERVICE}:${PROXY_PORT}`,
    // The CLI needs a token to start; the proxy replaces it (E-005).
    CLAUDE_CODE_OAUTH_TOKEN: "placeholder-the-proxy-adds-the-real-token",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    HOME: AGENT_HOME,
    // An image built from an agent's Dockerfile could set these to run its
    // code inside every Node or dynamically linked process (D-085).
    NODE_OPTIONS: "",
    LD_PRELOAD: "",
    LD_LIBRARY_PATH: "",
  };
}

function hardened(extra: Record<string, YamlValue> = {}): Record<string, YamlValue> {
  return {
    privileged: false,
    cap_add: reset([]),
    cap_drop: ["ALL"],
    devices: reset([]),
    security_opt: override(["no-new-privileges:true"]),
    read_only: true,
    user: AGENT_USER,
    pull_policy: "never",
    ports: reset([]),
    container_name: reset(null),
    // A small init as PID 1 passes signals on, so `down` doesn't wait out
    // its timeout.
    init: true,
    ...extra,
  };
}

function proxyService(proxyImage: string): Record<string, YamlValue> {
  return {
    image: proxyImage,
    ...hardened(),
    tmpfs: override(["/tmp:size=16m"]),
    pids_limit: 64,
    // A 32 MB body is held parsed and re-serialized at once.
    mem_limit: "512m",
    restart: "on-failure",
    networks: override([INTERNAL_NETWORK, EGRESS_NETWORK]),
    environment: { [PROXY_TOKEN_VARIABLE]: `\${${PROXY_TOKEN_VARIABLE}:-}` },
    labels: { "org.excaliharness.role": "proxy" },
  };
}

export interface AgentMounts {
  root: string;
  // What is mounted at /workspace: the task's worktree, or for the gates a
  // copy of the round's commit (D-081).
  worktree: string;
  emptyFile: string;
  // Reviewers get /workspace read-only (D-072).
  readOnly?: boolean;
  // Only the implementer keeps a session; reviewers and gates start fresh and
  // never see it (D-082).
  session?: boolean;
}

function agentVolumes({ root, worktree, emptyFile, readOnly = false, session = true }: AgentMounts): string[] {
  // The worktree's .git file names a git directory on the host; the agent
  // gets an empty one instead, so there's nothing there to rewrite (D-079).
  const mounts = [`${literal(worktree)}:/workspace${readOnly ? ":ro" : ""}`, `${literal(emptyFile)}:/workspace/.git:ro`];
  for (const rel of READ_ONLY_PATHS) {
    if (fs.existsSync(path.join(root, rel))) mounts.push(`${literal(path.join(root, rel))}:/workspace/${rel}:ro`);
  }
  if (session) mounts.push(`${SESSION_VOLUME}:${AGENT_HOME}/.claude`);
  return mounts;
}

function agentService(mounts: AgentMounts, image: string): Record<string, YamlValue> {
  return {
    build: reset(null),
    image,
    ...hardened(),
    env_file: reset([]),
    // Host files and other services' mounts never reach the agent (D-079).
    volumes_from: reset([]),
    secrets: reset([]),
    configs: reset([]),
    group_add: reset([]),
    networks: override([INTERNAL_NETWORK]),
    volumes: override(agentVolumes(mounts)),
    tmpfs: override([`${AGENT_HOME}:uid=1000,gid=1000,mode=700,size=512m`, "/tmp:size=1g"]),
    working_dir: "/workspace",
    pids_limit: 1024,
    mem_limit: "4g",
    // Replaces the target's, so nothing it passes through from the host
    // reaches the agent (D-079).
    environment: override(agentEnvironment()),
    labels: { "org.excaliharness.role": "agent" },
  };
}

const sharedNetworks = (): Record<string, YamlValue> => ({
  [INTERNAL_NETWORK]: { internal: true },
  [EGRESS_NETWORK]: {},
});

const sessionVolume = (project: string): Record<string, YamlValue> => ({ [SESSION_VOLUME]: { name: `${project}-session` } });

// The override for a normal task. Other services join the internal network
// too; their networks are copied from the target's own resolved config and
// ours added, because adding to an implicit default network replaces it
// (E-007). They keep their own networks, so an agent could relay through
// them; that is an accepted risk (D-079). Returns the YAML and any services
// that couldn't be connected.
export function generateOverride(options: OverrideOptions): { yaml: string; unconnected: string[] } {
  const services: Record<string, YamlValue> = {
    [options.devService]: agentService(options, options.devImage),
    [PROXY_SERVICE]: proxyService(options.proxyImage),
  };
  const unconnected: string[] = [];
  for (const [name, service] of Object.entries(options.config.services)) {
    // Never over our own entries.
    if (name === options.devService || name === PROXY_SERVICE) continue;
    if (service.network_mode) {
      unconnected.push(name);
      continue;
    }
    const networks: Record<string, YamlValue> = {};
    for (const network of Object.keys(service.networks ?? { default: null })) networks[network] = null;
    networks[INTERNAL_NETWORK] = null;
    services[name] = { networks, ports: reset([]), container_name: reset(null) };
  }
  return { yaml: toYaml({ networks: sharedNetworks(), volumes: sessionVolume(options.project), services }), unconnected };
}

// The build settings for building from the task's worktree instead of the
// main checkout (D-062): every build context inside the repository moves to
// the same place in the worktree. The Compose file itself stays the main
// checkout's (D-059).
export function buildOverride(config: ComposeConfig, root: string, worktree: string): string {
  const services: Record<string, YamlValue> = {};
  for (const [name, service] of Object.entries(config.services)) {
    const context = service.build?.context;
    if (context === undefined) continue;
    if (/^[a-z]+:\/\/|^git@/i.test(context)) continue;
    const rel = path.relative(root, path.resolve(root, context));
    if (outside(rel)) continue;
    services[name] = { build: { context: literal(path.join(worktree, rel)) } };
  }
  return toYaml({ services });
}

// A complete Compose file for an infrastructure task, which runs in the base
// agent image because the target has no dev image yet (D-062).
export function infrastructureCompose(options: AgentMounts & { baseImage: string; proxyImage: string; project: string }): string {
  const agent = agentService(options, options.baseImage);
  delete agent.build;
  // A standalone file has nothing to reset; the tags would be invalid.
  const plain = (v: YamlValue): YamlValue => (isTagged(v) ? v.value : v);
  const untag = (s: Record<string, YamlValue>): Record<string, YamlValue> => {
    const out: Record<string, YamlValue> = {};
    for (const [k, v] of Object.entries(s)) {
      const value = plain(v);
      if (value !== null) out[k] = value;
    }
    return out;
  };
  return toYaml({
    networks: sharedNetworks(),
    volumes: sessionVolume(options.project),
    services: { agent: untag(agent), [PROXY_SERVICE]: untag(proxyService(options.proxyImage)) },
  });
}
