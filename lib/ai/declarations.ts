// Builds the analyst's read-only context: what the store can call, as the TypeScript compiler
// declares it, and what the app is configured with. Implementations are left out on purpose, and so
// is the hardened store. Used by scripts/analyst-context.ts and its freshness test only; the app
// reads the generated JSON, so the compiler is never needed at runtime.
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/** Modules a store imports. Their exported declarations, with doc comments, go to the model. */
export const SIGNATURE_FILES = [
  "lib/store/shared.ts",
  "lib/store/repository.ts",
  "lib/paypal/client.ts",
  "lib/paypal/orders.ts",
  "lib/paypal/payments.ts",
  "lib/paypal/token.ts",
  "lib/paypal/webhooks.ts",
  "lib/paypal/test-cards.ts",
];

/** Row types the store code reads, expanded so the model sees their fields. */
const ROW_TYPES_FILE = "lib/db/schema.ts";
const ROW_TYPES = ["OrderRow", "OrderStatus", "StoreMode", "VerificationResult"];

export interface AnalystContext {
  signatures: { path: string; declarations: string }[];
  rowTypes: string;
  /** Variable names and comments from .env.example; never values. */
  environment: string;
}

export function buildAnalystContext(root = process.cwd()): AnalystContext {
  const absolute = (file: string) => path.join(root, file);
  const program = ts.createProgram([...SIGNATURE_FILES, ROW_TYPES_FILE].map(absolute), {
    declaration: true,
    emitDeclarationOnly: true,
    strict: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    esModuleInterop: true,
    resolveJsonModule: true,
  });

  const signatures = SIGNATURE_FILES.map((file) => {
    let declarations = "";
    const source = program.getSourceFile(absolute(file));
    if (!source) throw new Error(`${file} is not part of the program`);
    program.emit(source, (name, text) => {
      if (name.endsWith(".d.ts")) declarations = text;
    }, undefined, true);
    return { path: file, declarations: declarations.trim() };
  });

  const checker = program.getTypeChecker();
  const schema = program.getSourceFile(absolute(ROW_TYPES_FILE));
  const exports = schema ? checker.getExportsOfModule(checker.getSymbolAtLocation(schema)!) : [];
  const rowTypes = ROW_TYPES.map((name) => {
    const symbol = exports.find((item) => item.name === name);
    if (!symbol) throw new Error(`${ROW_TYPES_FILE} does not export ${name}`);
    const text = checker.typeToString(
      checker.getDeclaredTypeOfSymbol(symbol),
      undefined,
      ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias,
    );
    return `export type ${name} = ${text};`;
  }).join("\n");

  return { signatures, rowTypes, environment: environmentOf(readFileSync(absolute(".env.example"), "utf8")) };
}

/** Keeps comments and variable names; drops every value, even example defaults. */
function environmentOf(example: string): string {
  return example
    .split("\n")
    .map((line) => {
      const variable = /^\s*(#\s*)?([A-Z][A-Z0-9_]*)=/.exec(line);
      return variable ? `${variable[1] ?? ""}${variable[2]}=` : line;
    })
    .join("\n")
    .trim();
}
