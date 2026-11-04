import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyEdits, unifiedDiff, visibleIndent } from "./edits";
import { checkPatch } from "./patch";

const PATH = "lib/store/naive.ts";
const SOURCE = readFileSync(PATH, "utf8");
const target = { path: PATH, source: SOURCE };

const FAILED_LINE = '    else result = { status: "FAILED", captureId: null };';
const RECONCILE = [
  '    else if (outcome.kind === "unknown") {',
  "      const reconciled = reconciliationFrom(await getOrder(await paypal(context), order.paypalOrderId));",
  '      result = typeof reconciled === "string" ? { status: "PENDING", captureId: null } : reconciled;',
  "    }",
  FAILED_LINE,
].join("\n");

describe("applyEdits", () => {
  it("applies a find that occurs once, and builds a diff that applies to the real file", () => {
    const applied = applyEdits(target, [{ file: PATH, find: FAILED_LINE, replace: RECONCILE }]);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.source).toBe(SOURCE.replace(FAILED_LINE, RECONCILE));
    expect(applied.patch.startsWith(`--- a/${PATH}\n+++ b/${PATH}\n@@ -`)).toBe(true);
    expect(checkPatch(applied.patch, target).status).toBe("applies");
  });

  it("applies several edits in one go, whatever their order, and accepts an a/ prefix on the path", () => {
    const imports = { file: `a/${PATH}`, find: 'import { captureOrder, createOrder } from "../paypal/orders";', replace: 'import { captureOrder, createOrder, getOrder } from "../paypal/orders";' };
    const applied = applyEdits(target, [{ file: PATH, find: FAILED_LINE, replace: RECONCILE }, imports]);
    expect(applied.ok).toBe(true);
    if (applied.ok) expect(applied.source).toContain("createOrder, getOrder }");
  });

  it("rejects a find that occurs more than once, naming every line", () => {
    const applied = applyEdits(target, [{ file: PATH, find: "  },", replace: "  }," + " // end" }]);
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.problems[0]).toMatch(/^Edit 1 of 1: find occurs \d+ times in lib\/store\/naive\.ts, at lines \d+(, \d+)+\. Add surrounding lines/);
  });

  it("shows the model the file's own indentation when its quote is indented differently", () => {
    // The S3 analysis of run fcc80878 quoted these lines with two spaces where the file has four.
    const find = ["  let result: CaptureResult;", '  if (outcome.kind === "settled") result = outcome.result;'].join("\n");
    const applied = applyEdits(target, [{ file: PATH, find, replace: `${find}\n  // changed` }]);
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    const line = SOURCE.split("\n").indexOf("    let result: CaptureResult;") + 1;
    expect(applied.problems[0]).toContain('line 1 of find, "··let result: CaptureResult;", is not a line of lib/store/naive.ts');
    expect(applied.problems[0]).toContain("The file has that line with other indentation (· is a space):");
    expect(applied.problems[0]).toContain(`    ${line}: ····let result: CaptureResult;`);
  });

  it("names the closest lines when a quote is not in the file at all", () => {
    const applied = applyEdits(target, [{ file: PATH, find: '    else result = { status: "FAILURE", captureId: undefined };', replace: "x" }]);
    expect(applied.ok).toBe(false);
    if (!applied.ok) expect(applied.problems[0]).toContain("The closest lines of the file are");
    const nothing = applyEdits(target, [{ file: PATH, find: "zzzz qqqq", replace: "x" }]);
    if (!nothing.ok) expect(nothing.problems[0]).toContain("no line of the file is close to it");
  });

  it("rejects edits to another file, empty or no-op edits, and overlapping edits", () => {
    const problems = (edits: Parameters<typeof applyEdits>[1]) => {
      const applied = applyEdits(target, edits);
      return applied.ok ? [] : applied.problems;
    };
    expect(problems([{ file: "lib/store/hardened.ts", find: "a", replace: "b" }])[0]).toContain("only lib/store/naive.ts may change");
    expect(problems([{ file: PATH, find: "", replace: "b" }])[0]).toContain("empty find");
    expect(problems([{ file: PATH, find: FAILED_LINE, replace: FAILED_LINE }])[0]).toContain("changes nothing");
    const overlapping = problems([
      { file: PATH, find: FAILED_LINE, replace: "x" },
      { file: PATH, find: 'result = { status: "FAILED"', replace: "y" },
    ]);
    expect(overlapping).toEqual(["Edits 1 and 2 change overlapping lines; merge them into one edit."]);
  });

  it("leaves the file as it is for no edits", () => {
    expect(applyEdits(target, [])).toEqual({ ok: true, source: SOURCE, patch: "" });
  });
});

describe("visibleIndent and unifiedDiff", () => {
  it("shows leading spaces and tabs, and nothing after them", () => {
    expect(visibleIndent("    a b")).toBe("····a b");
    expect(visibleIndent("\t  x")).toBe("→··x");
  });

  it("writes no diff for no change", () => {
    expect(unifiedDiff(PATH, "a\n", "a\n")).toBe("");
  });
});
