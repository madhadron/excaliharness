import { describe, expect, it } from "vitest";
import { dispatch, isNotification, isRequest, isResponse, isReviewInfo, type Handlers } from "./protocol";

const setStatus = { id: "T-1", to: "ready", expectedStatus: "draft", expectedHash: "abc" };

describe("isRequest", () => {
  it.each([
    { id: 1, method: "ping" },
    { id: 1, method: "tasks/list" },
    { id: 1, method: "tasks/setStatus", params: setStatus },
    { id: 1, method: "review/prepare", params: { id: "T-12" } },
  ])("accepts %j", (message) => {
    expect(isRequest(message)).toBe(true);
  });

  it.each([
    null,
    undefined,
    "ping",
    {},
    { id: "1", method: "ping" },
    { id: 1.5, method: "ping" },
    { id: 1, method: "unknown" },
    { id: 1, method: "toString" },
    { id: 1 },
    { id: 1, method: "ping", params: {} },
    { id: 1, method: "tasks/setStatus" },
    { id: 1, method: "tasks/setStatus", params: { ...setStatus, to: "review" } },
    { id: 1, method: "tasks/setStatus", params: { ...setStatus, id: "../etc" } },
    { id: 1, method: "tasks/setStatus", params: { ...setStatus, expectedStatus: "nope" } },
    { id: 1, method: "tasks/setStatus", params: { ...setStatus, expectedHash: 5 } },
    { id: 1, method: "review/prepare", params: { id: "../T-1" } },
    { id: 1, method: "review/prepare" },
  ])("rejects %j", (message) => {
    expect(isRequest(message)).toBe(false);
  });
});

describe("isResponse", () => {
  it.each([{ id: 1, result: "pong" }, { id: 1, result: undefined }, { id: 1, error: "boom" }])("accepts %j", (message) => {
    expect(isResponse(message)).toBe(true);
  });

  it.each([null, 42, "pong", { result: "pong" }, { id: "1", result: "pong" }, { id: 1 }, { id: 1, error: 5 }, { id: 1, result: "pong", error: "boom" }])(
    "rejects %j",
    (message) => {
      expect(isResponse(message)).toBe(false);
    },
  );
});

describe("isNotification", () => {
  it("accepts the worker's notifications", () => {
    expect(isNotification({ method: "tasks/changed", params: { version: 1, readOnly: false, tasks: [] } })).toBe(true);
    expect(isNotification({ method: "tasks/diagnostics", params: { version: 1, files: [] } })).toBe(true);
  });

  it.each([
    null,
    { method: "tasks/changed" },
    { method: "tasks/changed", params: { version: 1 } },
    { method: "tasks/changed", params: { version: "1", tasks: [] } },
    { id: 1, method: "tasks/changed", params: { version: 1, tasks: [] } },
    { method: "other", params: { version: 1 } },
  ])("rejects %j", (message) => {
    expect(isNotification(message)).toBe(false);
  });
});

describe("dispatch", () => {
  const handlers: Handlers = {
    ping: () => "pong",
    "tasks/list": () => Promise.resolve({ version: 1 }),
    "tasks/setStatus": () => {
      throw new Error("refused");
    },
    "auth/signIn": () => {
      throw Object.assign(new Error("no Docker"), { code: "docker-unavailable" });
    },
    "auth/submitCode": () => "accepted",
    "auth/cancel": () => undefined,
    "auth/setToken": () => undefined,
    "settings/update": () => undefined,
    "review/prepare": () => undefined,
  };

  it("sends null for a handler that returns nothing, so the reply survives IPC", async () => {
    await expect(dispatch({ id: 5, method: "auth/cancel" }, handlers)).resolves.toEqual({ id: 5, result: null });
  });

  it("passes an error's code along", async () => {
    await expect(dispatch({ id: 4, method: "auth/signIn" }, handlers)).resolves.toEqual({ id: 4, error: "no Docker", code: "docker-unavailable" });
  });

  it("validates sign-in parameters", () => {
    expect(isRequest({ id: 1, method: "auth/submitCode", params: { attempt: 1, code: "abc" } })).toBe(true);
    expect(isRequest({ id: 1, method: "auth/submitCode", params: { code: "abc" } })).toBe(false);
    expect(isRequest({ id: 1, method: "auth/submitCode", params: { attempt: 1, code: 5 } })).toBe(false);
    expect(isRequest({ id: 1, method: "auth/submitCode", params: { attempt: 1, code: "x".repeat(3_000) } })).toBe(false);
    expect(isRequest({ id: 1, method: "auth/cancel", params: { attempt: 2 } })).toBe(true);
    expect(isRequest({ id: 1, method: "auth/cancel" })).toBe(true);
  });

  it("accepts sign-in notifications only with https URLs", () => {
    expect(isNotification({ method: "auth/prompt", params: { url: "https://claude.com/x", attempt: 1 } })).toBe(true);
    expect(isNotification({ method: "auth/prompt", params: { url: "https://claude.com/x" } })).toBe(false);
    expect(isNotification({ method: "auth/prompt", params: { url: "javascript:alert(1)", attempt: 1 } })).toBe(false);
    expect(isNotification({ method: "progress", params: { message: "Building" } })).toBe(true);
  });

  it("answers with the handler's result, awaited", async () => {
    await expect(dispatch({ id: 7, method: "ping" }, handlers)).resolves.toEqual({ id: 7, result: "pong" });
    await expect(dispatch({ id: 8, method: "tasks/list" }, handlers)).resolves.toEqual({ id: 8, result: { version: 1 } });
  });

  it("turns a handler's error into an error response", async () => {
    await expect(dispatch({ id: 2, method: "tasks/setStatus", params: setStatus }, handlers)).resolves.toEqual({ id: 2, error: "refused" });
  });

  it("returns an error for a bad request that has an id", async () => {
    await expect(dispatch({ id: 3, method: "nope" }, handlers)).resolves.toEqual({ id: 3, error: "invalid request" });
  });

  it.each([null, "x", { method: "ping" }, { id: "3", method: "ping" }])("ignores %j, which has no usable id", async (message) => {
    await expect(dispatch(message, handlers)).resolves.toBeUndefined();
  });
});

describe("isReviewInfo", () => {
  const info = { id: "T-1", worktree: "/s/worktrees/T-1", baseDir: "/s/review/T-1", base: "abc", files: [{ path: "a.txt", change: "added" }], truncated: false };

  it("accepts the worker's review result", () => {
    expect(isReviewInfo(info)).toBe(true);
  });

  it.each([null, { ...info, files: [{ path: "a.txt", change: "renamed" }] }, { ...info, truncated: "no" }, { ...info, worktree: undefined }])("rejects %j", (r) => {
    expect(isReviewInfo(r)).toBe(false);
  });
});
