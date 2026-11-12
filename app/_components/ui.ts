// Shared class lists for the site's controls and links, so each kind looks and behaves the same
// everywhere: hover, press, disabled and the focus ring (globals.css) included.

const press = "transition-[background-color,border-color,color,transform,box-shadow] duration-150 ease-(--ease-out) active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:scale-100";

/** The one filled button per view. */
export const buttonPrimary = `inline-flex min-h-11 items-center justify-center gap-2 rounded-control bg-accent px-5 text-sm font-semibold text-accent-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_0_0_1px_color-mix(in_srgb,var(--accent-fill)_70%,#000)] hover:bg-accent-hover hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.28),0_0_0_1px_var(--accent-text)] ${press}`;

/** A bordered button next to the primary one. */
export const buttonSecondary = `inline-flex min-h-11 items-center justify-center gap-2 rounded-control border border-border-strong bg-raised px-5 text-sm font-semibold shadow-[inset_0_1px_0_var(--highlight-top)] hover:border-hairline-strong hover:bg-surface-2 ${press}`;

/** A small bordered button: Close, Replay, Try again, an evidence step. */
export const buttonSmall = `inline-flex min-h-10 items-center justify-center gap-1.5 rounded-control border border-border-strong bg-raised px-3 text-sm font-medium shadow-[inset_0_1px_0_var(--highlight-top)] hover:border-hairline-strong hover:bg-surface-2 ${press}`;

/** A quiet button with no surface until the pointer is on it. */
export const buttonGhost = `inline-flex min-h-10 items-center justify-center gap-1.5 rounded-control px-3 text-sm font-medium text-muted hover:bg-surface-2 hover:text-foreground ${press}`;

/** A text button that reads like a link: Show trace, Hide trace. */
export const buttonText = `-mx-2 inline-flex min-h-10 items-center gap-1.5 self-start rounded-control px-2 text-sm font-medium underline decoration-transparent underline-offset-4 hover:decoration-current ${press}`;

/** A link inside running text. */
export const linkProse = "text-brand underline decoration-brand/35 decoration-1 underline-offset-[5px] transition-colors duration-150 hover:decoration-brand";

/** A small utility link next to data: share, Report, a source file. */
export const linkUtility =
  "text-foreground underline decoration-border-strong underline-offset-4 transition-colors duration-150 hover:decoration-foreground";

/**
 * A panel on a scene's surface: the frames and lines of the first layer, and each block of the
 * technical layer. Inside one, only code, a patch or the trace grid gets a box of its own.
 */
export const panel = "on-tone surface-card rounded-panel p-5 sm:p-6";

/** A small label above a panel's text: a store's name, "Why it happened", "Evidence in the trace". */
export const panelLabel = "text-small text-muted";
