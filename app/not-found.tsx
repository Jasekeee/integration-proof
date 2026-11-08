// Any address the app does not serve, and every notFound() without a closer boundary.
import type { Metadata } from "next";
import Link from "next/link";
import { Icon } from "./_components/icon";
import { buttonPrimary, buttonSecondary } from "./_components/ui";

export const metadata: Metadata = { title: "Not found" };

export default function NotFound() {
  return (
    // On a phone the message sits near the top; on a wide screen it takes the middle of the page.
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col items-center gap-6 px-4 pb-24 pt-16 text-center sm:justify-center sm:px-6 sm:py-24">
      <p className="text-lg text-muted">Page not found</p>
      <h1 className="max-w-3xl text-[clamp(2.25rem,5vw,4rem)] font-semibold leading-[1.05] tracking-display text-balance">
        This page is not part of the proof.
      </h1>
      <div className="mt-3 flex flex-wrap justify-center gap-3">
        <Link href="/proof" className={`group ${buttonPrimary} min-h-12 rounded-full px-6 text-base`}>
          See the live proof
          <Icon name="arrow-right" className="size-4 transition-transform duration-150 ease-(--ease-out) group-hover:translate-x-0.5" />
        </Link>
        <Link href="/" className={`${buttonSecondary} min-h-12 rounded-full px-6 text-base`}>
          Back to the start
        </Link>
      </div>
    </div>
  );
}
