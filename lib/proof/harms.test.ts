import { describe, expect, it } from "vitest";
import { consequences, HARMS } from "./harms";

describe("consequences", () => {
  it("lists what a naive run cost, the buyer's money first and the lost sale last", () => {
    const run = [
      { harm: null },
      { harm: "sale_lost" },
      { harm: "cart_charged_twice" },
      { harm: "order_shipped_twice" },
      { harm: "refund_shown_as_paid" },
      { harm: "forged_refund_accepted" },
    ];
    expect(consequences(run)).toEqual([
      "1 cart charged twice",
      "1 order shipped twice",
      "1 refund shown as paid",
      "1 forged refund accepted",
      "1 sale lost",
    ]);
  });

  it("counts a harm that several scenarios caused, in the plural", () => {
    expect(consequences([{ harm: "sale_lost" }, { harm: "sale_lost" }, { harm: "cart_charged_twice" }])).toEqual([
      "1 cart charged twice",
      "2 sales lost",
    ]);
  });

  it("says nothing for a run with no harm, and drops values it does not know", () => {
    expect(consequences([{ harm: null }, { harm: null }])).toEqual([]);
    expect(consequences([{ harm: "toString" }, { harm: "something_else" }])).toEqual([]);
  });

  it("words every harm in the singular and the plural", () => {
    for (const [one, many] of Object.values(HARMS)) {
      expect(one).not.toBe(many);
      expect(one).toMatch(/^[a-z]/);
    }
  });
});
