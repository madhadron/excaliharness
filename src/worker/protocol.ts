// Messages between the extension and the orchestrator worker over Node IPC
// (D-021, D-039). Requests carry an id and get exactly one response with the
// same id; notifications flow from the worker and carry none. Requests are
// fully validated by the worker; the extension checks the shape of what it
// receives (the worker is its own child process, not untrusted input).
import { isStatus, type Diagnostic, type Status } from "./tasks/model";
import type { HumanStatus } from "./tasks/transitions";

export interface TaskSummary {
  id: string;
  // Relative to the repo root, with forward slashes.
  path: string;
  title: string;
  status: Status;
  statusLine: number;
  // Hash of the file's bytes when this summary was made.
  hash: string;
  // Statuses the human may set from here (D-037, D-043).
  allowed: HumanStatus[];
}

export interface TasksSnapshot {
  // Increases with every snapshot from one worker process; the extension
  // drops snapshots older than one it already has.
  version: number;
  // Another window holds the orchestrator lock (D-044).
  readOnly: boolean;
  tasks: TaskSummary[];
}

export interface DiagnosticsSnapshot {
  version: number;
  // Every file with diagnostics; files not listed have none.
  files: { path: string; diagnostics: Diagnostic[] }[];
}

export interface SetStatusParams {
  id: string;
  to: HumanStatus;
  // The worker refuses if the file no longer has this status and hash, so a
  // stale CodeLens or command can't act (compare-and-set).
  expectedStatus: Status;
  expectedHash: string;
}

export interface MethodParams {
  ping: undefined;
  "tasks/list": undefined;
  "tasks/setStatus": SetStatusParams;
}

export type Method = keyof MethodParams;

export interface NotificationParams {
  "tasks/changed": TasksSnapshot;
  "tasks/diagnostics": DiagnosticsSnapshot;
}

export type NotificationMethod = keyof NotificationParams;

export type Request = { [M in Method]: { id: number; method: M; params: MethodParams[M] } }[Method];

export type Notification = { [M in NotificationMethod]: { method: M; params: NotificationParams[M] } }[NotificationMethod];

export type Response =
  | { id: number; result: unknown }
  | { id: number; error: string };

type Record_ = Record<string, unknown>;

const isObject = (value: unknown): value is Record_ => typeof value === "object" && value !== null;

function hasSafeIntegerId(message: unknown): message is { id: number } & Record_ {
  return isObject(message) && Number.isSafeInteger(message.id);
}

function isSetStatusParams(p: unknown): p is SetStatusParams {
  return (
    isObject(p) &&
    typeof p.id === "string" &&
    /^T-\d+$/.test(p.id) &&
    (p.to === "ready" || p.to === "done") &&
    typeof p.expectedStatus === "string" &&
    isStatus(p.expectedStatus) &&
    typeof p.expectedHash === "string"
  );
}

const paramGuards: { [M in Method]: (params: unknown) => boolean } = {
  ping: (p) => p === undefined,
  "tasks/list": (p) => p === undefined,
  "tasks/setStatus": isSetStatusParams,
};

export function isRequest(message: unknown): message is Request {
  if (!hasSafeIntegerId(message) || typeof message.method !== "string") return false;
  if (!Object.hasOwn(paramGuards, message.method)) return false;
  return paramGuards[message.method as Method](message.params);
}

export function isResponse(message: unknown): message is Response {
  if (!hasSafeIntegerId(message)) return false;
  const hasResult = "result" in message;
  const hasError = typeof message.error === "string";
  return hasResult !== hasError;
}

const isSnapshotShape = (p: unknown): boolean => isObject(p) && Number.isSafeInteger(p.version);

export function isNotification(message: unknown): message is Notification {
  if (!isObject(message) || "id" in message) return false;
  if (message.method === "tasks/changed") {
    return isSnapshotShape(message.params) && Array.isArray((message.params as Record_).tasks);
  }
  if (message.method === "tasks/diagnostics") {
    return isSnapshotShape(message.params) && Array.isArray((message.params as Record_).files);
  }
  return false;
}

export type Handlers = { [M in Method]: (params: MethodParams[M]) => unknown };

// Runs the handler for a request. Returns undefined when the message has no
// usable id, since there is nothing to address a response to.
export async function dispatch(message: unknown, handlers: Handlers): Promise<Response | undefined> {
  if (!isRequest(message)) {
    return hasSafeIntegerId(message) ? { id: message.id, error: "invalid request" } : undefined;
  }
  try {
    const handler = handlers[message.method] as (params: unknown) => unknown;
    return { id: message.id, result: await handler(message.params) };
  } catch (error) {
    return { id: message.id, error: error instanceof Error ? error.message : String(error) };
  }
}
