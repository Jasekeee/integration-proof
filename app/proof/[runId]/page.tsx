// The results of one run at a permanent, shareable address.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { MODE_LABELS, type RunReport } from "../../_components/report";
import { RunResults } from "../../_components/run-results";
import { readReport } from "@/lib/proof/report";
import { readStoreCode } from "@/lib/store/snippets";

async function load(runId: string): Promise<RunReport | null> {
  if (!z.uuid().safeParse(runId).success) return null;
  const report = await readReport(runId);
  return report ? (JSON.parse(JSON.stringify(report)) as RunReport) : null;
}

/** app/opengraph-image.png; a page that sets its own openGraph has to name the image again. */
const SITE_IMAGE = { url: "/opengraph-image.png", width: 1200, height: 630, alt: "Integration Proof: one lost response, and the buyer pays twice." };

/** The line a shared link previews with: what the run cost, or that nothing went wrong. */
function shareDescription(report: RunReport): string {
  const tail = "Six PayPal failures, judged by code, explained by Claude.";
  if (report.status === "QUEUED" || report.status === "RUNNING") return `A proof run in progress. ${tail}`;
  if (report.consequences.length > 0) return `${report.consequences.join(" · ")}. ${tail}`;
  if (report.status === "COMPLETED" && report.summary.passed === report.summary.total) {
    return `All ${report.summary.total} failures handled, nothing charged or shipped twice. ${tail}`;
  }
  return tail;
}

export async function generateMetadata({ params }: PageProps<"/proof/[runId]">): Promise<Metadata> {
  const report = await load((await params).runId);
  if (!report) return { title: "Run not found" };
  const title = `${MODE_LABELS[report.mode].name}: ${report.summary.passed} of ${report.summary.total} passed`;
  const description = shareDescription(report);
  return {
    title,
    description,
    // The site's preview image stays; only the words change per run.
    openGraph: { title: `${title} · Integration Proof`, description, type: "website", images: [SITE_IMAGE] },
    twitter: { card: "summary_large_image", title: `${title} · Integration Proof`, description, images: [SITE_IMAGE] },
  };
}

export default async function RunPage({ params }: PageProps<"/proof/[runId]">) {
  const report = await load((await params).runId);
  if (!report) notFound();
  const code = await readStoreCode();
  const other = report.mode === "naive" ? "hardened" : "naive";

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-10 sm:px-6">
      <header className="flex flex-col gap-2">
        <p className="font-mono text-xs text-muted">
          Run {report.id.slice(0, 8)} · {new Date(report.createdAt).toUTCString()}
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">{MODE_LABELS[report.mode].name}: proof run</h1>
        <p className="max-w-3xl leading-relaxed text-muted">
          Integration Proof runs six PayPal failures against a store in the sandbox. This is one run of the {report.mode}{" "}
          store.{" "}
          <Link href="/proof" className="text-brand underline underline-offset-4 hover:opacity-80 focus-visible:outline-2 focus-visible:outline-ring">
            Compare with the {other} store <span aria-hidden="true">→</span>
          </Link>
        </p>
      </header>
      <RunResults initial={report} code={code} />
    </div>
  );
}
