"use client";

// The trace of one scenario in AG Grid Community. Loaded on demand and only in the browser.
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type ColDef,
  type GridApi,
  type ICellRendererParams,
} from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { repeatedRequestIds, shortRequestId, traceRow, type StepView, type TraceRow } from "./report";

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
  wrapperBorderRadius: 10,
});

const mono = { fontFamily: "var(--font-geist-mono)" };

interface GridContext {
  /** Repeated PayPal-Request-Id values and their color slots. */
  keyColors: Map<string, number>;
}

/** A PayPal-Request-Id, short; a key that repeats in this trace carries its color. None reads "—". */
function RequestIdCell({ value, context }: ICellRendererParams<TraceRow, string | null, GridContext>) {
  if (!value) return <span className="text-muted">—</span>;
  const slot = context.keyColors.get(value);
  return (
    <span
      title={value}
      className={slot === undefined ? "" : `request-key-${slot} rounded px-1.5 py-0.5 font-semibold`}
    >
      {shortRequestId(value)}
    </span>
  );
}

/**
 * The columns in reading order. debug_id is the id PayPal finds a request by: on a narrow screen,
 * where the grid scrolls sideways, it is pinned to the right edge so it stays in view.
 */
function columns(narrow: boolean): ColDef<TraceRow>[] {
  return [
    { field: "seq", headerName: "Step", width: 68, valueFormatter: (p) => `#${p.value}`, cellStyle: mono },
    { field: "actor", headerName: "Actor", width: 90 },
    { field: "call", headerName: "Call", flex: 3, minWidth: 240, wrapText: true, autoHeight: true, cellStyle: { ...mono, lineHeight: "1.5" } },
    { field: "httpStatus", headerName: "HTTP", width: 72, cellStyle: mono, valueFormatter: (p) => (p.value === null ? "–" : String(p.value)) },
    {
      field: "durationMs",
      headerName: "Duration",
      width: 96,
      type: "rightAligned",
      cellStyle: mono,
      valueFormatter: (p) => (p.value >= 1000 ? `${(p.value / 1000).toFixed(1)} s` : `${p.value} ms`),
    },
    {
      field: "debugId",
      headerName: "debug_id",
      width: 132,
      pinned: narrow ? "right" : null,
      cellStyle: mono,
      valueFormatter: (p) => p.value ?? "–",
    },
    { field: "paypalRequestId", headerName: "PayPal-Request-Id", width: 156, cellStyle: mono, cellRenderer: RequestIdCell },
    { field: "detail", headerName: "Detail", flex: 2, minWidth: 260, wrapText: true, autoHeight: true, cellStyle: { lineHeight: "1.5" } },
  ];
}

const WIDE = "(min-width: 1024px)";

/** True below the width at which every column fits; false on the server. */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const query = window.matchMedia(WIDE);
    const update = () => setNarrow(!query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return narrow;
}

export default function TraceGrid({
  steps,
  highlightSeq,
  selectedSeq,
  onSelect,
}: {
  steps: StepView[];
  highlightSeq: number | null;
  selectedSeq: number | null;
  onSelect: (seq: number) => void;
}) {
  const rows = useMemo(() => steps.map(traceRow), [steps]);
  const narrow = useNarrow();
  const columnDefs = useMemo(() => columns(narrow), [narrow]);
  const context = useMemo<GridContext>(() => ({ keyColors: repeatedRequestIds(steps) }), [steps]);
  const container = useRef<HTMLDivElement>(null);
  const [api, setApi] = useState<GridApi<TraceRow> | null>(null);
  const rowClassRules = useMemo(
    () => ({
      "trace-highlight": (params: { data?: TraceRow }) => params.data?.seq === highlightSeq,
      "trace-selected": (params: { data?: TraceRow }) => params.data?.seq === selectedSeq,
    }),
    [highlightSeq, selectedSeq],
  );

  useEffect(() => {
    api?.redrawRows();
  }, [api, rowClassRules]);

  // An evidence link scrolls its step into view and marks it.
  useEffect(() => {
    if (!api || highlightSeq === null) return;
    const frame = requestAnimationFrame(() => {
      const row = container.current?.querySelector(`.ag-row[row-id="${highlightSeq}"]`);
      const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      row?.scrollIntoView({ block: "center", behavior: smooth ? "smooth" : "auto" });
    });
    return () => cancelAnimationFrame(frame);
  }, [api, highlightSeq]);

  return (
    <div ref={container} className="w-full [&_.ag-row]:cursor-pointer">
      <AgGridReact<TraceRow>
        theme={theme}
        rowData={rows}
        columnDefs={columnDefs}
        context={context}
        getRowId={(params) => String(params.data.seq)}
        rowClassRules={rowClassRules}
        domLayout="autoHeight"
        onGridReady={(event) => setApi(event.api)}
        onRowClicked={(event) => event.data && onSelect(event.data.seq)}
        onCellKeyDown={(event) => {
          const key = (event.event as KeyboardEvent | null)?.key;
          if ((key === "Enter" || key === " ") && event.data) onSelect(event.data.seq);
        }}
      />
    </div>
  );
}
