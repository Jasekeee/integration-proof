// --explain: Claude explains the failed scenarios in the store's own code, through the same analyst
// as the hosted proof (lib/ai/analyst.ts): the same output schema, evidence that must cite real trace
// steps, edits that must quote the store's files exactly once, one self-correction round, and the
// same guard around the untrusted trace. Nothing is sent without --explain, the files that go are
// listed before they do, and the CLI never applies or runs what the model writes: it can only write
// a patch for the developer to review and apply.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { analyze, analystSystemPrompt, type AnalystClient, type AnalystResult } from "../lib/ai/analyst";
import { applyEdits, unifiedDiff } from "../lib/ai/edits";
import type { SourceFile } from "../lib/ai/sources";
import { REDACTED } from "../lib/proof/redact";
import { SCENARIOS } from "../lib/proof/scenarios";
import type { ScenarioResult } from "./run";

/** One file larger than this is left out. */
export const FILE_CAP_BYTES = 100_000;
/** Everything sent for one analysis together; above it nothing is sent. */
export const TOTAL_CAP_BYTES = 300_000;

/** Source code the analyst can read. Anything else, configuration and data included, stays home. */
const SOURCE_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx",
  ".py", ".rb", ".php", ".go", ".java", ".kt", ".cs", ".rs", ".swift", ".scala",
]);
const SKIPPED_DIRECTORIES = new Set([
  "node_modules", ".git", ".next", "dist", "build", "out", "coverage", ".turbo", ".vercel", "vendor", "__pycache__", "target",
]);
const LOCKFILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "composer.lock", "Gemfile.lock", "poetry.lock", "Cargo.lock"]);

export interface SelectedSources {
  files: (SourceFile & { bytes: number })[];
  skipped: { path: string; reason: string }[];
  totalBytes: number;
  /** Secret-looking values replaced before anything is sent. */
  redactions: number;
}

/** Why a file is never sent, or null when it may be. */
function exclusion(file: string, bytes: number): string | null {
  const name = path.basename(file);
  if (name.startsWith(".env")) return "environment file";
  if (LOCKFILES.has(name)) return "lockfile";
  if (/\.(pem|key|p12|pfx|crt|cer|der|jks|keystore)$/i.test(name) || /^id_(rsa|ed25519|ecdsa)/.test(name)) return "key or certificate";
  if (!SOURCE_EXTENSIONS.has(path.extname(name).toLowerCase())) return "not source code";
  if (bytes > FILE_CAP_BYTES) return `over ${FILE_CAP_BYTES / 1000} KB`;
  return null;
}

/** Values that look like secrets in source code, each replaced by [REDACTED]. */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9_-]{10,}/g,
  /\bA21AA[A-Za-z0-9_-]{20,}/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{30,}/g,
  /\bBearer\s+[A-Za-z0-9._~+\/=-]{20,}/g,
  /\bBasic\s+[A-Za-z0-9+\/=]{20,}/g,
];
/** A string literal assigned to a name that says it is a secret: password = "…", clientSecret: '…'. */
const SECRET_ASSIGNMENT =
  /((?:secret|password|passwd|token|api[_-]?key|private[_-]?key|client[_-]?secret|access[_-]?key)[A-Za-z0-9_]*["']?\s*[:=]\s*)(["'`])([^"'`\n]{6,})\2/gi;
/** 13 to 19 digits that pass the Luhn check: a card number. */
const CARD_CANDIDATE = /\b(?:\d[ -]?){12,18}\d\b/g;

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) digit = digit * 2 > 9 ? digit * 2 - 9 : digit * 2;
    sum += digit;
  }
  return sum % 10 === 0;
}

/** The same rule as the trace: card data and credentials never leave the machine. */
export function redactSource(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, () => {
      count++;
      return REDACTED;
    });
  }
  out = out.replace(SECRET_ASSIGNMENT, (match, prefix: string, quote: string, value: string) => {
    if (value === REDACTED || /^process\.env|^\$\{/.test(value)) return match;
    count++;
    return `${prefix}${quote}${REDACTED}${quote}`;
  });
  out = out.replace(CARD_CANDIDATE, (match) => {
    const digits = match.replace(/[ -]/g, "");
    if (digits.length < 13 || digits.length > 19 || !luhn(digits)) return match;
    count++;
    return REDACTED;
  });
  return { text: out, count };
}

/** Every file under `entry`; dependency and build directories are noted, not entered. */
function walk(entry: string, found: string[], skippedDirectories: string[]): void {
  const stat = statSync(entry);
  if (stat.isDirectory()) {
    if (SKIPPED_DIRECTORIES.has(path.basename(entry))) {
      skippedDirectories.push(entry);
      return;
    }
    for (const child of readdirSync(entry).sort()) walk(path.join(entry, child), found, skippedDirectories);
  } else if (stat.isFile()) {
    found.push(entry);
  }
}

/** The files --source names, with what is left out and why. Paths are relative to `cwd`. */
export function selectSources(sources: string[], cwd = process.cwd()): SelectedSources {
  const all: string[] = [];
  const skippedDirectories: string[] = [];
  for (const source of sources) walk(path.resolve(cwd, source), all, skippedDirectories);
  const relative = (file: string) => path.relative(cwd, file).split(path.sep).join("/");
  const selected: SelectedSources = { files: [], skipped: [], totalBytes: 0, redactions: 0 };
  for (const directory of [...new Set(skippedDirectories)]) {
    selected.skipped.push({ path: `${relative(directory)}/`, reason: "dependencies or build output" });
  }
  for (const file of [...new Set(all)]) {
    const bytes = statSync(file).size;
    const reason = exclusion(file, bytes);
    if (reason) {
      selected.skipped.push({ path: relative(file), reason });
      continue;
    }
    const redacted = redactSource(readFileSync(file, "utf8"));
    selected.redactions += redacted.count;
    selected.files.push({ path: relative(file), content: redacted.text, bytes: Buffer.byteLength(redacted.text), kind: "source" });
    selected.totalBytes += Buffer.byteLength(redacted.text);
  }
  return selected;
}

/** The file a patch may change: the one named, the only one, or the one with the capture call. */
export function chooseTarget(files: SourceFile[], named?: string): { target: SourceFile } | { error: string } {
  if (named) {
    const normal = named.replace(/^\.\//, "");
    const found = files.find((file) => file.path === normal);
    return found ? { target: found } : { error: `--target ${named} is not among the files --source selected.` };
  }
  if (files.length === 1) return { target: files[0] };
  const capturing = files.filter((file) => /\/capture\b/.test(file.content));
  if (capturing.length === 1) return { target: capturing[0] };
  return {
    error:
      capturing.length === 0
        ? "No selected file calls PayPal's capture; name the file with the store's capture code with --target."
        : `Several files mention a capture (${capturing.map((file) => file.path).join(", ")}); name one with --target.`,
  };
}

/** The configuration variables the code reads, by name only, as the analyst's <environment>. */
export function environmentNames(files: SourceFile[]): string {
  const names = new Set<string>();
  const patterns = [/process\.env\.([A-Z][A-Z0-9_]*)/g, /process\.env\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g, /os\.environ(?:\.get)?[\[(]\s*["']([A-Z][A-Z0-9_]*)["']/g, /getenv\(\s*["']([A-Z][A-Z0-9_]*)["']/g];
  for (const file of files) for (const pattern of patterns) for (const match of file.content.matchAll(pattern)) names.add(match[1]);
  return [...names].sort().map((name) => `${name}=`).join("\n") || "(none found)";
}

/** How the store's own files reach the analyst, in place of the reference stores' declarations. */
const OWN_STORE_SOURCE =
  'the store\'s real code, sent by its owner. The file with target="true" is the one under test, in full, and the only file a patch may change. Files with kind="source" are other files of the same store, in full and read-only; use what they define as it is written there. Values that looked like secrets were replaced with [REDACTED] before sending; never quote or change such a line. <environment> lists the configuration variables the code reads, with no values; use these names rather than inventing configuration.';

export interface Explanation {
  id: ScenarioResult["id"];
  status: "READY" | "UNAVAILABLE";
  result: AnalystResult;
  /** The fix as a diff of the store's real file, when its edits apply to it exactly. */
  patch: string;
  /** Why there is no patch, or what to know about it. */
  note: string | null;
}

/** Claude's analysis of each failed scenario. The verdicts are never changed. */
export async function explainFailures(input: {
  failures: ScenarioResult[];
  sources: SelectedSources;
  target: SourceFile;
  /** The store's base URL, for how the scenario names the code under test. */
  store: URL;
  client: AnalystClient;
  model: string;
  cwd?: string;
}): Promise<Explanation[]> {
  const cwd = input.cwd ?? process.cwd();
  const context = input.sources.files.filter((file) => file.path !== input.target.path).map(({ path: file, content, kind }) => ({ path: file, content, kind }));
  const sources = { target: { path: input.target.path, content: input.target.content }, context, environment: environmentNames(input.sources.files), hash: "" };
  const explanations: Explanation[] = [];
  for (const failure of input.failures) {
    const scenario = SCENARIOS[failure.id];
    const result = await analyze(
      {
        scenario: {
          id: scenario.id,
          title: scenario.title,
          summary: scenario.summary,
          passWhen: scenario.passWhen,
          storeFunction: `the code that answers POST ${input.store.pathname.replace(/\/$/, "")}/orders/{orderId}/capture`,
        },
        storeLabel: "the store under test",
        verdict: "FAIL",
        reason: failure.reason,
        steps: failure.steps.map((step) => ({
          seq: step.seq,
          actor: step.actor,
          method: step.method,
          path: step.path,
          httpStatus: step.httpStatus,
          debugId: step.debugId,
          paypalRequestId: step.paypalRequestId,
          fault: step.fault,
          note: step.note,
          requestBody: step.requestBody,
          responseBody: step.responseBody,
        })),
        sources,
      },
      { client: input.client, model: input.model, system: analystSystemPrompt(OWN_STORE_SOURCE) },
    );
    explanations.push({ id: failure.id, status: result.status, result, ...realPatch(result, input.target.path, cwd) });
  }
  return explanations;
}

/**
 * The analyst checked the edits against the file as it was sent, redactions included. The patch is
 * built again from the real file on disk, so it is a diff the developer can apply as it is.
 */
function realPatch(result: AnalystResult, target: string, cwd: string): { patch: string; note: string | null } {
  if (result.status !== "READY") return { patch: "", note: result.reason };
  if (!result.analysis.fix.selfCheck?.matched) return { patch: "", note: result.patch.note };
  const edits = result.analysis.fix.edits ?? [];
  if (edits.length === 0) return { patch: "", note: "Claude proposed no change to the target file." };
  const applied = applyEdits({ path: target, source: readFileSync(path.resolve(cwd, target), "utf8") }, edits);
  if (!applied.ok) return { patch: "", note: `The edits do not apply to the file on disk: ${applied.problems.join(" ")}` };
  return { patch: applied.patch, note: result.patch.note };
}

/**
 * One patch for every failure, applied in scenario order to the real file. An analysis whose edits
 * no longer apply after an earlier one is left out and named, never merged by guesswork.
 */
export function combinedPatch(explanations: Explanation[], target: string, cwd = process.cwd()): { patch: string; included: string[]; left: string[] } {
  const original = readFileSync(path.resolve(cwd, target), "utf8");
  let source = original;
  const included: string[] = [];
  const left: string[] = [];
  for (const explanation of explanations) {
    if (!explanation.patch || explanation.result.status !== "READY") continue;
    const applied = applyEdits({ path: target, source }, explanation.result.analysis.fix.edits ?? []);
    if (applied.ok) {
      source = applied.source;
      included.push(explanation.id);
    } else {
      left.push(explanation.id);
    }
  }
  return { patch: unifiedDiff(target, original, source), included, left };
}
