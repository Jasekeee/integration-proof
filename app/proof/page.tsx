// Both stores side by side, with their latest runs, and a button that runs both.
import type { Metadata } from "next";
import { ProofComparison } from "../_components/proof-comparison";
import type { RunReport } from "../_components/report";
import { freshAllowed } from "@/lib/proof/limits";
import { latestRunIds, readReport } from "@/lib/proof/report";
import { readStoreCode } from "@/lib/store/snippets";

export const metadata: Metadata = {
  title: "Six bad days, two stores",
  description:
    "The same six PayPal failures, injected in the sandbox, against a store with common mistakes and the same store fixed. Code decides every verdict; Claude explains each failure.",
};

/** Plain JSON, as the report API returns it, so the first paint and later polls match. */
async function loadReport(runId: string | null): Promise<RunReport | null> {
  if (!runId) return null;
  const report = await readReport(runId);
  return report ? (JSON.parse(JSON.stringify(report)) as RunReport) : null;
}

export default async function ProofPage({ searchParams }: PageProps<"/proof">) {
  // Only the operator's token turns live analysis on; any other value leaves the page as it is.
  const given = (await searchParams).fresh;
  const freshToken = typeof given === "string" && freshAllowed(given) ? given : null;
  const code = await readStoreCode();
  let initial: Record<"naive" | "hardened", RunReport | null> = { naive: null, hardened: null };
  let loadError = false;
  try {
    const ids = await latestRunIds();
    const [naive, hardened] = await Promise.all([loadReport(ids.naive), loadReport(ids.hardened)]);
    initial = { naive, hardened };
  } catch (error) {
    console.error("Could not load the latest runs", error);
    loadError = true;
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col px-4 pb-24 sm:px-6">
      <ProofComparison initial={initial} freshToken={freshToken} code={code} loadError={loadError} />
    </div>
  );
}
