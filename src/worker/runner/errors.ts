// Errors the orchestrator treats specially (D-079).

// A problem the human has to fix before the task can run; the message says how.
export class TaskBlocked extends Error {
  override name = "TaskBlocked";
}

// Claude rejected the token. The task isn't at fault: it waits for a new
// sign-in and then resumes.
export class TokenRejected extends Error {
  override name = "TokenRejected";
}
