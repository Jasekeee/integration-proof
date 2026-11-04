/**
 * Regenerates lib/ai/context.generated.json, the read-only context Claude gets next to the store
 * under test: exported declarations of the modules a store imports, the row types it reads, and the
 * configuration variable names. Run it after changing any of those files:
 *
 *   npm run analyst:context
 *
 * lib/ai/context.test.ts fails when the committed file is out of date.
 */
import { writeFileSync } from "node:fs";
import { buildAnalystContext } from "../lib/ai/declarations";

const context = buildAnalystContext();
writeFileSync("lib/ai/context.generated.json", `${JSON.stringify(context, null, 2)}\n`);
console.log(
  `Wrote lib/ai/context.generated.json: ${context.signatures.length} modules, ` +
    `${JSON.stringify(context).length} characters.`,
);
