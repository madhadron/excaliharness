// Messages between the extension and the orchestrator worker over Node IPC
// (D-021). Every request carries an id; the worker answers each with exactly
// one response carrying the same id. Both directions are validated, since IPC
// payloads arrive untyped.

export type Method = "ping";

export interface Request {
  id: number;
  method: Method;
}

export type Response =
  | { id: number; result: unknown }
  | { id: number; error: string };

const methods: ReadonlySet<string> = new Set<Method>(["ping"]);

function hasSafeIntegerId(message: unknown): message is { id: number } & Record<string, unknown> {
  return (
    typeof message === "object" &&
    message !== null &&
    Number.isSafeInteger((message as Record<string, unknown>).id)
  );
}

export function isRequest(message: unknown): message is Request {
  return hasSafeIntegerId(message) && typeof message.method === "string" && methods.has(message.method);
}

export function isResponse(message: unknown): message is Response {
  if (!hasSafeIntegerId(message)) return false;
  const hasResult = "result" in message;
  const hasError = typeof message.error === "string";
  return hasResult !== hasError;
}

// Returns undefined when the message has no usable id, since there is nothing
// to address a response to.
export function handleMessage(message: unknown): Response | undefined {
  if (!isRequest(message)) {
    return hasSafeIntegerId(message) ? { id: message.id, error: "invalid request" } : undefined;
  }
  switch (message.method) {
    case "ping":
      return { id: message.id, result: "pong" };
  }
}
