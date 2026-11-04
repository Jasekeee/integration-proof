import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fixCheck, fixesSummary, fixSha256 } from "./fix-check";

const results = JSON.parse(readFileSync("public/ai-fixes.json", "utf8"));

describe("fixCheck", () => {
  it("verifies only the exact patch the offline check passed", () => {
    const patch = readFileSync("fixtures/ai-fixes/S2.patch", "utf8");
    expect(results.scenarios.S2.verified).toBe(true);
    expect(fixCheck("S2", patch)).toMatchObject({ verified: true, before: "FAIL", after: "PASS", reason: null });
    // The model's text without its final newline is the same patch.
    expect(fixCheck("S2", patch.replace(/\n$/, ""))?.verified).toBe(true);
  });

  it("never verifies a patch that differs by a single character", () => {
    const patch = readFileSync("fixtures/ai-fixes/S2.patch", "utf8").replace("retry <= 3", "retry <= 4");
    expect(fixCheck("S2", patch)).toMatchObject({ verified: false, reason: "this patch was not part of the offline check" });
  });

  it("says why a checked patch is not verified", () => {
    for (const [id, scenario] of Object.entries(results.scenarios) as [string, { verified: boolean }][]) {
      if (scenario.verified) continue;
      const check = fixCheck(id, readFileSync(`fixtures/ai-fixes/${id}.patch`, "utf8"));
      expect(check?.verified).toBe(false);
      expect(check?.reason).toMatch(/does not apply|type-check|still gives/);
    }
  });

  it("hashes a patch the way the export names its file", () => {
    expect(fixSha256("a\n")).toBe(fixSha256("a"));
    expect(fixSha256(readFileSync("fixtures/ai-fixes/S3.patch", "utf8"))).toBe(results.scenarios.S3.patchSha256);
  });

  it("summarises the check for the landing page", () => {
    expect(fixesSummary()).toEqual({ verified: results.verified, total: 5, report: results.report });
  });
});
