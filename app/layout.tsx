import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { GITHUB_URL } from "./_components/site";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
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

const navLink =
  "rounded-md px-2 py-2 text-sm text-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring";

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:rounded-md focus:bg-accent focus:px-3 focus:py-2 focus:text-accent-foreground"
        >
          Skip to content
        </a>
        <header className="border-b border-border">
          <nav className="mx-auto flex w-full max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
            <Link href="/" className="flex min-h-10 items-center gap-2 rounded-md font-semibold focus-visible:outline-2 focus-visible:outline-ring">
              <svg viewBox="0 0 32 32" className="size-6" aria-hidden="true">
                <rect width="32" height="32" rx="7" className="fill-foreground" />
                <path d="M9 16.5l4.5 4.5L23 11.5" fill="none" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="stroke-background" />
              </svg>
              Integration Proof
            </Link>
            <div className="flex items-center gap-1">
              <Link href="/proof" className={navLink}>
                Proof runs
              </Link>
              <a href={GITHUB_URL} className={navLink}>
                GitHub
              </a>
            </div>
          </nav>
        </header>
        <main id="main" className="flex flex-1 flex-col">
          {children}
        </main>
        <footer className="border-t border-border">
          <div className="mx-auto flex w-full max-w-7xl flex-col gap-2 px-4 py-6 text-sm text-muted sm:flex-row sm:justify-between sm:px-6">
            <p>PayPal sandbox only. No real payment is ever made.</p>
            <p>
              <a href={GITHUB_URL} className="underline underline-offset-4 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
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
