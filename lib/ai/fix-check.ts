// Whether a fix the page shows is one the offline check verified. The result comes from
// public/ai-fixes.json, written by scripts/verify-ai-fixes.ts from committed patches. The server
// only reads that file: model-generated code never runs here.
import { createHash } from "node:crypto";
import { z } from "zod";
import results from "../../public/ai-fixes.json";

const VerdictSchema = z.enum(["PASS", "FAIL", "INCONCLUSIVE", "ERROR", "not run"]);

const ResultsSchema = z.object({
  report: z.url(),
  controls: z.object({ reproducesLive: z.boolean() }),
  verified: z.number(),
  total: z.number(),
  scenarios: z.record(
    z.string(),
    z.object({
      patchSha256: z.string(),
      verified: z.boolean(),
      applies: z.boolean(),
      typechecks: z.boolean().nullable(),
      before: VerdictSchema,
      after: VerdictSchema,
    }),
  ),
});

/** Read once and checked like any input; a malformed file verifies nothing. */
const parsed = ResultsSchema.safeParse(results);
const checked = parsed.success ? parsed.data : null;

/** What the offline check said, if anything, about the fixes as a whole: "4/5". */
export function fixesSummary(): { verified: number; total: number; report: string } | null {
  return checked && checked.controls.reproducesLive
    ? { verified: checked.verified, total: checked.total, report: checked.report }
    : null;
}

/** The hash the export gives a patch file: the model's text, ending in a newline. */
export function fixSha256(patch: string): string {
  return createHash("sha256").update(patch.endsWith("\n") ? patch : `${patch}\n`).digest("hex");
}

export interface FixCheck {
  verified: boolean;
  before: string | null;
  after: string | null;
  /** Why a fix is not verified, in plain words; null when it is. */
  reason: string | null;
  report: string;
}

/** The offline verdict for this exact patch, or "not verified" when this patch was never checked. */
export function fixCheck(scenarioId: string, patch: string | undefined): FixCheck | null {
  if (!checked || !patch) return null;
  const scenario = checked.scenarios[scenarioId];
  const report = checked.report;
  if (!scenario || scenario.patchSha256 !== fixSha256(patch)) {
    return { verified: false, before: null, after: null, reason: "this patch was not part of the offline check", report };
  }
  if (scenario.verified) return { verified: true, before: scenario.before, after: scenario.after, reason: null, report };
  const reason = !scenario.applies
    ? "the patch does not apply to the store file"
    : scenario.typechecks === false
      ? "the patched store does not type-check"
      : `the patched store still gives ${scenario.after}`;
  return { verified: false, before: scenario.before, after: scenario.after, reason, report };
}
