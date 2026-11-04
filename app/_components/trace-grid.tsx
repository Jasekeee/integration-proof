"use client";

// The trace of one scenario in AG Grid Community. Loaded on demand and only in the browser.
import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef, type GridApi } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { traceRow, type StepView, type TraceRow } from "./report";

ModuleRegistry.registerModules([AllCommunityModule]);

/** The grid takes its colors from the site's tokens, so it follows the light and dark themes. */
const theme = themeQuartz.withParams({
  backgroundColor: "var(--surface)",
  foregroundColor: "var(--foreground)",
  borderColor: "var(--border)",
  headerBackgroundColor: "var(--surface-2)",
  headerTextColor: "var(--muted)",
  oddRowBackgroundColor: "var(--surface)",
  rowHoverColor: "var(--surface-2)",
  accentColor: "var(--ring)",
  fontFamily: "var(--font-geist-sans)",
  fontSize: 13,
  headerFontSize: 12,
  spacing: 6,
  wrapperBorderRadius: 8,
});

const mono = { fontFamily: "var(--font-geist-mono)" };

const COLUMNS: ColDef<TraceRow>[] = [
  { field: "seq", headerName: "Step", width: 72, valueFormatter: (p) => `#${p.value}`, cellStyle: mono },
  { field: "actor", headerName: "Actor", width: 96 },
  { field: "call", headerName: "Call", flex: 2, minWidth: 260, wrapText: true, autoHeight: true, cellStyle: { ...mono, lineHeight: "1.5" } },
  { field: "httpStatus", headerName: "HTTP", width: 80, cellStyle: mono, valueFormatter: (p) => (p.value === null ? "–" : String(p.value)) },
  {
    field: "durationMs",
    headerName: "Duration",
    width: 104,
    type: "rightAligned",
    cellStyle: mono,
    valueFormatter: (p) => (p.value >= 1000 ? `${(p.value / 1000).toFixed(1)} s` : `${p.value} ms`),
  },
  { field: "debugId", headerName: "debug_id", width: 148, cellStyle: mono, valueFormatter: (p) => p.value ?? "–" },
  { field: "detail", headerName: "Detail", flex: 3, minWidth: 280, wrapText: true, autoHeight: true, cellStyle: { lineHeight: "1.5" } },
];

export default function TraceGrid({ steps, highlightSeq }: { steps: StepView[]; highlightSeq: number | null }) {
  const rows = useMemo(() => steps.map(traceRow), [steps]);
  const container = useRef<HTMLDivElement>(null);
  const [api, setApi] = useState<GridApi<TraceRow> | null>(null);
  const rowClassRules = useMemo(
    () => ({ "trace-highlight": (params: { data?: TraceRow }) => params.data?.seq === highlightSeq }),
    [highlightSeq],
  );

  // An evidence link scrolls its step into view and marks it.
  useEffect(() => {
    if (!api || highlightSeq === null) return;
    api.redrawRows();
    const frame = requestAnimationFrame(() => {
      const row = container.current?.querySelector(`.ag-center-cols-container [row-id="${highlightSeq}"]`);
      const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      row?.scrollIntoView({ block: "center", behavior: smooth ? "smooth" : "auto" });
    });
    return () => cancelAnimationFrame(frame);
  }, [api, highlightSeq, rowClassRules]);

  return (
    <div ref={container} className="w-full">
      <AgGridReact<TraceRow>
        theme={theme}
        rowData={rows}
        columnDefs={COLUMNS}
        getRowId={(params) => String(params.data.seq)}
        rowClassRules={rowClassRules}
        domLayout="autoHeight"
        suppressCellFocus
        onGridReady={(event) => setApi(event.api)}
      />
    </div>
  );
}
