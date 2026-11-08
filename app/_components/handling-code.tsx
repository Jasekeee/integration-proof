import { CodeScroller } from "./code-scroller";
import { MODE_LABELS, type Mode, type StoreCode } from "./report";
import { GITHUB_URL } from "./site";
import { linkUtility, panel } from "./ui";

/**
 * The store's own lines that make a scenario pass, read from the store file at its markers, with
 * their line numbers and a link to the same lines in the repository. As wide as the scenario. On a
 * narrow screen the code scrolls sideways under its line numbers; from 1024 px a long line wraps
 * under itself instead, so no code is ever hidden.
 */
export function HandlingCode({ id, mode, code }: { id: string; mode: Mode; code: StoreCode }) {
  const snippet = code.snippets[mode]?.[id];
  if (!snippet) return null;
  const [first, last] = snippet.lines;
  const href = `${GITHUB_URL}/blob/${code.ref}/${snippet.file}#L${first}-L${last}`;
  const lines = snippet.code.split("\n");

  return (
    <section className={`flex min-w-0 flex-col gap-3 ${panel}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-base font-semibold">How the {MODE_LABELS[mode].name.toLowerCase()} handles it</h3>
        <a href={href} className={`rounded-sm font-mono text-xs ${linkUtility} text-muted hover:text-foreground`}>
          {snippet.file}:{first}
        </a>
      </div>
      <p className="measure text-sm leading-6 text-pretty">{snippet.caption}</p>
      <CodeScroller label={`${snippet.file}, lines ${first} to ${last}`} gutter className="rounded-control border border-border bg-surface">
        <pre className="py-2 font-mono text-xs leading-5">
          <code className="block min-w-max lg:min-w-0">
            {lines.map((line, index) => (
              <span key={index} className="flex">
                {/* The numbers stay in place while the code scrolls under them. */}
                <span
                  data-gutter=""
                  className="sticky left-0 z-10 w-10 shrink-0 select-none bg-surface pr-3 text-right text-muted"
                  aria-hidden="true"
                >
                  {first + index}
                </span>
                {/* From 1024 px a long line wraps, its continuation indented under the line's start. */}
                <span
                  className={`min-w-0 pr-6 lg:whitespace-pre-wrap lg:break-words lg:pl-4 lg:-indent-4 ${line.trimStart().startsWith("//") ? "text-muted" : "text-foreground"}`}
                >
                  {line === "" ? " " : line}
                </span>
              </span>
            ))}
          </code>
        </pre>
      </CodeScroller>
    </section>
  );
}
