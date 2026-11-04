import { describe, expect, it } from "vitest";
import { checkPatch, recountHunks } from "./patch";
import { analysisKey, normalizeIds, traceSignature, volatileIds, type SignatureStep } from "./signature";

const TARGET = { path: "lib/store/naive.ts", source: "a\nb\nc\nd\ne\n" };
const header = "--- a/lib/store/naive.ts\n+++ b/lib/store/naive.ts\n";

describe("recountHunks", () => {
  it("rewrites wrong line counts from the hunk's own lines, as git apply --recount does", () => {
    const { patch, changed } = recountHunks(`${header}@@ -2,9 +2,9 @@\n b\n-c\n+C\n d\n`);
    expect(changed).toBe(true);
    expect(patch).toContain("@@ -2,3 +2,3 @@");
  });

  it("reads an empty line inside a hunk as an empty context line", () => {
    const { patch } = recountHunks(`${header}@@ -1,2 +1,2 @@\n a\n\n-c\n+C\n`);
    expect(patch).toContain("@@ -1,3 +1,3 @@\n a\n \n-c");
  });

  it("leaves a correct patch as it is", () => {
    const correct = `${header}@@ -2,3 +2,3 @@\n b\n-c\n+C\n d\n`;
    expect(recountHunks(correct)).toEqual({ patch: correct, changed: false });
  });
});

describe("checkPatch", () => {
  it("applies a patch to the target file", () => {
    const result = checkPatch(`${header}@@ -2,3 +2,3 @@\n b\n-c\n+C\n d\n`, TARGET);
    expect(result).toMatchObject({ status: "applies", note: "Applies cleanly to lib/store/naive.ts." });
  });

  it("says when it recounted the hunk headers", () => {
    expect(checkPatch(`${header}@@ -2,7 +2,7 @@\n b\n-c\n+C\n d\n`, TARGET).note).toContain("recounted");
  });

  it("finds the hunk when the line number in its header is off", () => {
    expect(checkPatch(`${header}@@ -40,3 +40,3 @@\n b\n-c\n+C\n d\n`, TARGET).status).toBe("applies");
  });

  it("needs review when the context does not match the file", () => {
    const result = checkPatch(`${header}@@ -2,3 +2,3 @@\n b\n-x\n+C\n d\n`, TARGET);
    expect(result.status).toBe("needs_review");
    expect(result.note).toContain("context lines do not match");
  });

  it("needs review when the patch changes any other file", () => {
    const other = "--- a/lib/store/shared.ts\n+++ b/lib/store/shared.ts\n@@ -1,1 +1,1 @@\n-a\n+A\n";
    expect(checkPatch(other, TARGET)).toMatchObject({ status: "needs_review", note: expect.stringContaining("lib/store/shared.ts") });
  });

  it("needs review when the text is not a diff", () => {
    expect(checkPatch("Replace the else branch with a GET order call.", TARGET).status).toBe("needs_review");
  });

  it("reports no patch when there is none", () => {
    expect(checkPatch("  ", TARGET)).toEqual({ status: "none", patch: "", note: null });
  });
});

describe("traceSignature", () => {
  const steps = (orderId: string, status = 201): SignatureStep[] => [
    { seq: 1, actor: "buyer", method: "POST", path: "/api/store/naive/orders", httpStatus: 201, fault: null, responseBody: { status: "CREATED", id: orderId } },
    { seq: 2, actor: "store", method: "POST", path: `/v2/checkout/orders/${orderId}/capture`, httpStatus: status, fault: "Response held 10000 ms", responseBody: { status: "COMPLETED" } },
    { seq: 3, actor: "runner", method: "GET", path: `/api/store/naive/state?cartId=cart-${orderId}&runId=x`, httpStatus: 200, fault: null, responseBody: null },
  ];

  it("is the same for two runs that behave the same with different ids", () => {
    const a = traceSignature(steps("5O190127TN364715T"), "FAIL", "Order 5O190127TN364715T was fulfilled 2 times.");
    const b = traceSignature(steps("8VC12345AB678901C"), "FAIL", "Order 8VC12345AB678901C was fulfilled 2 times.");
    expect(a).toBe(b);
  });

  it("changes when the behaviour changes", () => {
    expect(traceSignature(steps("5O190127TN364715T"), "FAIL", "r")).not.toBe(
      traceSignature(steps("5O190127TN364715T", 500), "FAIL", "r"),
    );
  });

  it("puts the model into the cache key", () => {
    const parts = { scenarioId: "S3", codeHash: "c", traceSignature: "t" };
    expect(analysisKey({ ...parts, model: "claude-sonnet-5-5" })).not.toBe(analysisKey({ ...parts, model: "claude-opus-5-5" }));
  });

  it("finds and replaces PayPal ids and event ids", () => {
    const text = "order 5O190127TN364715T, event WH-57978953CM9578545-2UJ006074H900403L";
    expect(normalizeIds(text)).toBe("order <id>, event <id>");
    expect(volatileIds(text).sort()).toEqual(["5O190127TN364715T", "WH-57978953CM9578545-2UJ006074H900403L"]);
  });
});
