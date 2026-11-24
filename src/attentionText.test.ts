import { describe, expect, it } from "vitest";
import { attentionAction, attentionMessage, spokenMessage } from "./attentionText";

describe("attention notifications (D-077, D-084)", () => {
  it.each([
    ["review", "Task T-7 is ready for review", "Open review"],
    ["needs-human", "Task T-7 needs you", "Open review"],
    ["needs-decision", "Task T-7 has a question for you", "Open task"],
  ] as const)("%s", (status, message, action) => {
    expect(attentionMessage({ id: "T-7", status })).toBe(message);
    expect(attentionAction({ status, worktree: "/w" })).toBe(action);
  });

  it("speaks the number plainly", () => {
    expect(spokenMessage({ id: "T-001", status: "review" })).toBe("Task 1 is ready for review");
    expect(spokenMessage({ id: "T-120", status: "needs-decision" })).toBe("Task 120 has a question for you");
  });

  it("opens the task when there is no worktree", () => {
    expect(attentionAction({ status: "needs-human" })).toBe("Open task");
  });
});
