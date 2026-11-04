import { describe, expect, it } from "vitest";
import { summarize } from "./views";

describe("summarize", () => {
  it("counts INCONCLUSIVE apart from passes and failures", () => {
    const summary = summarize([
      { status: "COMPLETED", verdict: "PASS" },
      { status: "COMPLETED", verdict: "FAIL" },
      { status: "COMPLETED", verdict: "INCONCLUSIVE" },
      { status: "COMPLETED", verdict: "INCONCLUSIVE" },
      { status: "ERROR", verdict: null },
      { status: "WAITING_FOR_WEBHOOK", verdict: null },
    ]);
    expect(summary).toEqual({ total: 6, passed: 1, failed: 1, inconclusive: 2, errors: 1 });
  });
});
