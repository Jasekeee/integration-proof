/**
 * The mark: a round trip with its last stretch missing. The arc is the request going out and coming
 * back; the dot past its end is the answer that never arrived. Drawn in the current text color.
 * app/icon.svg and app/favicon.ico are the same shape.
 */
export function LogoMark({ className = "size-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <path d="M21.25 25.09A10.5 10.5 0 1 1 21.25 6.91" fill="none" stroke="currentColor" strokeWidth="3.6" strokeLinecap="round" />
      <circle cx="25.87" cy="12.41" r="3" fill="currentColor" />
    </svg>
  );
}
