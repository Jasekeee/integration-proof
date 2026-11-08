// Shared class lists for the site's controls and links, so each kind looks and behaves the same
// everywhere: hover, press, disabled and the focus ring (globals.css) included.

const press = "transition-[background-color,border-color,color,transform] duration-150 ease-(--ease-out) active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50 disabled:translate-y-0";

/** The one filled button per view. */
export const buttonPrimary = `inline-flex min-h-11 items-center justify-center gap-2 rounded-control bg-accent px-5 text-sm font-semibold text-accent-foreground hover:bg-accent-hover ${press}`;

/** A bordered button next to the primary one. */
export const buttonSecondary = `inline-flex min-h-11 items-center justify-center gap-2 rounded-control border border-border-strong bg-background px-5 text-sm font-semibold hover:border-foreground/40 hover:bg-surface-2 ${press}`;

/** A small bordered button: Close, Replay, Try again, an evidence step. */
export const buttonSmall = `inline-flex min-h-10 items-center justify-center gap-1.5 rounded-control border border-border-strong bg-background px-3 text-sm font-medium hover:border-foreground/40 hover:bg-surface-2 ${press}`;

/** A text button that reads like a link: Show trace, Show evidence and fix. */
export const buttonText = `-mx-2 inline-flex min-h-10 items-center gap-1.5 self-start rounded-control px-2 text-sm font-medium underline decoration-transparent underline-offset-4 hover:decoration-current ${press}`;

/** A square icon button: a card's fold toggle. */
export const buttonIcon = `grid size-10 shrink-0 place-items-center rounded-control text-muted hover:bg-surface-2 hover:text-foreground active:bg-border ${press}`;

/** A link inside running text. */
export const linkProse = "text-brand underline decoration-brand/40 underline-offset-4 transition-colors duration-150 hover:decoration-brand";

/** A small utility link next to data: share, Report, a source file. */
export const linkUtility =
  "text-foreground underline decoration-border-strong underline-offset-4 transition-colors duration-150 hover:decoration-foreground";
