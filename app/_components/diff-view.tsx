import { CodeScroller } from "./code-scroller";

/**
 * A unified diff with added and removed lines marked by color and by their + / - sign. On a narrow
 * screen it scrolls sideways; from 1024 px a long line wraps under itself instead, so the patch reads
 * without scrolling.
 */
export function DiffView({ patch }: { patch: string }) {
  const lines = patch.replace(/\n$/, "").split("\n");
  return (
    <CodeScroller label="Patch" className="rounded-card border border-hairline bg-sunken">
      <pre className="py-2 font-mono text-xs leading-5 lg:whitespace-pre-wrap">
        <code className="block min-w-max lg:min-w-0">
          {lines.map((line, index) => {
            const kind = line.startsWith("+++") || line.startsWith("---")
              ? "file"
              : line.startsWith("@@")
                ? "hunk"
                : line.startsWith("+")
                  ? "add"
                  : line.startsWith("-")
                    ? "del"
                    : "context";
            const style = {
              file: "text-muted font-semibold",
              hunk: "text-muted bg-surface-2",
              add: "bg-diff-add-bg text-diff-add",
              del: "bg-diff-del-bg text-diff-del",
              context: "text-foreground",
            }[kind];
            return (
              <span key={index} className={`block pl-3 pr-8 lg:pl-7 lg:-indent-4 lg:break-words ${style}`}>
                {line === "" ? " " : line}
              </span>
            );
          })}
        </code>
      </pre>
    </CodeScroller>
  );
}
