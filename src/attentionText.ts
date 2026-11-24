// What a task-attention notification says and offers (D-077, D-084), kept
// free of VS Code so it can be tested on its own.
import type { TaskAttention } from "./worker/protocol";

export function attentionMessage(a: Pick<TaskAttention, "id" | "status">): string {
  if (a.status === "review") return `Task ${a.id} is ready for review`;
  if (a.status === "needs-decision") return `Task ${a.id} has a question for you`;
  return `Task ${a.id} needs you`;
}

// The same, for speech: "T-001" read aloud is "T minus zero zero one", so
// the number is spoken plainly ("Task 1 is ready for review", D-084).
export function spokenMessage(a: Pick<TaskAttention, "id" | "status">): string {
  const n = /^T-0*(\d+)$/.exec(a.id)?.[1] ?? a.id;
  return attentionMessage({ ...a, id: n });
}

// The button: the task file at its questions for a question, otherwise the
// worktree, when there is one.
export function attentionAction(a: Pick<TaskAttention, "status" | "worktree">): "Open task" | "Open review" {
  return a.status === "needs-decision" || a.worktree === undefined ? "Open task" : "Open review";
}
