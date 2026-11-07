// Any address the app does not serve, and every notFound() without a closer boundary.
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Not found" };

export default function NotFound() {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col justify-center gap-5 px-4 py-24 sm:px-6">
      <p className="font-mono text-xs uppercase tracking-widest text-muted">404</p>
      <h1 className="max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">This page is not part of the proof.</h1>
      <div className="flex flex-wrap gap-3">
        <Link
          href="/proof"
          className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-accent px-5 text-sm font-semibold text-accent-foreground hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          See the live proof <span aria-hidden="true">→</span>
        </Link>
        <Link
          href="/"
          className="inline-flex min-h-11 items-center rounded-lg border border-border-strong px-5 text-sm font-semibold hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-ring"
        >
          Back to the start
        </Link>
      </div>
    </div>
  );
}
