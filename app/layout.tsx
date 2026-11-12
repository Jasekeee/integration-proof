import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { FocusModality } from "./_components/focus-modality";
import { LogoMark } from "./_components/logo";
import { SiteNav } from "./_components/site-nav";
import { GITHUB_URL } from "./_components/site";
import { linkProse } from "./_components/ui";
import "./globals.css";

/*
 * Fonts never move the page once it is drawn.
 *
 * Geist is preloaded and "optional": it is used if it is there for the first paint, and otherwise
 * the page stays in its fallback until the next load, with no swap and no shift. The fallback is
 * Arial sized to Geist's measured widths, regular and bold apart (globals.css, "Geist Fallback
 * Metric"), so the two look and wrap alike.
 *
 * Geist Mono falls back to monospace fonts with its own advance width (0.6 em: Courier New,
 * Liberation Mono) and its vertical metrics ("Geist Mono Fallback Metric"), so a swap changes the
 * letterforms but no line break and no line height. The generated fallback, Arial enlarged to the
 * average width, wrapped code differently.
 */
const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "optional",
  adjustFontFallback: false,
  fallback: ["Geist Fallback Metric", "Arial", "Helvetica", "sans-serif"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  adjustFontFallback: false,
  fallback: ["Geist Mono Fallback Metric", "Menlo", "monospace"],
});

const DESCRIPTION =
  "Integration Proof runs controlled failures against a PayPal Checkout integration in the sandbox, " +
  "decides each one with deterministic code, and uses Claude to explain the root cause and the fix.";

export const metadata: Metadata = {
  // Render sets RENDER_EXTERNAL_URL at build and run time; links in previews need an absolute base.
  metadataBase: new URL(process.env.RENDER_EXTERNAL_URL ?? `http://localhost:${process.env.PORT ?? 3000}`),
  title: { default: "Integration Proof", template: "%s · Integration Proof" },
  description: DESCRIPTION,
  openGraph: {
    title: "Integration Proof",
    description: "Prove your PayPal integration survives a bad day, before your customers find out.",
    type: "website",
  },
  twitter: { card: "summary_large_image" },
};

/*
 * The landing's intro (app/(marketing)/intro.tsx), decided before the first paint so nobody sees it
 * flash or sees the page flash before it: only on "/", without reduced motion, once per browser
 * session (once per load when storage is unavailable). It sets data-intro on <html>: "on" while it
 * plays, "skip" for the 110 ms fade after a click, tap, key, wheel or scroll, then "done". The click
 * that ends a skipping tap or press is swallowed, so it never lands on a link under the layer.
 * Without JavaScript nothing is set and the layer never shows.
 */
const INTRO_SCRIPT = `(function(){try{var d=document.documentElement;if(location.pathname!=="/"||matchMedia("(prefers-reduced-motion: reduce)").matches)return;try{if(sessionStorage.getItem("ip-intro"))return;sessionStorage.setItem("ip-intro","1")}catch(e){}d.setAttribute("data-intro","on");var k=["pointerdown","keydown","wheel","touchstart","scroll"],o={capture:true,passive:true},t,s=0;function eat(e){if(performance.now()-s<800){e.preventDefault();e.stopPropagation()}removeEventListener("click",eat,true)}function done(){d.setAttribute("data-intro","done");k.forEach(function(e){removeEventListener(e,skip,o)})}function skip(e){if(d.getAttribute("data-intro")!=="on")return;clearTimeout(t);d.setAttribute("data-intro","skip");if(e.type==="pointerdown"||e.type==="touchstart"){s=performance.now();addEventListener("click",eat,true)}setTimeout(done,130)}k.forEach(function(e){addEventListener(e,skip,o)});t=setTimeout(done,1400)}catch(e){}})();`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // The intro script sets data-intro on this element before hydration.
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: INTRO_SCRIPT }} />
      </head>
      <body className="flex min-h-full flex-col">
        <FocusModality />
        <a
          href="#main"
          className="sr-only focus-visible:not-sr-only focus-visible:absolute focus-visible:left-4 focus-visible:top-4 focus-visible:z-50 focus-visible:rounded-control focus-visible:bg-accent focus-visible:px-3 focus-visible:py-2 focus-visible:text-accent-foreground"
        >
          Skip to content
        </a>
        {/* Sticky and translucent: the page shows faintly through it, behind a hairline. */}
        <header className="sticky top-0 z-40 border-b border-hairline bg-[color-mix(in_srgb,var(--bg)_78%,transparent)] backdrop-blur-md backdrop-saturate-150">
          <nav className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4 py-2.5 sm:px-6">
            <Link href="/" className="flex min-h-10 items-center gap-2 rounded-control font-semibold tracking-tight">
              <LogoMark />
              Integration Proof
            </Link>
            <SiteNav />
          </nav>
        </header>
        {/* Glows reach past the edges by design; clip, unlike hidden, makes no scroll container. */}
        <main id="main" className="flex flex-1 flex-col overflow-x-clip">
          {children}
        </main>
        <footer className="mt-8 border-t border-hairline">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 px-4 py-8 text-sm text-text-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <p>PayPal sandbox only. No real payment is ever made.</p>
            <p>
              <a href={GITHUB_URL} className={linkProse}>
                Source on GitHub
              </a>{" "}
              · MIT license
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
