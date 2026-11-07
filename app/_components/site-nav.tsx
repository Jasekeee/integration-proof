"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "./icon";
import { GITHUB_URL } from "./site";

const navLink =
  "inline-flex min-h-10 items-center gap-1 rounded-control px-2 text-sm text-muted transition-colors duration-150 hover:text-foreground aria-[current=page]:font-medium aria-[current=page]:text-foreground";

/** The header's links; the page the visitor is on is marked for sight and for screen readers. */
export function SiteNav() {
  const path = usePathname();
  const onProof = path === "/proof" || path.startsWith("/proof/");
  return (
    <div className="flex items-center gap-1">
      <Link href="/proof" className={navLink} aria-current={onProof ? "page" : undefined}>
        Live proof
      </Link>
      <Link href="/#how-it-works" className={`${navLink} max-sm:hidden`}>
        How it works
      </Link>
      <a href={GITHUB_URL} className={navLink}>
        GitHub
        <Icon name="arrow-up-right" className="size-3.5" />
      </a>
    </div>
  );
}
