/**
 * The site's icons: one 16 × 16 grid, a 1.5 stroke, round caps, drawn in the current text color.
 * Decorative by default; the text next to an icon carries its meaning.
 */
const PATHS = {
  "chevron-down": "M4 6l4 4 4-4",
  "arrow-right": "M3 8h9.5M9 4.5 12.5 8 9 11.5",
  "arrow-up-right": "M5 11 11 5M6 5h5v5",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className = "size-4" }: { name: IconName; className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className={`shrink-0 ${className}`}>
      <path d={PATHS[name]} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
