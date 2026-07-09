import { describe, expect, it } from "vitest";

import { planDispatch } from "./dispatch.js";
import { runKind, GRADING_WORKFLOW_PATH } from "./grading.js";

describe("planDispatch (GR-16)", () => {
  const assignment = {
    id: "a-1",
    deadlineAt: new Date("2026-07-03T21:59:00Z"),
  };

  it("skips repositories without a frozen grade run (nothing to review)", () => {
    expect(planDispatch(assignment, null)).toBeNull();
  });

  it("builds the grade-final payload around the frozen commit", () => {
    const sha = "a".repeat(40);
    const plan = planDispatch(assignment, sha);
    expect(plan).toEqual({
      sha,
      eventType: "grade-final",
      clientPayload: {
        sha,
        assignment_id: "a-1",
        deadline: "2026-07-03T21:59:00.000Z",
        trigger: "deadline",
      },
    });
  });
});

describe("runKind (GR-16)", () => {
  it("classifies the dispatched grading run as llm", () => {
    expect(runKind({ event: "repository_dispatch", path: GRADING_WORKFLOW_PATH })).toBe("llm");
  });

  it("keeps push-triggered grading runs as ci (indicative tier)", () => {
    expect(runKind({ event: "push", path: GRADING_WORKFLOW_PATH })).toBe("ci");
  });

  it("never classifies a non-grading workflow as llm, even on dispatch", () => {
    // A student workflow listening to repository_dispatch must not be able
    // to impersonate the review pipeline.
    expect(runKind({ event: "repository_dispatch", path: ".github/workflows/own.yml" })).toBe("ci");
  });

  it("treats unknown events conservatively as ci", () => {
    expect(runKind({ event: "", path: GRADING_WORKFLOW_PATH })).toBe("ci");
  });
});
