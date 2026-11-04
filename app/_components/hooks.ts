"use client";

import { useEffect, useState } from "react";
import { isSettled, type RunReport } from "./report";

const POLL_MS = 2000;
/** A poll that hangs is abandoned and tried again, so a stalled request never stops the page. */
const POLL_TIMEOUT_MS = 15_000;

/**
 * Follows one run until nothing more will change. One request at a time: the next poll is
 * scheduled after the previous answer, and an answer for another run id is dropped, so a slow
 * response can never replace a newer one or another run's report.
 */
export function useRunReport(runId: string | null, initial: RunReport | null): RunReport | null {
  const [state, setState] = useState<{ runId: string | null; report: RunReport | null }>({
    runId: initial?.id ?? null,
    report: initial,
  });

  useEffect(() => {
    if (!runId) return;
    if (initial?.id === runId && isSettled(initial)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const response = await fetch(`/api/runs/${runId}/report`, {
          cache: "no-store",
          signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
        });
        if (response.ok) {
          const report = (await response.json()) as RunReport;
          if (cancelled || report.id !== runId) return;
          setState({ runId, report });
          if (isSettled(report)) return;
        }
      } catch {
        // A failed poll is retried on the next tick.
      }
      if (!cancelled) timer = setTimeout(poll, POLL_MS);
    };
    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [runId, initial]);

  // Until the first poll answers for a new run, the report it was started with stands in.
  if (state.runId === runId) return state.report;
  return initial?.id === runId ? initial : null;
}

/** The current time, every second while active; for elapsed-seconds labels. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
