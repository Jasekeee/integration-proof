// One bench run in its own process, for scripts/verify-ai-fixes.ts. The parent starts it with an
// environment that holds no secret, so code under test, a patched store included, can read none.
//
//   node --import tsx bench/child.ts --root <checkout> --mode naive --scenarios S1,S2 --out result.json
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { runOnBench } from "./harness";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      root: { type: "string" },
      mode: { type: "string" },
      scenarios: { type: "string" },
      out: { type: "string" },
    },
  });
  if (!values.root || !values.out || (values.mode !== "naive" && values.mode !== "hardened") || !values.scenarios) {
    throw new Error("Usage: child.ts --root <dir> --mode naive|hardened --scenarios S1,S2 --out <file>");
  }
  const run = await runOnBench({ root: values.root, mode: values.mode, scenarioIds: values.scenarios.split(",") });
  writeFileSync(values.out, JSON.stringify(run));
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exit(1);
  },
);
