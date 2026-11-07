// One scenario of a run: its section on the run's page, where the cards, Claude's analysis and the
// trace already are. A short address to share, not a second view of the same report.
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { SCENARIO_TITLES } from "../../../_components/report";

export default async function ScenarioReportPage({ params }: PageProps<"/proof/[runId]/[scenarioId]">) {
  const { runId, scenarioId } = await params;
  const id = scenarioId.toUpperCase();
  if (!z.uuid().safeParse(runId).success || !Object.hasOwn(SCENARIO_TITLES, id)) notFound();
  // The section ids come from ScenarioSection (app/_components/scenario-section.tsx).
  redirect(`/proof/${runId}#scenario-${id}`);
}
