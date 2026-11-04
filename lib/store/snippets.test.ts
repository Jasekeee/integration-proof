import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SCENARIO_IDS } from "../proof/scenarios";
import { extractSnippets, readSnippets } from "./snippets";

const FIXTURE = [
  "export const store = {",
  "  async capture() {",
  "    // [S2] Fix: a 5xx is retried, and every attempt",
  "    // sends the same key.",
  "    for (let attempt = 1; attempt <= 3; attempt++) {",
  "      // An inner comment stays in the code.",
  "      if (transient) continue;",
  "",
  "      // [S1] a decline is final.",
  "      if (declined) return save();",
  "      if (rejected) return fail();",
  "    }",
  "  },",
  "};",
].join("\n");

describe("extractSnippets", () => {
  const snippets = extractSnippets(FIXTURE, "lib/store/fixture.ts");

  it("takes the caption from the marker and the comment lines after it, without a leading Fix:", () => {
    expect(snippets.S2.caption).toBe("A 5xx is retried, and every attempt sends the same key.");
    expect(snippets.S1.caption).toBe("A decline is final.");
  });

  it("ends a snippet at the next blank line, dedented, with its line numbers", () => {
    expect(snippets.S2.code).toBe(
      [
        "for (let attempt = 1; attempt <= 3; attempt++) {",
        "  // An inner comment stays in the code.",
        "  if (transient) continue;",
      ].join("\n"),
    );
    expect(snippets.S2.lines).toEqual([5, 7]);
    expect(snippets.S2.file).toBe("lib/store/fixture.ts");
  });

  it("ends a snippet at the first line indented less than its marker", () => {
    expect(snippets.S1.code).toBe("if (declined) return save();\nif (rejected) return fail();");
    expect(snippets.S1.lines).toEqual([10, 11]);
  });

  it("rejects a scenario marked twice and a marker with no code", () => {
    expect(() => extractSnippets("// [S1] a\nx();\n// [S1] b\ny();", "f.ts")).toThrow("marked twice");
    expect(() => extractSnippets("  // [S1] a\n\nx();", "f.ts")).toThrow("no code");
  });

  it("finds nothing in a file without markers", () => {
    expect(extractSnippets("const a = 1; // [not a marker]\n", "f.ts")).toEqual({});
  });
});

/**
 * The proof page shows these lines next to a PASS. When a store file is edited, the markers must
 * still sit on the code that decides each scenario.
 */
describe("markers in the store files", () => {
  const EXPECTED: Record<string, string[]> = {
    S1: ['"declined"', '"DECLINED"'],
    S2: ["backoffMs", "requestId", '"transient") continue'],
    S3: ["getOrder", "reconciliationFrom", '"unknown"'],
    S4: ["isEventProcessed(event.id)", '"duplicate"'],
    S5: ["getOrder", "reconciliationFrom"],
    S6: ["verifyWebhookSignature", "httpStatus: 400"],
  };

  it("mark every scenario in the hardened store, once, on 3 to 6 lines of the code that decides it", async () => {
    const { hardened } = await readSnippets();
    expect(Object.keys(hardened).sort()).toEqual([...SCENARIO_IDS]);
    for (const id of SCENARIO_IDS) {
      const snippet = hardened[id];
      const lineCount = snippet.code.split("\n").length;
      expect(lineCount, id).toBeGreaterThanOrEqual(3);
      expect(lineCount, id).toBeLessThanOrEqual(6);
      expect(snippet.lines[1] - snippet.lines[0] + 1, id).toBe(lineCount);
      for (const token of EXPECTED[id]) expect(snippet.code, `${id} shows ${token}`).toContain(token);
      expect(snippet.caption.length, id).toBeLessThanOrEqual(120);
    }
  });

  it("point at the real lines of lib/store/hardened.ts", async () => {
    const { hardened } = await readSnippets();
    const file = readFileSync("lib/store/hardened.ts", "utf8").split("\n");
    for (const id of SCENARIO_IDS) {
      const [first, last] = hardened[id].lines;
      const original = file.slice(first - 1, last).map((line) => line.trim());
      expect(hardened[id].code.split("\n").map((line) => line.trim()), id).toEqual(original);
    }
  });

  it("mark the decline in the naive store, the one scenario it passes", async () => {
    const { naive } = await readSnippets();
    expect(Object.keys(naive)).toEqual(["S1"]);
    expect(naive.S1.code).toContain('"DECLINED"');
  });
});
