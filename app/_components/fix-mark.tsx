import { Icon } from "./icon";

/**
 * Claude's fix and its offline check at a glance: the verdict before, struck through, and the
 * verdict after. Screen readers get the same as one sentence. Still by itself; inside an element with
 * data-fix="armed" / "play" (globals.css) the strike, the arrow and the PASS play in once.
 */
export function FixMark({
  before,
  after,
  label,
}: {
  before: string;
  after: string;
  label: string;
}) {
  const chip = "inline-flex h-6 items-center rounded-control px-2 text-xs font-semibold tracking-wide";
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className="sr-only">
        {label}: {before} → {after}
      </span>
      <span aria-hidden="true" className="inline-flex items-center gap-1.5">
        <span className={`verdict-struck bg-surface-2 text-muted ${chip}`}>{before}</span>
        <Icon name="arrow-right" className="fix-arrow size-4 text-muted" />
        <span className={`fix-after bg-pass-bg text-pass ${chip}`}>{after}</span>
      </span>
      <span aria-hidden="true" className="fix-after text-xs font-semibold text-pass">
        {label}
      </span>
    </span>
  );
}
