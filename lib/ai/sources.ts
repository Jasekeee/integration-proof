// The store code the analyst reads: the file under test, which the patch must target, and the
// modules it calls, read-only. For the reference stores this is the real code in this repository.
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { StoreMode } from "../db/schema";
import { sha256 } from "./signature";

export const STORE_FILES: Record<StoreMode, string> = {
  naive: "lib/store/naive.ts",
  hardened: "lib/store/hardened.ts",
};

/** What the store imports: helpers, data access, and the PayPal calls it can make. */
export const CONTEXT_FILES = [
  "lib/store/shared.ts",
  "lib/store/repository.ts",
  "lib/paypal/orders.ts",
  "lib/paypal/webhooks.ts",
];

export interface SourceFile {
  path: string;
  content: string;
}

export interface StoreSources {
  target: SourceFile;
  context: SourceFile[];
  /** Changes when any of the files changes, so a fixed store is analysed afresh. */
  hash: string;
}

const SOURCE_DIR = "lib/";

export async function readStoreSources(mode: StoreMode): Promise<StoreSources> {
  // Scoped to lib/ so the build traces that folder only, not the whole project.
  const read = async (file: string): Promise<SourceFile> => ({
    path: file,
    content: await readFile(path.join(process.cwd(), "lib", file.slice(SOURCE_DIR.length)), "utf8"),
  });
  const target = await read(STORE_FILES[mode]);
  const context = await Promise.all(CONTEXT_FILES.map(read));
  const hash = sha256(JSON.stringify([target, ...context].map((file) => [file.path, file.content])));
  return { target, context, hash };
}
