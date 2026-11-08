// What the analyst reads about the store: the file under test in full, which the patch must target,
// and, read-only, the exported declarations of the modules it can call, the row types it reads and
// the configuration it runs with. Implementations of those modules, and the hardened store, are not
// part of it. Regenerate the declarations with `npm run analyst:context`.
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { StoreMode } from "../db/schema";
import context from "./context.generated.json";
import { sha256 } from "./signature";

export const STORE_FILES: Record<StoreMode, string> = {
  naive: "lib/store/naive.ts",
  hardened: "lib/store/hardened.ts",
};

export interface SourceFile {
  path: string;
  content: string;
  /**
   * How a read-only file is shown to the analyst: the exported declarations of a module (the
   * reference stores' context, the default), or a complete file of a store its owner sent.
   */
  kind?: "declarations" | "source";
}

export interface StoreSources {
  target: SourceFile;
  /** Exported declarations, not implementations. */
  context: SourceFile[];
  /** Configuration variable names and their comments, without values. */
  environment: string;
  /** Changes when any of it changes, so a fixed store is analysed afresh. */
  hash: string;
}

const SOURCE_DIR = "lib/";

export async function readStoreSources(mode: StoreMode): Promise<StoreSources> {
  const file = STORE_FILES[mode];
  // Scoped to lib/ so the build traces that folder only, not the whole project.
  const target = {
    path: file,
    content: await readFile(path.join(process.cwd(), "lib", file.slice(SOURCE_DIR.length)), "utf8"),
  };
  const declarations = [
    ...context.signatures.map((item) => ({ path: item.path, content: item.declarations })),
    { path: "lib/db/schema.ts", content: context.rowTypes },
  ];
  const hash = sha256(JSON.stringify([target, declarations, context.environment]));
  return { target, context: declarations, environment: context.environment, hash };
}
