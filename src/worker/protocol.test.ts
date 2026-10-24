import { describe, expect, it } from "vitest";
import { handleMessage, isRequest, isResponse } from "./protocol";

describe("isRequest", () => {
  it("accepts a known method with an integer id", () => {
    expect(isRequest({ id: 1, method: "ping" })).toBe(true);
  });

  it.each([
    null,
    undefined,
    "ping",
    {},
    { id: "1", method: "ping" },
    { id: 1.5, method: "ping" },
    { id: 1, method: "unknown" },
    { id: 1 },
  ])("rejects %j", (message) => {
    expect(isRequest(message)).toBe(false);
  });
});

describe("isResponse", () => {
  it.each([
    { id: 1, result: "pong" },
    { id: 1, result: undefined },
    { id: 1, error: "boom" },
  ])("accepts %j", (message) => {
    expect(isResponse(message)).toBe(true);
  });

  it.each([
    null,
    42,
    "pong",
    { result: "pong" },
    { id: "1", result: "pong" },
    { id: 1 },
    { id: 1, error: 5 },
    { id: 1, result: "pong", error: "boom" },
  ])("rejects %j", (message) => {
    expect(isResponse(message)).toBe(false);
  });
});

describe("handleMessage", () => {
  it("answers ping with pong", () => {
    expect(handleMessage({ id: 7, method: "ping" })).toEqual({ id: 7, result: "pong" });
  });

  it("returns an error for a bad request that has an id", () => {
    expect(handleMessage({ id: 3, method: "nope" })).toEqual({ id: 3, error: "invalid request" });
  });

  it.each([null, "x", { method: "ping" }, { id: "3", method: "ping" }])(
    "ignores %j, which has no usable id",
    (message) => {
      expect(handleMessage(message)).toBeUndefined();
    },
  );
});
