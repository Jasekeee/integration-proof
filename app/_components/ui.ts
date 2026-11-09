// Shared class lists for the site's controls and links, so each kind looks and behaves the same
// everywhere: hover, press, disabled and the focus ring (globals.css) included.

const press = "transition-[background-color,border-color,color,transform] duration-150 ease-(--ease-out) active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50 disabled:translate-y-0";

/** The one filled button per view. */
export const buttonPrimary = `inline-flex min-h-11 items-center justify-center gap-2 rounded-control bg-accent px-5 text-sm font-semibold text-accent-foreground hover:bg-accent-hover ${press}`;

/** A bordered button next to the primary one. */
export const buttonSecondary = `inline-flex min-h-11 items-center justify-center gap-2 rounded-control border border-border-strong bg-background px-5 text-sm font-semibold hover:border-foreground/40 hover:bg-surface-2 ${press}`;

/** A small bordered button: Close, Replay, Try again, an evidence step. */
export const buttonSmall = `inline-flex min-h-10 items-center justify-center gap-1.5 rounded-control border border-border-strong bg-background px-3 text-sm font-medium hover:border-foreground/40 hover:bg-surface-2 ${press}`;

/** A text button that reads like a link: Show trace, Hide trace. */
export const buttonText = `-mx-2 inline-flex min-h-10 items-center gap-1.5 self-start rounded-control px-2 text-sm font-medium underline decoration-transparent underline-offset-4 hover:decoration-current ${press}`;

/** A link inside running text. */
export const linkProse = "text-brand underline decoration-brand/40 underline-offset-4 transition-colors duration-150 hover:decoration-brand";

/** A small utility link next to data: share, Report, a source file. */
export const linkUtility =
  "text-foreground underline decoration-border-strong underline-offset-4 transition-colors duration-150 hover:decoration-foreground";

/**
 * A panel on a scene's surface: the frames and lines of the first layer, and each block of the
 * technical layer. Inside one, only code, a patch or the trace grid gets a box of its own.
 */
export const panel = "rounded-panel bg-background p-5 sm:p-6";

/** A small label above a panel's text: a store's name, "Why it happened", "Evidence in the trace". */
export const panelLabel = "text-small text-muted";
