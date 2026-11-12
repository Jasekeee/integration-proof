/**
 * The landing's intro, about 1.3 s, once per browser session: the mark's open loop draws in, a $10
 * coin rides it into the gap once, the dot settles there and the wordmark arrives; then the layer
 * lifts off the page.
 *
 * Only the inline script in app/layout.tsx shows it, by setting data-intro on <html> before the first
 * paint, and only on "/", with JavaScript, without reduced motion, and once per session. Everyone
 * else never sees this layer (globals.css, .intro). Any click, tap, key, wheel or scroll skips it.
 * The page renders in full underneath; the layer is decorative and holds nothing focusable.
 *
 * The geometry is LogoMark's (app/_components/logo.tsx): a circle of radius 10.5 around (16, 16),
 * the arc running clockwise from 60° to 300°, the dot at 340°, in the gap.
 */
export function Intro() {
  return (
    <div className="intro" aria-hidden="true">
      <div className="intro-lockup">
        <svg viewBox="0 0 32 32" className="intro-mark">
          <path
            className="intro-arc"
            d="M21.25 25.09A10.5 10.5 0 1 1 21.25 6.91"
            pathLength={1}
            fill="none"
            stroke="var(--accent-text)"
            strokeWidth="3.6"
            strokeLinecap="round"
          />
          <circle className="intro-dot" cx="25.87" cy="12.41" r="3" fill="var(--accent-text)" />
          {/* The coin: carried around the centre by two turns, kept upright by two counter-turns. */}
          <g className="intro-orbit">
            <g className="intro-cross">
              <g className="intro-cross-back">
                <g className="intro-orbit-back">
                  <g className="intro-coin">
                    <circle cx="26.5" cy="16" r="4.6" fill="var(--accent-fill)" stroke="var(--accent-text)" strokeWidth="0.5" />
                    <text
                      x="26.5"
                      y="16"
                      textAnchor="middle"
                      dominantBaseline="central"
                      fontSize="3.3"
                      fontWeight="700"
                      fill="#ffffff"
                      letterSpacing="-0.1"
                    >
                      $10
                    </text>
                  </g>
                </g>
              </g>
            </g>
          </g>
        </svg>
        <span className="intro-word">Integration Proof</span>
      </div>
    </div>
  );
}
