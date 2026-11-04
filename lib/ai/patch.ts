// Checks the analyst's patch against the real file. A patch that does not apply is shown as one that
// needs review, never hidden and never repaired beyond what `git apply --recount` would do.
import { applyPatch, parsePatch } from "diff";

export type PatchStatus = "applies" | "needs_review" | "none";

export interface PatchCheck {
  status: PatchStatus;
  /** The patch with its hunk headers recounted; the same text the model wrote otherwise. */
  patch: string;
  note: string | null;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

/**
 * Recomputes the line counts in every hunk header from the hunk's lines, as `git apply --recount`
 * does. Models often miscount; the lines themselves still have to match the file exactly. An empty
 * line inside a hunk is read as an empty context line, as GNU patch reads it.
 */
export function recountHunks(patch: string): { patch: string; changed: boolean } {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const header = HUNK_HEADER.exec(lines[i]);
    if (!header) {
      out.push(lines[i]);
      continue;
    }
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const line = lines[j];
      if (HUNK_HEADER.test(line) || line.startsWith("--- ") || line.startsWith("diff ")) break;
      // A trailing empty string is the end of the text, not a line of the hunk.
      if (line === "" && j === lines.length - 1) break;
      body.push(line === "" ? " " : line);
    }
    const oldCount = body.filter((line) => line.startsWith(" ") || line.startsWith("-")).length;
    const newCount = body.filter((line) => line.startsWith(" ") || line.startsWith("+")).length;
    const rewritten = `@@ -${header[1]},${oldCount} +${header[2]},${newCount} @@${header[3]}`;
    if (rewritten !== lines[i] || body.some((line, k) => line !== lines[i + 1 + k])) changed = true;
    out.push(rewritten, ...body);
    i = j - 1;
  }
  return { patch: out.join("\n"), changed };
}

function stripPrefix(name: string | undefined): string | undefined {
  return name?.replace(/^[ab]\//, "").trim();
}

/** Applies the patch to the target file's real content. */
export function checkPatch(patch: string, target: { path: string; source: string }): PatchCheck {
  if (patch.trim() === "") return { status: "none", patch: "", note: null };

  const recounted = recountHunks(patch.endsWith("\n") ? patch : `${patch}\n`);
  const recountNote = recounted.changed ? " Hunk line counts were recounted, as git apply --recount does." : "";
  const review = (reason: string): PatchCheck => ({
    status: "needs_review",
    patch: recounted.patch,
    note: `${reason}${recountNote}`,
  });

  let files;
  try {
    files = parsePatch(recounted.patch);
  } catch (error) {
    return review(`The patch is not a valid unified diff: ${error instanceof Error ? error.message : String(error)}.`);
  }
  const touched = files.filter((file) => file.hunks.length > 0);
  if (touched.length === 0) return review("The patch has no hunks.");
  const others = touched
    .map((file) => stripPrefix(file.newFileName) ?? stripPrefix(file.oldFileName))
    .filter((name) => name !== target.path);
  if (others.length > 0) return review(`The patch changes ${others.join(", ")}; only ${target.path} may change.`);

  const result = applyPatch(target.source, touched[0]);
  if (result === false) return review(`The patch does not apply to ${target.path}: its context lines do not match the file.`);
  if (result === target.source) return review("The patch applies but changes nothing.");
  return { status: "applies", patch: recounted.patch, note: `Applies cleanly to ${target.path}.${recountNote}` };
}
