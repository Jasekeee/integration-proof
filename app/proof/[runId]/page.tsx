// The results of one run at a permanent, shareable address.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { MODE_LABELS, type RunReport } from "../../_components/report";
import { RunResults } from "../../_components/run-results";
import { readReport } from "@/lib/proof/report";

async function load(runId: string): Promise<RunReport | null> {
  if (!z.uuid().safeParse(runId).success) return null;
  const report = await readReport(runId);
  return report ? (JSON.parse(JSON.stringify(report)) as RunReport) : null;
}

export async function generateMetadata({ params }: PageProps<"/proof/[runId]">): Promise<Metadata> {
  const report = await load((await params).runId);
  if (!report) return { title: "Run not found" };
  const title = `${MODE_LABELS[report.mode].name}: ${report.summary.passed} of ${report.summary.total} passed`;
  return { title, description: `A proof run of six PayPal failure scenarios against the ${report.mode} store.` };
}

export default async function RunPage({ params }: PageProps<"/proof/[runId]">) {
  const report = await load((await params).runId);
  if (!report) notFound();

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-10 sm:px-6">
      <header className="flex flex-col gap-2">
        <p className="font-mono text-xs text-muted">
          Run {report.id.slice(0, 8)} · {new Date(report.createdAt).toUTCString()}
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">{MODE_LABELS[report.mode].name}: proof run</h1>
        <p className="text-muted">
          <Link href="/proof" className="underline underline-offset-4 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
            Compare both stores
          </Link>
        </p>
      </header>
      <RunResults initial={report} />
    </div>
  );
}
