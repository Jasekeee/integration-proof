/**
 * Checks whether Claude's committed fixes turn each failure into a pass, offline.
 *
 *   npx tsx scripts/verify-ai-fixes.ts           writes docs/ai-fixes-report.md and public/ai-fixes.json
 *   npx tsx scripts/verify-ai-fixes.ts --check   exits 1 when either file differs from the result (CI)
 *
 * For each of S2 to S6, with the patch saved by scripts/export-ai-fixes.ts:
 *   a. the naive store as committed must FAIL the scenario on the bench, or the bench is wrong;
 *   b. the patch is applied to a copy of lib/store/naive.ts in a temporary checkout, and
 *      `tsc --noEmit` type-checks it with the rest of lib/;
 *   c. all six scenarios run against the patched store, and the scenario's verdict is recorded;
 *   d. the hardened store must PASS every scenario, as a control of the bench.
 *
 * The bench (bench/) is the real runner, routes, proxy, stores and assertions on an in-memory
 * PayPal model built from docs/sandbox-findings.md and an in-memory Postgres. Patched code runs only
 * here and in CI, from committed files, in a child process whose environment holds no secret and
 * whose network reaches nothing. It never runs on the server.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { applyPatch, createTwoFilesPatch, parsePatch } from "diff";
import { z } from "zod";
import type { BenchRun } from "../bench/harness";
import { checkPatch } from "../lib/ai/patch";

const run = promisify(execFile);

const REPO = path.resolve(__dirname, "..");
const TARGET = "lib/store/naive.ts";
const FIXTURES = "fixtures/ai-fixes";
const REPORT = "docs/ai-fixes-report.md";
const SITE_JSON = "public/ai-fixes.json";
const ALL = ["S1", "S2", "S3", "S4", "S5", "S6"];
const FIXED = ["S2", "S3", "S4", "S5", "S6"];
const REPORT_URL = "https://github.com/Jasekeee/integration-proof/blob/main/docs/ai-fixes-report.md";

/** What a store module may import. A patch that reaches for anything else is not run. */
const ALLOWED_IMPORTS = new Set([
  "node:crypto",
  "./repository",
  "./shared",
  "../paypal/client",
  "../paypal/orders",
  "../paypal/payments",
  "../paypal/token",
  "../paypal/webhooks",
]);

const MetaSchema = z.object({
  source: z.string(),
  runId: z.uuid(),
  runFinishedAt: z.string().nullable(),
  target: z.literal(TARGET),
  targetSha256: z.string(),
  scenarios: z.record(
    z.string(),
    z.object({
      patch: z.string(),
      headline: z.string().nullable(),
      model: z.string(),
      analyzedAt: z.string().nullable(),
      confidence: z.enum(["low", "medium", "high"]),
      patchStatus: z.string().nullable(),
      fixSummary: z.string(),
    }),
  ),
});

type Verdict = "PASS" | "FAIL" | "INCONCLUSIVE" | "ERROR" | "not run";

interface FixResult {
  id: string;
  headline: string | null;
  confidence: string;
  model: string;
  analyzedAt: string | null;
  patchSha256: string;
  applies: boolean;
  importsAllowed: boolean;
  typechecks: boolean | null;
  before: Verdict;
  after: Verdict;
  /** Verdicts of the other scenarios that differ from the store without the patch. */
  sideEffects: string[];
  verified: boolean;
  note: string;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function verdictOf(bench: BenchRun, id: string): Verdict {
  const scenario = bench.scenarios.find((row) => row.id === id);
  if (!scenario) return "not run";
  return scenario.verdict ?? (scenario.status === "ERROR" ? "ERROR" : "not run");
}

/** One bench run in a child process with an environment that holds no secret. */
async function bench(root: string, mode: "naive" | "hardened", work: string, label: string): Promise<BenchRun> {
  const out = path.join(work, `${label}.json`);
  await run(
    process.execPath,
    ["--import", "tsx", path.join(REPO, "bench/child.ts"), "--root", root, "--mode", mode, "--scenarios", ALL.join(","), "--out", out],
    {
      cwd: root,
      env: {
        NODE_ENV: "test",
        PATH: process.env.PATH ?? "",
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
        TSX_TSCONFIG_PATH: path.join(root, "tsconfig.json"),
      },
      timeout: 10 * 60_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const result = JSON.parse(readFileSync(out, "utf8")) as BenchRun;
  if (result.refused.length > 0) throw new Error(`${label}: the bench refused network requests: ${result.refused.join(", ")}`);
  return result;
}

/** A checkout of the app's source in a temporary folder, sharing node_modules with the repository. */
function checkout(work: string, name: string): string {
  const root = path.join(work, name);
  // public/ holds ai-fixes.json, which lib/ai/fix-check.ts imports.
  for (const entry of ["app", "lib", "public"]) cpSync(path.join(REPO, entry), path.join(root, entry), { recursive: true });
  for (const file of ["tsconfig.json", "package.json"]) cpSync(path.join(REPO, file), path.join(root, file));
  symlinkSync(path.join(REPO, "node_modules"), path.join(root, "node_modules"), "dir");
  writeFileSync(
    path.join(root, "tsconfig.verify.json"),
    JSON.stringify({
      extends: "./tsconfig.json",
      compilerOptions: { incremental: false, plugins: [] },
      include: ["lib/**/*.ts"],
      exclude: ["lib/**/*.test.ts", "node_modules"],
    }),
  );
  return root;
}

async function typecheck(root: string): Promise<{ ok: boolean; output: string }> {
  try {
    await run(process.execPath, [path.join(REPO, "node_modules/typescript/bin/tsc"), "--noEmit", "-p", "tsconfig.verify.json"], {
      cwd: root,
      env: { NODE_ENV: "test", PATH: process.env.PATH ?? "" },
      timeout: 5 * 60_000,
    });
    return { ok: true, output: "" };
  } catch (error) {
    const output = (error as { stdout?: string }).stdout ?? String(error);
    return { ok: false, output: output.split("\n").slice(0, 3).join(" ").trim() };
  }
}

/** Which hunk of a patch that does not apply fails, and on which line, for the report. */
function whyNotApplied(source: string, patch: string): string | null {
  const [file] = parsePatch(patch);
  const lines = new Set(source.split("\n"));
  const trimmed = new Set(source.split("\n").map((line) => line.trim()));
  for (const [index, hunk] of (file?.hunks ?? []).entries()) {
    if (applyPatch(source, { ...file, hunks: [hunk] }) !== false) continue;
    const missing = hunk.lines.find((line) => (line.startsWith(" ") || line.startsWith("-")) && !lines.has(line.slice(1)));
    if (!missing) return `hunk ${index + 1} of ${file.hunks.length} does not match the file at line ${hunk.oldStart}.`;
    const text = missing.slice(1);
    const where = trimmed.has(text.trim()) ? "the file has that line with other indentation" : "the file has no such line";
    return `in hunk ${index + 1} of ${file.hunks.length}, the line \`${text.trim()}\` is indented by ${text.length - text.trimStart().length} spaces, and ${where}.`;
  }
  return null;
}

function importsOf(source: string): string[] {
  const found = [...source.matchAll(/\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']|\brequire\s*\(\s*["']([^"']+)["']/g)];
  return found.map((match) => match[1] ?? match[2] ?? match[3]);
}

/** Verdict changes in scenarios other than the target, against the store without the patch. */
function sideEffects(before: BenchRun, after: BenchRun, target: string): string[] {
  return ALL.filter((id) => id !== target && verdictOf(before, id) !== verdictOf(after, id)).map(
    (id) => `${id} ${verdictOf(before, id)} → ${verdictOf(after, id)}`,
  );
}

async function verify(): Promise<{ report: string; json: string; problems: string[] }> {
  const meta = MetaSchema.parse(JSON.parse(readFileSync(path.join(REPO, FIXTURES, "meta.json"), "utf8")));
  const source = readFileSync(path.join(REPO, TARGET), "utf8");
  const work = mkdtempSync(path.join(tmpdir(), "verify-ai-fixes-"));
  const problems: string[] = [];
  try {
    // a and d: the bench must reproduce the live verdicts before it can judge a fix.
    const naive = await bench(REPO, "naive", work, "naive");
    const hardened = await bench(REPO, "hardened", work, "hardened");
    for (const control of [naive, hardened]) {
      if (control.violations.length > 0) problems.push(`${control.mode}: the PayPal model was asked for ${control.violations.join("; ")}`);
    }
    for (const id of FIXED) {
      if (verdictOf(naive, id) !== "FAIL") problems.push(`The naive store gives ${verdictOf(naive, id)} on ${id} on the bench, not FAIL.`);
    }
    for (const id of ALL) {
      if (verdictOf(hardened, id) !== "PASS") problems.push(`The hardened store gives ${verdictOf(hardened, id)} on ${id} on the bench, not PASS.`);
    }

    const results: FixResult[] = [];
    for (const id of FIXED) {
      const fixture = meta.scenarios[id];
      if (!fixture) throw new Error(`${FIXTURES}/meta.json has no entry for ${id}`);
      const patch = readFileSync(path.join(REPO, FIXTURES, fixture.patch), "utf8");
      const result: FixResult = {
        id,
        headline: fixture.headline,
        confidence: fixture.confidence,
        model: fixture.model,
        analyzedAt: fixture.analyzedAt,
        patchSha256: sha256(patch),
        applies: false,
        importsAllowed: false,
        typechecks: null,
        before: verdictOf(naive, id),
        after: "not run",
        sideEffects: [],
        verified: false,
        note: "",
      };
      results.push(result);

      // b. The same check the server runs on every analysis, then the patch itself.
      const check = checkPatch(patch, { path: TARGET, source });
      const patched = check.status === "applies" ? applyPatch(source, parsePatch(check.patch)[0]) : false;
      if (patched === false) {
        const detail = check.status === "needs_review" ? whyNotApplied(source, check.patch) : null;
        result.note = `${check.note ?? "The patch does not apply."}${detail ? ` Specifically, ${detail}` : ""} Patches are checked as written, with no whitespace fuzz, as on the server.`;
        continue;
      }
      result.applies = true;
      const outside = importsOf(patched).filter((specifier) => !ALLOWED_IMPORTS.has(specifier));
      if (outside.length > 0) {
        result.note = `Not run: the patch imports ${outside.join(", ")}, which a store does not use.`;
        continue;
      }
      result.importsAllowed = true;

      const root = checkout(work, id);
      writeFileSync(path.join(root, TARGET), patched);
      const types = await typecheck(root);
      result.typechecks = types.ok;
      if (!types.ok) {
        result.note = `tsc --noEmit fails: ${types.output}`;
        continue;
      }

      // c. Every scenario against the patched store; the target decides, the others show side effects.
      const after = await bench(root, "naive", work, `naive-${id}`);
      result.after = verdictOf(after, id);
      result.sideEffects = sideEffects(naive, after, id);
      if (after.violations.length > 0) {
        result.note = `Not counted: the patched store made calls the PayPal model does not cover: ${after.violations.join("; ")}.`;
        continue;
      }
      result.verified = result.before === "FAIL" && result.after === "PASS" && problems.length === 0;
      const scenario = after.scenarios.find((row) => row.id === id);
      result.note = result.verified
        ? `${scenario?.headline ?? "PASS"}.`
        : `The patched store still gives ${result.after}${scenario?.headline ? `: ${scenario.headline}` : ""}. ${scenario?.reason ?? scenario?.error ?? ""}`.trim();
    }

    return {
      report: renderReport(meta, source, naive, hardened, results, problems),
      json: renderJson(meta, naive, hardened, results, problems),
      problems,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function score(benchRun: BenchRun): string {
  return `${benchRun.scenarios.filter((row) => row.verdict === "PASS").length}/${benchRun.scenarios.length}`;
}

function yesNo(value: boolean | null): string {
  return value === null ? "not run" : value ? "yes" : "no";
}

function renderReport(
  meta: z.infer<typeof MetaSchema>,
  source: string,
  naive: BenchRun,
  hardened: BenchRun,
  results: FixResult[],
  problems: string[],
): string {
  const verified = results.filter((row) => row.verified).length;
  const model = [...new Set(results.map((row) => row.model))].join(", ");
  const lines = [
    "# Claude's fixes, verified offline",
    "",
    "<!-- Generated by `npx tsx scripts/verify-ai-fixes.ts`. Do not edit by hand. -->",
    "",
    `**${verified} of ${results.length}** fixes turn their failure into a pass.`,
    "",
    "Each fix is the patch Claude proposed for a failed scenario of the naive store. The check ran",
    "on the offline bench: the real runner, routes, fault-injection proxy, store code and assertions,",
    "against a deterministic model of PayPal built from the behaviour recorded in",
    "[sandbox findings](sandbox-findings.md), and an in-memory Postgres with the real migrations. It",
    "is not a run against the live sandbox. A call the model does not cover is refused, and a run that",
    "made one is not counted. Model-generated code runs only in this offline check and in CI, from the",
    "committed patches; it never runs on the server.",
    "",
    "## Source",
    "",
    `- Run: [${meta.runId}](${meta.source}), finished ${meta.runFinishedAt ?? "unknown"}`,
    `- Model: ${model}`,
    `- Patches: \`${FIXTURES}/\`, against \`${TARGET}\``,
    meta.targetSha256 === sha256(source)
      ? `- \`${TARGET}\` is unchanged since the patches were written.`
      : `- \`${TARGET}\` changed after the patches were written; they were applied to the current file.`,
    "",
    "## Controls",
    "",
    `- Naive store as committed: ${score(naive)} on the bench, the same as in the live sandbox.`,
    `- Hardened store: ${score(hardened)} on the bench.`,
    problems.length === 0 ? "- The bench reproduces the live verdicts, so it can judge a fix." : "- **The bench does not reproduce the live verdicts:**",
    ...problems.map((problem) => `  - ${problem}`),
    "",
    "## Results",
    "",
    "| Scenario | Patch applies | Types | Before | After | Other scenarios | Claude's confidence |",
    "|---|---|---|---|---|---|---|",
    ...results.map(
      (row) =>
        `| ${row.id} · ${row.headline ?? ""} | ${yesNo(row.applies)} | ${yesNo(row.typechecks)} | ${row.before} | ${row.after}${row.verified ? " ✓" : ""} | ${row.sideEffects.length > 0 ? row.sideEffects.join(", ") : "unchanged"} | ${row.confidence} |`,
    ),
    "",
    "## Notes",
    "",
    ...results.map((row) => `- **${row.id}**: ${row.verified ? "verified. " : "not verified. "}${row.note}`),
    "",
    "## Reproduce",
    "",
    "```",
    "npx tsx scripts/export-ai-fixes.ts   # saves the fixes of the latest naive run",
    "npx tsx scripts/verify-ai-fixes.ts   # writes this report and public/ai-fixes.json",
    "```",
    "",
  ];
  return lines.join("\n");
}

function renderJson(
  meta: z.infer<typeof MetaSchema>,
  naive: BenchRun,
  hardened: BenchRun,
  results: FixResult[],
  problems: string[],
): string {
  return `${JSON.stringify(
    {
      method: "Offline bench: the real runner and assertions on a deterministic PayPal model built from sandbox observations.",
      report: REPORT_URL,
      runId: meta.runId,
      controls: { naive: score(naive), hardened: score(hardened), reproducesLive: problems.length === 0 },
      verified: results.filter((row) => row.verified).length,
      total: results.length,
      scenarios: Object.fromEntries(
        results.map((row) => [
          row.id,
          {
            patchSha256: row.patchSha256,
            verified: row.verified,
            applies: row.applies,
            typechecks: row.typechecks,
            before: row.before,
            after: row.after,
            sideEffects: row.sideEffects,
            confidence: row.confidence,
          },
        ]),
      ),
    },
    null,
    2,
  )}\n`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { check: { type: "boolean", default: false } } });
  const { report, json, problems } = await verify();
  if (values.check) {
    const stale = [
      [REPORT, report],
      [SITE_JSON, json],
    ].filter(([file, content]) => {
      try {
        return readFileSync(path.join(REPO, file), "utf8") !== content;
      } catch {
        return true;
      }
    });
    if (stale.length > 0) {
      for (const [file, content] of stale) {
        let committed = "";
        try {
          committed = readFileSync(path.join(REPO, file), "utf8");
        } catch {
          // A missing file shows as all new lines.
        }
        console.error(createTwoFilesPatch(`${file} (committed)`, `${file} (this run)`, committed, content));
      }
      console.error(`Out of date: ${stale.map(([file]) => file).join(", ")}. Run npx tsx scripts/verify-ai-fixes.ts.`);
      process.exit(1);
    }
  } else {
    for (const [file, content] of [
      [REPORT, report],
      [SITE_JSON, json],
    ]) {
      mkdirSync(path.dirname(path.join(REPO, file)), { recursive: true });
      writeFileSync(path.join(REPO, file), content);
    }
  }
  console.log(report.split("## Notes")[0].trim());
  if (problems.length > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
