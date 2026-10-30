// Where a task is in its loop (D-072, D-080, D-083), saved in the worker's
// state folder so a restarted worker carries on where it stopped.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Finding, GateFailure } from "./findings";

// D-010/D-072: after this many rounds the task goes to needs-human.
export const MAX_ROUNDS = 3;

// "done": clean, waiting for the orchestrator to record it (so a crash in
// between doesn't run the rounds again).
export type Phase = "implement" | "gates" | "review" | "done";

export interface RoundState {
  round: number;
  // Where the round starts (or resumes).
  phase: Phase;
  // What the last gates and reviewers left open, for the next round.
  failures: GateFailure[];
  findings: Finding[];
  // The images last built for this task, and the commit they were built from.
  image?: { builtFrom: string; devImage: string; derived: string };
  // D-080: a build of `commit` with the network on, waiting for the human or
  // approved by them. Only that commit may be built under it.
  approval?: { commit: string; approved: boolean };
  // The last round ended with things still open (D-083); only the human
  // marking the task ready starts more rounds.
  exhausted?: boolean;
  // Waiting for an answer to this agent's question (D-083).
  paused?: "implementer" | "reviewer";
  // The implementer's latest summary, for the task's Updates when it's clean.
  summary?: string;
  // An approved build of this commit failed; shown again until the human
  // marks the task ready, which retries it.
  failedBuild?: { commit: string; output: string };
  // The last build's context and Dockerfile, for finding changed build
  // inputs of an infrastructure task's own build.
  buildSpec?: { context: string; dockerfile: string };
  // The commit the task's branch started from, recorded on its first run:
  // the human's own code (D-080). Never recomputed, so checking the branch
  // out in the main checkout can't make the agent's commits look trusted.
  start?: string;
}

export function freshState(): RoundState {
  return { round: 1, phase: "implement", failures: [], findings: [] };
}

// The human marked a needs-human task ready: the count starts again, a
// pending online build is approved, the round carries on from the phase it
// stopped in (a new round after the last one), and what's open is kept
// (D-080, D-083).
export function afterHumanReady(state: RoundState): RoundState {
  const next: RoundState = { ...state, round: 1 };
  if (state.approval) next.approval = { ...state.approval, approved: true };
  if (state.exhausted) next.phase = "implement";
  delete next.exhausted;
  delete next.paused;
  return next;
}

const PHASES: readonly Phase[] = ["implement", "gates", "review", "done"];

function valid(value: unknown): value is RoundState {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Partial<RoundState>;
  return (
    typeof s.round === "number" &&
    Number.isInteger(s.round) &&
    s.round >= 1 &&
    s.round <= MAX_ROUNDS &&
    PHASES.includes(s.phase as Phase) &&
    Array.isArray(s.failures) &&
    Array.isArray(s.findings) &&
    (s.approval === undefined || (typeof s.approval === "object" && s.approval !== null && typeof s.approval.commit === "string" && typeof s.approval.approved === "boolean")) &&
    (s.paused === undefined || s.paused === "implementer" || s.paused === "reviewer") &&
    (s.start === undefined || (typeof s.start === "string" && /^[0-9a-f]{40,64}$/.test(s.start))) &&
    (s.failedBuild === undefined || (typeof s.failedBuild === "object" && s.failedBuild !== null && typeof s.failedBuild.commit === "string" && typeof s.failedBuild.output === "string")) &&
    (s.image === undefined || (typeof s.image === "object" && s.image !== null && typeof s.image.builtFrom === "string" && typeof s.image.derived === "string")) &&
    (s.failures as unknown[]).every((f) => typeof f === "object" && f !== null && typeof (f as GateFailure).label === "string" && Array.isArray((f as GateFailure).commands)) &&
    (s.findings as unknown[]).every((f) => typeof f === "object" && f !== null && typeof (f as Finding).summary === "string" && typeof (f as Finding).severity === "string")
  );
}

export class Rounds {
  constructor(private readonly dir: string) {}

  private file(taskId: string): string {
    return path.join(this.dir, `${taskId}.json`);
  }

  // A state that doesn't read or validate starts the task over.
  load(taskId: string): RoundState {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.file(taskId), "utf8"));
      return valid(parsed) ? parsed : freshState();
    } catch {
      return freshState();
    }
  }

  save(taskId: string, state: RoundState): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file(taskId)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, this.file(taskId));
  }

  clear(taskId: string): void {
    fs.rmSync(this.file(taskId), { force: true });
  }
}
