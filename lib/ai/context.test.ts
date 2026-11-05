import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { analystEnvironment, buildAnalystContext, SIGNATURE_FILES } from "./declarations";
import { analysisKey, sha256 } from "./signature";

describe("analyst context", () => {
  const committed = JSON.parse(readFileSync("lib/ai/context.generated.json", "utf8"));

  it("is up to date with the code; run `npm run analyst:context` when this fails", () => {
    expect(buildAnalystContext()).toEqual(committed);
  }, 30_000);

  it("holds declarations only: no function bodies and no hardened store", () => {
    const text = JSON.stringify(committed);
    expect(committed.signatures.map((item: { path: string }) => item.path)).toEqual(SIGNATURE_FILES);
    expect(text).not.toContain("hardenedStore");
    expect(text).not.toMatch(/=>\s*\{/);
  });

  it("names only the configuration the store code reads, without values, and no card number", () => {
    const variables = committed.environment.split("\n").filter((line: string) => /^#?\s*[A-Z][A-Z0-9_]*=/.test(line));
    expect(variables).toEqual(["PAYPAL_CLIENT_ID=", "PAYPAL_CLIENT_SECRET=", "PAYPAL_API_BASE=", "PAYPAL_WEBHOOK_ID="]);
    expect(committed.environment).not.toContain("SANDBOX_BUYER_EMAIL");
    expect(JSON.stringify(committed)).not.toContain("4012888888881881");
  });
});

describe("analyst environment", () => {
  const example = readFileSync(".env.example", "utf8");
  const sources = ["const id = process.env.PAYPAL_WEBHOOK_ID;", "Schema.parse(process.env) // PAYPAL_CLIENT_ID"];

  it("keeps the variables the store code reads, with their comments", () => {
    const environment = analystEnvironment(example, sources);
    expect(environment).toContain("PAYPAL_WEBHOOK_ID=");
    expect(environment).toContain("# Client ID of the PayPal sandbox app");
    expect(environment).not.toContain("DATABASE_URL");
  });

  it("does not change, and neither does the analysis cache key, when an unrelated variable is added", () => {
    const extended = `${example}\n# A variable only a page reads.\nSOME_PAGE_SETTING=value\n`;
    expect(analystEnvironment(extended, sources)).toBe(analystEnvironment(example, sources));
    const key = (environment: string) =>
      analysisKey({ scenarioId: "S3", model: "m", codeHash: sha256(JSON.stringify(["store", environment])), traceSignature: "t" });
    expect(key(analystEnvironment(extended, sources))).toBe(key(analystEnvironment(example, sources)));
  });

  it("changes when a variable the store code reads is added", () => {
    const extended = `${example}\n# Read by the store.\nPAYPAL_NEW_SETTING=\n`;
    expect(analystEnvironment(extended, [...sources, "process.env.PAYPAL_NEW_SETTING"])).not.toBe(analystEnvironment(example, sources));
  });
});

describe("analyst context of a checkout", () => {
  it("is unchanged by a variable in .env.example that no store code reads", () => {
    const committed = JSON.parse(readFileSync("lib/ai/context.generated.json", "utf8"));
    const root = mkdtempSync(path.join(tmpdir(), "analyst-context-"));
    try {
      cpSync("lib", path.join(root, "lib"), { recursive: true });
      symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "dir");
      writeFileSync(
        path.join(root, ".env.example"),
        `${readFileSync(".env.example", "utf8")}\n# Shown on a page; no store reads it.\nUNRELATED_PAGE_SETTING=\n`,
      );
      // The context is the whole of the analysis key's code hash apart from the store file itself.
      expect(buildAnalystContext(root)).toEqual(committed);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
