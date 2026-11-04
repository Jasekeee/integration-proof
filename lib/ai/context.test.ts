import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildAnalystContext, SIGNATURE_FILES } from "./declarations";

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

  it("names configuration variables without their values, and no card number", () => {
    expect(committed.environment).toContain("PAYPAL_WEBHOOK_ID=");
    const variables = committed.environment.split("\n").filter((line: string) => /^#?\s*[A-Z][A-Z0-9_]*=/.test(line));
    expect(variables.length).toBeGreaterThan(5);
    for (const line of variables) expect(line).toMatch(/=$/);
    expect(JSON.stringify(committed)).not.toContain("4012888888881881");
  });
});
