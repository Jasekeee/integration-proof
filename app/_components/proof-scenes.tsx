"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "./icon";
import { useChanges } from "./motion";
import {
  cellState,
  FALLBACK_HEADLINES,
  MODE_LABELS,
  plainHeadline,
  SCENARIO_TITLES,
  type CellState,
  type Mode,
  type ScenarioView,
  type StoreCode,
} from "./report";
import { ScenarioSection } from "./scenario-section";
import { PLAIN_CAUSES, story, storyMode, type Story } from "./story";
import { buttonSmall } from "./ui";

const MODES: Mode[] = ["naive", "hardened"];

/** The DOM id of a scenario's row and of its scene. */
export const rowId = (id: string) => `row-${id}`;
export const sceneId = (id: string) => `scene-${id}`;

/** What a store's cell says: the verdict's headline in plain words, or what the run is doing right now. */
function outcome(scenario: ScenarioView | null, state: CellState, now: number): string {
  if (!scenario) return "Not run yet";
  if (state === "QUEUED") return "Queued";
  if (state === "RUNNING") return "Running";
  if (state === "WAITING") {
    const waited = scenario.waitingSince ? Math.max(0, Math.floor((now - Date.parse(scenario.waitingSince)) / 1000)) : 0;
    return `Waiting for PayPal · ${waited} s`;
  }
  if (state === "ERROR") return "Could not run";
  if (scenario.headline) return plainHeadline(scenario.headline);
  if (state === "INCONCLUSIVE") return "PayPal did not deliver in time";
  return (state === "PASS" || state === "FAIL" ? FALLBACK_HEADLINES[scenario.id]?.[state] : null) ?? scenario.statusLabel;
}

const DOT: Partial<Record<CellState, string>> = {
  PASS: "bg-pass",
  FAIL: "bg-fail",
  INCONCLUSIVE: "bg-warn",
  WAITING: "live-dot bg-warn",
};

/**
 * One store's outcome in a row. The naive store's failures read red; the hardened store's passes
 * stay calm, with the green in the dot. A change seen live slides in.
 */
function Outcome({
  mode,
  scenario,
  now,
  dimmed,
  labelled,
}: {
  mode: Mode;
  scenario: ScenarioView | null;
  now: number;
  dimmed: boolean;
  /** Next to the other store's outcome, a phone row names the store. */
  labelled: boolean;
}) {
  const state = cellState(scenario);
  const changes = useChanges(state);
  const text = outcome(scenario, state, now);
  const color = state === "FAIL" ? "text-fail" : state === "INCONCLUSIVE" ? "text-warn" : state === "PASS" ? "text-foreground" : "text-muted";
  return (
    <span className={`flex min-w-0 items-baseline gap-2.5 transition-opacity duration-200 ${dimmed ? "opacity-60" : ""}`}>
      {labelled && <span className="w-[4.75rem] shrink-0 text-small text-muted md:sr-only">{MODE_LABELS[mode].name.split(" ")[0]}</span>}
      <span aria-hidden="true" className="relative top-[-1px] flex size-2 shrink-0 self-center">
        {state === "RUNNING" ? <span className="spinner size-2.5" /> : <span className={`size-2 rounded-full ${DOT[state] ?? "bg-border-strong"}`} />}
      </span>
      <span key={changes} className={`min-w-0 text-[15px] leading-6 sm:text-base ${color} ${changes > 0 ? "headline-enter" : ""}`} suppressHydrationWarning>
        {text}
      </span>
    </span>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className={`size-4 shrink-0 text-muted transition-transform duration-300 ease-(--ease-out) ${open ? "rotate-180" : ""}`}>
      <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const check = (
  <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4 shrink-0 text-pass">
    <path d="m3.5 8.4 2.8 2.8 6.2-6.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const panel = "rounded-panel bg-background p-5 sm:p-6";

/** The story's frames: plain sentences, the outcome last, in red or green. */
function Frames({ told, play }: { told: Story; play: boolean }) {
  return (
    <ol className="grid gap-2 sm:grid-cols-2 sm:gap-3 lg:grid-cols-4">
      {told.frames.map((frame, index) => {
        const tone = frame.tone === "fail" ? "bg-fail-bg text-fail" : frame.tone === "pass" ? "bg-pass-bg text-pass" : "bg-background";
        return (
          <li
            key={index}
            className={`flex rounded-panel px-5 py-4 text-xl font-medium leading-tight tracking-tight text-balance sm:min-h-[8.25rem] sm:items-end sm:p-6 sm:pt-10 lg:text-[1.375rem] ${tone} ${play ? "frame-enter" : ""}`}
            style={play ? ({ "--i": index } as React.CSSProperties) : undefined}
          >
            <span>
              {frame.text}
              {frame.quote && (
                <>
                  {" "}
                  <q className="[quotes:'“'_'”']">{frame.quote}</q>
                </>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * One scenario in plain words: the frames of the store that failed, the other store in one line,
 * why it happened, and whether Claude's fix was verified. Everything technical, Claude's own
 * analysis, the code and the trace, waits behind "Show technical details".
 */
function Scene({
  id,
  modes,
  scenarios,
  now,
  deadlineMs,
  code,
  dimmed,
  play,
}: {
  id: string;
  modes: Mode[];
  scenarios: Record<Mode, ScenarioView | null>;
  now: number;
  deadlineMs: Record<Mode, number>;
  code: StoreCode;
  dimmed: Record<Mode, boolean>;
  play: boolean;
}) {
  const [tech, setTech] = useState(false);
  /** Bumped by "Claude's full analysis": the technical layer opens again with the analysis unfolded. */
  const [analysisRequest, setAnalysisRequest] = useState(0);
  const [unfolded, setUnfolded] = useState<Record<Mode, boolean>>({ naive: true, hardened: true });
  const techRef = useRef<HTMLDivElement>(null);
  const main = modes.length === 1 ? modes[0] : storyMode(scenarios);
  const other: Mode | null = modes.length === 1 ? null : main === "naive" ? "hardened" : "naive";
  const told = story(scenarios[main]);
  const otherTold = other ? story(scenarios[other]) : null;
  const failed = scenarios[main]?.verdict === "FAIL";
  const bothPassed = scenarios.naive?.verdict === "PASS" && scenarios.hardened?.verdict === "PASS";
  const analysis = scenarios[main]?.analysis ?? null;
  const verified = failed && analysis?.status === "READY" && analysis.fixCheck?.verified === true;
  const cause = failed && main === "naive" ? PLAIN_CAUSES[id] : bothPassed ? "Both stores read PayPal’s answer and acted on it." : null;
  const techId = `${sceneId(id)}-tech`;

  function openAnalysis() {
    setTech(true);
    setUnfolded({ naive: true, hardened: true });
    setAnalysisRequest((count) => count + 1);
    requestAnimationFrame(() => {
      const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      techRef.current?.scrollIntoView({ block: "start", behavior: smooth ? "smooth" : "auto" });
    });
  }

  return (
    <div className="flex flex-col gap-3 px-3 pb-8 pt-2 sm:px-5 sm:pb-10">
      <p className="pt-2 text-small text-muted">{MODE_LABELS[main].name}</p>
      {told ? (
        <Frames told={told} play={play} />
      ) : (
        <p className={`${panel} text-xl font-medium leading-snug tracking-tight`}>{outcome(scenarios[main], cellState(scenarios[main]), now)}</p>
      )}

      {(other || cause) && (
        <div
          className={`grid gap-2 sm:gap-3 ${cause && other ? "md:grid-cols-2" : ""} ${play ? "after-enter" : ""}`}
          style={play && told ? ({ "--i": told.frames.length } as React.CSSProperties) : undefined}
        >
          {other && (
            <div className={panel}>
              <p className="text-small text-muted">{MODE_LABELS[other].name}</p>
              <p className="mt-2 text-xl font-medium leading-snug tracking-tight text-balance">
                {otherTold ? (
                  <>
                    {otherTold.short.did} <span aria-hidden="true">→</span>
                    <span className="sr-only">, so:</span>{" "}
                    <span className={otherTold.short.tone === "pass" ? "text-pass" : "text-fail"}>{otherTold.short.got}</span>
                  </>
                ) : (
                  outcome(scenarios[other], cellState(scenarios[other]), now)
                )}
              </p>
            </div>
          )}
          {cause && (
            <div className={panel}>
              <p className="text-small text-muted">{failed ? "Why it happened" : "Why it worked"}</p>
              <p className="mt-2 text-xl leading-snug tracking-tight text-balance">{cause}</p>
            </div>
          )}
        </div>
      )}

      <div className={`flex flex-wrap items-center justify-between gap-3 pt-2 ${play ? "after-enter" : ""}`} style={play && told ? ({ "--i": told.frames.length } as React.CSSProperties) : undefined}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {verified && (
            <span className="inline-flex min-h-10 items-center gap-2 rounded-full bg-background px-4 text-[15px]">
              {check}
              <span>
                Claude’s fix verified offline · <s className="text-fail decoration-[1.5px]">FAIL</s> <span aria-hidden="true">→</span>
                <span className="sr-only">then</span> <b className="font-semibold text-pass">PASS</b>
              </span>
            </span>
          )}
          {failed && analysis?.status === "PENDING" && (
            <span role="status" className="inline-flex min-h-10 items-center gap-2 text-[15px] text-muted">
              <span aria-hidden="true" className="spinner" />
              Claude is analyzing the failure…
            </span>
          )}
          {failed && analysis?.status === "READY" && (
            <button
              type="button"
              onClick={openAnalysis}
              aria-controls={techId}
              className="group inline-flex min-h-10 items-center gap-1 rounded-control text-[15px] font-medium text-brand"
            >
              Claude’s full analysis
              <Icon name="arrow-right" className="size-4 transition-transform duration-150 ease-(--ease-out) group-hover:translate-x-0.5" />
            </button>
          )}
        </div>
        <button type="button" aria-expanded={tech} aria-controls={techId} onClick={() => setTech((open) => !open)} className={`${buttonSmall} rounded-full px-4`}>
          {tech ? "Hide technical details" : "Show technical details"}
        </button>
      </div>

      <div id={techId} ref={techRef} hidden={!tech} className="scroll-mt-4 pt-3">
        {tech && (
          <div className="flex flex-col gap-3">
            <p className="text-small text-muted">
              Technical details · <span className="font-mono">{id}</span> · {SCENARIO_TITLES[id]}
            </p>
            <ScenarioSection
              key={analysisRequest}
              id={id}
              modes={modes}
              scenarios={scenarios}
              now={now}
              deadlineMs={deadlineMs}
              code={code}
              expanded={unfolded}
              onToggle={(mode) => setUnfolded((current) => ({ ...current, [mode]: !current[mode] }))}
              dimmed={dimmed}
              analysisOpen={analysisRequest > 0}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The six scenarios as rows: what goes wrong, in plain words, and what came of it in each store.
 * A row opens its scene below it; one scene is open at a time.
 */
export function ScenarioRows({
  ids,
  modes = MODES,
  scenariosOf,
  now,
  deadlineMs,
  code,
  dimmed,
}: {
  ids: string[];
  /** Both stores side by side, or the one store of a run's own page. */
  modes?: Mode[];
  scenariosOf: (id: string) => Record<Mode, ScenarioView | null>;
  now: number;
  deadlineMs: Record<Mode, number>;
  code: StoreCode;
  dimmed: Record<Mode, boolean>;
}) {
  const [open, setOpen] = useState<{ id: string; play: boolean } | null>(null);
  const both = modes.length > 1;
  const columns = both ? "md:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)_minmax(0,1fr)_1rem]" : "md:grid-cols-[minmax(0,1.25fr)_minmax(0,2fr)_1rem]";

  // A link to a scenario (#S3, or the run page's #scenario-S3) opens its scene, still.
  useEffect(() => {
    const id = location.hash.replace(/^#(scenario-|row-|scene-)?/, "");
    if (!ids.includes(id)) return;
    const frame = requestAnimationFrame(() => {
      setOpen({ id, play: false });
      document.getElementById(rowId(id))?.scrollIntoView({ block: "start" });
    });
    return () => cancelAnimationFrame(frame);
  }, [ids]);

  function toggle(id: string) {
    setOpen((current) => (current?.id === id ? null : { id, play: true }));
  }

  return (
    <section aria-label="Scenarios" className="border-t border-border">
      <div aria-hidden="true" className={`grid gap-6 border-b border-border px-5 py-3.5 text-small text-muted max-md:hidden ${columns}`}>
        <span>What goes wrong</span>
        {modes.map((mode) => (
          <span key={mode}>{both ? MODE_LABELS[mode].name : "What came of it"}</span>
        ))}
        <span />
      </div>
      <ul>
        {ids.map((id) => {
          const scenarios = scenariosOf(id);
          const expanded = open?.id === id;
          return (
            <li key={id} className="border-b border-border">
              <button
                type="button"
                id={rowId(id)}
                aria-expanded={expanded}
                aria-controls={sceneId(id)}
                onClick={() => toggle(id)}
                className={`grid w-full scroll-mt-4 grid-cols-[minmax(0,1fr)_1rem] items-center gap-x-3 gap-y-1.5 px-1 py-5 text-left transition-colors duration-150 hover:bg-surface focus-visible:-outline-offset-2 sm:px-5 sm:py-6 md:gap-6 ${columns} ${expanded ? "bg-surface" : ""}`}
              >
                <span className="text-lg font-medium tracking-tight sm:text-xl">{SCENARIO_TITLES[id] ?? id}</span>
                <span className={`col-start-2 row-start-1 ${both ? "md:col-start-4" : "md:col-start-3"}`}>
                  <Chevron open={expanded} />
                </span>
                {modes.map((mode, index) => (
                  <span key={mode} className={`col-span-2 md:col-span-1 md:row-start-1 ${index === 0 ? "md:col-start-2" : "md:col-start-3"}`}>
                    <Outcome mode={mode} scenario={scenarios[mode]} now={now} dimmed={dimmed[mode]} labelled={both} />
                  </span>
                ))}
              </button>
              <div id={sceneId(id)} role="region" aria-labelledby={rowId(id)} hidden={!expanded} className="bg-surface">
                {expanded && (
                  <Scene id={id} modes={modes} scenarios={scenarios} now={now} deadlineMs={deadlineMs} code={code} dimmed={dimmed} play={open.play} />
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

