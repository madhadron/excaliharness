// One task's Compose project (D-061): the target's Compose file from the main
// checkout plus the generated override, or a standalone file for an
// infrastructure task.
import { dockerEnv, tail, type Run, type RunOptions } from "./exec";

export class TaskProject {
  constructor(
    private readonly run: Run,
    private readonly socket: string,
    private readonly projectDir: string,
    readonly name: string,
    // The Compose files, in order (target's file, then the override).
    private readonly files: string[],
  ) {}

  // Arguments for a `docker compose …` command against this project.
  composeArgs(): string[] {
    return ["compose", "--project-directory", this.projectDir, "-p", this.name, ...this.files.flatMap((f) => ["-f", f])];
  }

  env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return dockerEnv(this.socket, extra);
  }

  async compose(args: string[], options: RunOptions & { what: string }): Promise<string> {
    const result = await this.run("docker", [...this.composeArgs(), ...args], { ...options, cwd: this.projectDir, env: options.env ?? this.env() });
    if (result.code !== 0) throw new Error(`${options.what} failed:\n${tail(result)}`);
    return result.stdout;
  }

  // Starts services in the background. `env` reaches Compose only, e.g. the
  // proxy's token (D-066); it isn't written anywhere.
  // `--no-deps`: the dev service is started per turn, never as a dependency
  // of another service (D-079).
  up(services: string[], env: NodeJS.ProcessEnv = {}, signal?: AbortSignal): Promise<string> {
    return this.compose(["up", "-d", "--no-build", "--no-deps", ...services], {
      what: `starting ${services.join(", ")}`,
      env: this.env(env),
      timeoutMs: 5 * 60_000,
      ...(signal ? { signal } : {}),
    });
  }

  // Stops and removes the project's containers and networks, keeping volumes
  // (the agent's session, D-071). With no files it works from the project's
  // container labels alone, for leftovers (D-079).
  down(): Promise<string> {
    return this.compose(["down", "--remove-orphans", "--timeout", "10"], { what: "stopping the task's services", timeoutMs: 2 * 60_000 });
  }
}
