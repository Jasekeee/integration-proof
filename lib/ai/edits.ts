// Claude's fix as edits to the store file. Each edit quotes code from the file (`find`) and gives
// what it becomes (`replace`). Code checks that every quote occurs exactly once, applies the edits,
// and writes the unified diff itself, so a diff can never miscount its lines or misquote its context.
// What does not match is described for the model in terms it can act on, indentation made visible.
import { structuredPatch } from "diff";

export interface Edit {
  file: string;
  find: string;
  replace: string;
}

export type EditsResult =
  | { ok: true; source: string; patch: string }
  /** Each problem is written for the model, which gets one round to correct its edits. */
  | { ok: false; problems: string[] };

/** A line with its indentation shown: every leading space as "·" and every leading tab as "→". */
export function visibleIndent(line: string): string {
  const width = line.length - line.trimStart().length;
  return `${line.slice(0, width).replace(/ /g, "·").replace(/\t/g, "→")}${line.slice(width)}`;
}

function occurrences(text: string, find: string): number[] {
  const found: number[] = [];
  for (let at = text.indexOf(find); at !== -1; at = text.indexOf(find, at + 1)) found.push(at);
  return found;
}

function lineAt(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length;
}

/** Similarity of two trimmed lines from 0 to 1, by shared character pairs (Dice coefficient). */
function similarity(a: string, b: string): number {
  const pairs = (text: string) => {
    const counts = new Map<string, number>();
    for (let i = 0; i < text.length - 1; i++) counts.set(text.slice(i, i + 2), (counts.get(text.slice(i, i + 2)) ?? 0) + 1);
    return counts;
  };
  const left = pairs(a.trim());
  const right = pairs(b.trim());
  let shared = 0;
  for (const [pair, count] of left) shared += Math.min(count, right.get(pair) ?? 0);
  const total = Math.max(1, a.trim().length - 1 + (b.trim().length - 1));
  return (2 * shared) / total;
}

/** Why a quote is not in the file: its first line that is not a line of the file, and what the file has instead. */
function whyNotFound(path: string, source: string, find: string): string {
  const fileLines = source.split("\n");
  const findLines = find.split("\n");
  for (const [index, line] of findLines.entries()) {
    if (line.trim() === "" || fileLines.includes(line)) continue;
    const sameText = fileLines
      .map((text, number) => ({ text, number: number + 1 }))
      .filter((candidate) => candidate.text.trim() === line.trim());
    const nearest =
      sameText.length > 0
        ? sameText
        : fileLines
            .map((text, number) => ({ text, number: number + 1, score: similarity(text, line) }))
            .filter((candidate) => candidate.text.trim() !== "" && candidate.score >= 0.5)
            .sort((a, b) => b.score - a.score)
            .slice(0, 3);
    const quoted = `line ${index + 1} of find, "${visibleIndent(line)}",`;
    if (nearest.length === 0) return `${quoted} is not in ${path}, and no line of the file is close to it.`;
    const lead = sameText.length > 0 ? "The file has that line with other indentation" : "The closest lines of the file are";
    return `${quoted} is not a line of ${path}. ${lead} (· is a space):\n${nearest
      .map((candidate) => `    ${candidate.number}: ${visibleIndent(candidate.text)}`)
      .join("\n")}`;
  }
  return "every line of find is in the file, but not together in this order. Copy the block as it stands in the file.";
}

/** The unified diff of a change to one file, with three lines of context, as the server shows it. */
export function unifiedDiff(path: string, before: string, after: string): string {
  if (before === after) return "";
  const { hunks } = structuredPatch(`a/${path}`, `b/${path}`, before, after, undefined, undefined, { context: 3 });
  const lines = [`--- a/${path}`, `+++ b/${path}`];
  for (const hunk of hunks) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, ...hunk.lines);
  }
  return `${lines.join("\n")}\n`;
}

function normalizePath(file: string): string {
  return file.trim().replace(/^(?:[ab]\/|\.\/)/, "");
}

/**
 * Applies every edit to the file, or none. Each find must occur exactly once in the file as it is,
 * and no two may overlap, so the order of the edits does not matter.
 */
export function applyEdits(target: { path: string; source: string }, edits: Edit[]): EditsResult {
  const problems: string[] = [];
  const ranges: { start: number; end: number; replace: string; edit: number }[] = [];

  for (const [index, edit] of edits.entries()) {
    const label = `Edit ${index + 1} of ${edits.length}`;
    if (normalizePath(edit.file) !== target.path) {
      problems.push(`${label} changes ${edit.file}; only ${target.path} may change.`);
      continue;
    }
    if (edit.find === "") {
      problems.push(`${label} has an empty find; quote the lines it changes.`);
      continue;
    }
    if (edit.find === edit.replace) {
      problems.push(`${label} changes nothing: its replace is the same as its find.`);
      continue;
    }
    const found = occurrences(target.source, edit.find);
    if (found.length === 0) {
      problems.push(`${label}: find does not occur in ${target.path}: ${whyNotFound(target.path, target.source, edit.find)}`);
      continue;
    }
    if (found.length > 1) {
      const at = found.map((offset) => lineAt(target.source, offset)).join(", ");
      problems.push(
        `${label}: find occurs ${found.length} times in ${target.path}, at lines ${at}. Add surrounding lines so it occurs once.`,
      );
      continue;
    }
    ranges.push({ start: found[0], end: found[0] + edit.find.length, replace: edit.replace, edit: index + 1 });
  }

  const ordered = [...ranges].sort((a, b) => a.start - b.start);
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].start < ordered[i - 1].end) {
      problems.push(`Edits ${ordered[i - 1].edit} and ${ordered[i].edit} change overlapping lines; merge them into one edit.`);
    }
  }
  if (problems.length > 0) return { ok: false, problems };

  let result = target.source;
  for (const range of [...ordered].reverse()) result = result.slice(0, range.start) + range.replace + result.slice(range.end);
  return { ok: true, source: result, patch: unifiedDiff(target.path, target.source, result) };
}
