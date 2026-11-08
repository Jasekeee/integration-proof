#!/usr/bin/env -S npx tsx
// integration-proof run: proves a PayPal Checkout integration that implements the store contract
// (docs/store-contract.md) against the checkout scenarios S1–S3, from this machine.
//
//   npm run cli -- run --store http://localhost:4000/integration-proof
//
// Exit code: 0 when every verdict is as expected (--expect), or every scenario passed; 1 when not;
// 2 when the run could not start.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { SANDBOX_API_BASE } from "../lib/paypal/client";
import { CONTRACT_SCENARIOS, type ContractScenarioId } from "./contract";
import { installModel } from "./model";
import { startProxy } from "./proxy";
import { chooseTarget, combinedPatch, explainFailures, selectSources, TOTAL_CAP_BYTES, type SelectedSources } from "./explain";
import { buildReport, consoleLines, explanationLines, explanationMarkdown, markdown, parseExpectations } from "./report";
import { runScenarios } from "./run";

const USAGE = `Usage: npm run cli -- run --store <url> [options]

  --store <url>          The store's contract base URL, its prefix included,
                         e.g. http://localhost:4000/integration-proof
  --paypal <mode>        sandbox (default): the PayPal sandbox, with PAYPAL_CLIENT_ID and
                         PAYPAL_CLIENT_SECRET of the store's own sandbox app.
                         model: an offline model of the sandbox; no credentials, no network.
  --proxy-port <port>    Port of the local proxy the store sends its PayPal calls to (default 8787).
  --hold-ms <ms>         How long S3 holds PayPal's capture answer (default 35000, at most 120000).
                         Must be longer than the store's own PayPal timeout.
  --scenarios <list>     Which of S1,S2,S3 to run (default all).
  --expect <list>        Expected verdicts, e.g. S1=PASS,S2=FAIL,S3=FAIL.
  --out <dir>            Where report.json and summary.md go (default integration-proof-report).
  --env-file <path>      Load environment variables from a file first.

Claude's analysis of the failures (opt-in; nothing is sent without --explain):
  --explain              Ask Claude why each failed scenario failed, in the store's own code.
                         Needs ANTHROPIC_API_KEY and --source.
  --source <path>        A file or directory of the store's code; repeatable. Only source files
                         go, after secret-looking values are redacted; .env files, keys, lockfiles,
                         dependencies, build output and files over 100 KB never do. The list is
                         printed before anything is sent.
  --target <file>        The file a fix may change (default: the one with the capture call).
  --write-patch <file>   Write Claude's checked fix as a unified diff, for you to review and apply
                         with git apply. The CLI never applies or runs it.
  --model <id>           The Claude model (default: ANTHROPIC_MODEL, else claude-sonnet-5-5).

Before the run, start the store with its PayPal base URL set to the proxy, http://127.0.0.1:<proxy-port>.`;

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      store: { type: "string" },
      paypal: { type: "string", default: "sandbox" },
      "proxy-port": { type: "string", default: "8787" },
      "hold-ms": { type: "string", default: "35000" },
      scenarios: { type: "string", default: CONTRACT_SCENARIOS.join(",") },
      expect: { type: "string" },
      out: { type: "string", default: "integration-proof-report" },
      "env-file": { type: "string" },
      explain: { type: "boolean", default: false },
      source: { type: "string", multiple: true },
      target: { type: "string" },
      "write-patch": { type: "string" },
      model: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (positionals[0] !== "run") fail("The only command is run.");
  if (values["env-file"]) process.loadEnvFile(values["env-file"]);

  let store: URL;
  try {
    store = new URL(values.store ?? "");
  } catch {
    fail("--store needs the store's contract base URL.");
  }
  if (store.protocol !== "http:" && store.protocol !== "https:") fail("--store must be an http or https URL.");
  const mode = values.paypal;
  if (mode !== "sandbox" && mode !== "model") fail("--paypal is sandbox or model.");
  const holdMs = Number(values["hold-ms"]);
  if (!Number.isInteger(holdMs) || holdMs < 100 || holdMs > 120_000) fail("--hold-ms is a whole number from 100 to 120000.");
  const port = Number(values["proxy-port"]);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) fail("--proxy-port is a port number.");
  const scenarios = values.scenarios.split(",").map((id) => id.trim().toUpperCase());
  const unknown = scenarios.filter((id) => !(CONTRACT_SCENARIOS as readonly string[]).includes(id));
  if (unknown.length > 0) fail(`Contract v1 covers S1, S2 and S3; not ${unknown.join(", ")}.`);
  let expected;
  try {
    expected = parseExpectations(values.expect);
  } catch (error) {
    fail((error as Error).message);
  }

  // Claude only with --explain, and only with a store's sources to read.
  let explain: { sources: SelectedSources; targetPath: string; apiKey: string; model: string } | null = null;
  if (values["write-patch"] && !values.explain) fail("--write-patch needs --explain.");
  if (values.explain) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) fail("--explain needs ANTHROPIC_API_KEY.");
    if (!values.source?.length) fail("--explain needs --source: the store's code for Claude to read.");
    let sources: SelectedSources;
    try {
      sources = selectSources(values.source);
    } catch (error) {
      fail(`--source could not be read: ${(error as Error).message}`);
    }
    if (sources.files.length === 0) fail("--source selected no source file.");
    if (sources.totalBytes > TOTAL_CAP_BYTES) {
      fail(`--source selected ${sources.totalBytes} bytes, more than the ${TOTAL_CAP_BYTES} that may be sent. Point it at the store's checkout code only.`);
    }
    const chosen = chooseTarget(sources.files, values.target);
    if ("error" in chosen) fail(chosen.error);
    explain = { sources, targetPath: chosen.target.path, apiKey, model: values.model ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5" };
  } else if (values.source?.length) {
    console.log("--source is read only with --explain; nothing will be sent anywhere.");
  }

  // The CLI's own PayPal calls go to the sandbox only (lib/paypal/client.ts); the token reads this.
  process.env.PAYPAL_API_BASE = SANDBOX_API_BASE;
  const model = mode === "model" ? installModel() : null;
  if (!model && (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET)) {
    fail("--paypal sandbox needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET of the store's sandbox app (or --paypal model).");
  }

  const proxy = await startProxy({ port, holdMs }).catch((error: Error) => fail(`The proxy could not start on port ${port}: ${error.message}`));
  console.log(`Integration Proof · contract v1 · PayPal ${mode} · proxy ${proxy.url} · store ${store.href}`);
  const startedAt = new Date();
  try {
    const results = await runScenarios({
      store,
      scenarios: scenarios as ContractScenarioId[],
      proxy,
      holdMs,
      buyerTimeoutMs: Math.max(90_000, holdMs + 30_000),
    });
    const report = buildReport({
      store: store.href,
      paypal: mode,
      holdMs,
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      expected,
      scenarios: results,
    });
    console.log(`\n${consoleLines(report).join("\n")}`);
    const failures = results.filter((result) => result.verdict === "FAIL");
    if (explain && failures.length === 0) console.log("\nNo scenario failed, so nothing was sent to Claude.");
    if (explain && failures.length > 0) {
      const { sources } = explain;
      console.log(`\nClaude (${explain.model}) will now receive, for each of ${failures.map((failure) => failure.id).join(", ")}:`);
      for (const file of sources.files) console.log(`  ${file.path}  ${file.bytes} bytes${file.path === explain.targetPath ? "  (target: the only file a fix may change)" : ""}`);
      console.log(`  ${sources.totalBytes} bytes of source in all, with ${sources.redactions} secret-looking value${sources.redactions === 1 ? "" : "s"} redacted;`);
      console.log("  plus the scenario, its verdict and its redacted trace. Nothing else.");
      for (const skipped of sources.skipped) console.log(`  not sent: ${skipped.path} (${skipped.reason})`);
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey: explain.apiKey, timeout: 180_000, maxRetries: 2 });
      const target = sources.files.find((file) => file.path === explain.targetPath)!;
      const items = await explainFailures({ failures, sources, target, store, client, model: explain.model });
      report.explanations = { model: explain.model, items };
      console.log(`\n${explanationLines(report).join("\n")}`);
      if (values["write-patch"]) {
        const combined = combinedPatch(items, explain.targetPath);
        if (combined.patch) {
          writeFileSync(values["write-patch"], combined.patch);
          console.log(`\nPatch for ${combined.included.join(", ")} written to ${values["write-patch"]}. Review it, then apply it yourself: git apply ${values["write-patch"]}`);
        } else {
          console.log("\nNo checked patch to write.");
        }
        if (combined.left.length > 0) console.log(`Left out of the patch, because their edits overlap an earlier fix: ${combined.left.join(", ")}. Run again after applying it.`);
      }
    }
    if (model && model.model.violations.length > 0) {
      console.warn(`The store made PayPal calls the model does not cover:\n  ${model.model.violations.join("\n  ")}`);
    }
    mkdirSync(values.out, { recursive: true });
    writeFileSync(path.join(values.out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    const summary = [markdown(report), explanationMarkdown(report)].filter(Boolean).join("\n");
    writeFileSync(path.join(values.out, "summary.md"), summary);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
    console.log(`\nReport: ${path.join(values.out, "report.json")}`);
    process.exitCode = report.ok ? 0 : 1;
  } finally {
    await proxy.close();
    model?.restore();
  }
}

void main();
