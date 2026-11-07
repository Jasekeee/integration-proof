import { CodeScroller } from "./code-scroller";

/** A unified diff with added and removed lines marked by color and by their + / - sign. */
export function DiffView({ patch }: { patch: string }) {
  const lines = patch.replace(/\n$/, "").split("\n");
  return (
    <CodeScroller label="Patch" className="rounded-control border border-border bg-background">
      <pre className="py-2 font-mono text-xs leading-5">
        <code className="block min-w-max">
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
              <span key={index} className={`block pl-3 pr-8 ${style}`}>
                {line === "" ? " " : line}
              </span>
            );
          })}
        </code>
      </pre>
    </CodeScroller>
  );
}
