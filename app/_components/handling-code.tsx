import { CodeScroller } from "./code-scroller";
import type { Mode, StoreCode } from "./report";
import { GITHUB_URL } from "./site";
import { linkUtility } from "./ui";

/**
 * The store's own lines that make a scenario pass, read from the store file at its markers, with
 * their line numbers and a link to the same lines in the repository.
 */
export function HandlingCode({ id, mode, code }: { id: string; mode: Mode; code: StoreCode }) {
  const snippet = code.snippets[mode]?.[id];
  if (!snippet) return null;
  const [first, last] = snippet.lines;
  const href = `${GITHUB_URL}/blob/${code.ref}/${snippet.file}#L${first}-L${last}`;
  const lines = snippet.code.split("\n");

  return (
    <section className="flex min-w-0 flex-col gap-2 rounded-control border border-border bg-background p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h4 className="text-sm font-semibold">How the {mode} store handles it</h4>
        <a
          href={href}
          className={`rounded-sm font-mono text-xs ${linkUtility} text-muted hover:text-foreground`}
        >
          {snippet.file}:{first}
        </a>
      </div>
      <p className="measure text-sm leading-6 text-muted">{snippet.caption}</p>
      <CodeScroller label={`${snippet.file}, lines ${first} to ${last}`} gutter className="rounded-control border border-border bg-surface">
        <pre className="py-2 font-mono text-xs leading-5">
          <code className="block min-w-max">
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
                <span className={`pr-6 ${line.trimStart().startsWith("//") ? "text-muted" : "text-foreground"}`}>
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
