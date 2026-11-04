// The lines of store code that decide a scenario, read from the store files themselves so the proof
// page can never show code that differs from what ran.
//
// A marker is a line comment that starts with a scenario id in brackets: "// [S3] Fix: ask PayPal".
// Its text, continued on the comment lines right after it, is the caption. The snippet is the code
// after the comment, up to the next blank line or the first line indented less than the marker.
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { StoreMode } from "../db/schema";

export interface Snippet {
  /** What the code does, in the store's own comment, without a leading "Fix:". */
  caption: string;
  /** The code, dedented. */
  code: string;
  /** Repository path of the store file. */
  file: string;
  /** 1-based line numbers of the first and last code line in that file. */
  lines: [number, number];
}

export type Snippets = Record<string, Snippet>;

const STORE_FILES: Record<StoreMode, string> = {
  naive: "lib/store/naive.ts",
  hardened: "lib/store/hardened.ts",
};

const MARKER = /^(\s*)\/\/ \[(S\d+)\] (.+)$/;
const COMMENT = /^\s*\/\/ ?(.*)$/;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** Every marked snippet in one source file. Throws on a scenario marked twice or a marker with no code. */
export function extractSnippets(source: string, file: string): Snippets {
  const lines = source.split("\n");
  const snippets: Snippets = {};

  for (let index = 0; index < lines.length; index++) {
    const marker = MARKER.exec(lines[index]);
    if (!marker) continue;
    const [, indent, id, text] = marker;
    if (snippets[id]) throw new Error(`${file}: scenario ${id} is marked twice`);

    const caption = [text];
    let cursor = index + 1;
    while (cursor < lines.length && COMMENT.test(lines[cursor]) && !MARKER.test(lines[cursor])) {
      caption.push(COMMENT.exec(lines[cursor])![1]);
      cursor++;
    }

    const start = cursor;
    while (
      cursor < lines.length &&
      lines[cursor].trim() !== "" &&
      indentOf(lines[cursor]) >= indent.length &&
      !MARKER.test(lines[cursor])
    ) {
      cursor++;
    }
    const code = lines.slice(start, cursor);
    if (code.length === 0) throw new Error(`${file}: the marker of ${id} has no code after it`);

    const common = Math.min(...code.map(indentOf));
    snippets[id] = {
      caption: caption.join(" ").replace(/^Fix: /, "").replace(/^./, (first) => first.toUpperCase()),
      code: code.map((line) => line.slice(common)).join("\n"),
      file,
      lines: [start + 1, cursor],
    };
  }
  return snippets;
}

/**
 * The marked snippets and the commit they come from, for links to the same lines in the repository.
 * Never throws: a page without snippets still shows every verdict.
 */
export async function readStoreCode(): Promise<{ ref: string; snippets: Partial<Record<StoreMode, Snippets>> }> {
  const ref = process.env.RENDER_GIT_COMMIT ?? "main";
  try {
    return { ref, snippets: await readSnippets() };
  } catch (error) {
    console.error("Could not read the store snippets", error);
    return { ref, snippets: {} };
  }
}

let cached: Promise<Record<StoreMode, Snippets>> | null = null;

/** The marked snippets of both stores. The files do not change while the process runs. */
export function readSnippets(): Promise<Record<StoreMode, Snippets>> {
  cached ??= (async () => {
    const read = async (file: string) =>
      // Scoped to lib/ so the build traces that folder only, not the whole project.
      extractSnippets(await readFile(path.join(process.cwd(), "lib", file.slice("lib/".length)), "utf8"), file);
    const [naive, hardened] = await Promise.all([read(STORE_FILES.naive), read(STORE_FILES.hardened)]);
    return { naive, hardened };
  })().catch((error: unknown) => {
    cached = null;
    throw error;
  });
  return cached;
}
