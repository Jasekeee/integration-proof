import { Icon } from "./icon";

/**
 * Claude's fix and its offline check at a glance: the verdict before, struck through, and the
 * verdict after. Screen readers get the same as one sentence. Still: the analysis panel animates its
 * own copy once it scrolls into view; a folded card shows this one as it is.
 */
export function FixMark({
  before,
  after,
  label,
  size = "md",
}: {
  before: string;
  after: string;
  label: string;
  size?: "sm" | "md";
}) {
  const chip = `inline-flex items-center rounded-control px-2 font-mono font-semibold ${size === "sm" ? "h-5 text-label" : "h-6 text-xs"}`;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className="sr-only">
        {label}: {before} → {after}
      </span>
      <span aria-hidden="true" className="inline-flex items-center gap-1.5">
        <span className={`verdict-struck bg-surface-2 text-muted ${chip}`}>{before}</span>
        <Icon name="arrow-right" className="size-4 text-muted" />
        <span className={`bg-pass-bg text-pass ${chip}`}>{after}</span>
      </span>
      <span aria-hidden="true" className={`font-mono font-semibold text-pass ${size === "sm" ? "text-label" : "text-xs"}`}>
        {label}
      </span>
    </span>
  );
}
