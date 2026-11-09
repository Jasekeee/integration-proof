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
import { TraceText } from "./trace-text";
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
  // An evidence link's row flashes in this color, then fades to the resting highlight.
  valueChangeValueHighlightBackgroundColor: "color-mix(in srgb, var(--ring) 24%, var(--highlight-bg))",
  fontFamily: "var(--font-geist-sans)",
  fontSize: 13,
  headerFontSize: 12,
  spacing: 6,
  wrapperBorderRadius: 10,
});

/** Mono only for what is code or an id: the call, debug_id and PayPal-Request-Id. Numbers stay in the text face. */
const mono = { fontFamily: "var(--font-geist-mono)" };
const numbers = { fontVariantNumeric: "tabular-nums" };

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
      data-request-key={slot === undefined ? undefined : value}
      className={slot === undefined ? "" : `request-key-${slot} rounded px-1.5 py-0.5 font-semibold`}
    >
      {shortRequestId(value)}
    </span>
  );
}

/**
 * The call or the detail: each webhook event on its own line, a path or an event name broken only
 * between its parts, never inside an order id.
 */
function TextCell({ value }: ICellRendererParams<TraceRow, string | null>) {
  return value ? <TraceText text={value} /> : null;
}

/**
 * The columns in reading order. From 1280 px every column fits the scenario's width (the minimums add
 * up to 994 px); Call and Detail wrap instead of widening. debug_id is the id PayPal finds a request
 * by: on a narrow screen, where the grid scrolls sideways, it is pinned to the right edge so it stays
 * in view.
 */
function columns(narrow: boolean): ColDef<TraceRow>[] {
  return [
    { field: "seq", headerName: "Step", width: 68, valueFormatter: (p) => `#${p.value}`, cellStyle: numbers },
    { field: "actor", headerName: "Actor", width: 90 },
    { field: "call", headerName: "Call", flex: 3, minWidth: 200, wrapText: true, autoHeight: true, cellStyle: { ...mono, lineHeight: "1.5" }, cellRenderer: TextCell },
    { field: "httpStatus", headerName: "HTTP", width: 72, cellStyle: numbers, valueFormatter: (p) => (p.value === null ? "–" : String(p.value)) },
    {
      field: "durationMs",
      headerName: "Duration",
      width: 96,
      type: "rightAligned",
      cellStyle: numbers,
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
    { field: "detail", headerName: "Detail", flex: 2, minWidth: 180, wrapText: true, autoHeight: true, cellStyle: { lineHeight: "1.5" }, cellRenderer: TextCell },
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
  // A new set of rules is applied to the rows in place: no redraw, so a selected id stays selected.
  const rowClassRules = useMemo(
    () => ({
      "trace-highlight": (params: { data?: TraceRow }) => params.data?.seq === highlightSeq,
      "trace-selected": (params: { data?: TraceRow }) => params.data?.seq === selectedSeq,
    }),
    [highlightSeq, selectedSeq],
  );

  // An evidence link scrolls its step into view and marks it; with motion the row flashes first, then
  // keeps the resting highlight.
  useEffect(() => {
    if (!api || highlightSeq === null) return;
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let flash: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => {
      const row = container.current?.querySelector(`.ag-row[row-id="${highlightSeq}"]`);
      row?.scrollIntoView({ block: "center", behavior: smooth ? "smooth" : "auto" });
      const node = api.getRowNode(String(highlightSeq));
      if (smooth && node) flash = setTimeout(() => api.flashCells({ rowNodes: [node], flashDuration: 500, fadeDuration: 900 }), 250);
    });
    return () => {
      cancelAnimationFrame(frame);
      if (flash) clearTimeout(flash);
    };
  }, [api, highlightSeq]);

  /** Marks every cell that carries the same repeated PayPal-Request-Id, or clears the marks. */
  function markKey(key: string | null) {
    const root = container.current;
    if (!root) return;
    root.querySelectorAll(".key-hover").forEach((element) => element.classList.remove("key-hover"));
    if (key) root.querySelectorAll(`[data-request-key="${CSS.escape(key)}"]`).forEach((element) => element.classList.add("key-hover"));
  }

  return (
    <div
      ref={container}
      className="w-full [&_.ag-row]:cursor-pointer"
      onPointerOver={(event) => markKey((event.target as Element).closest("[data-request-key]")?.getAttribute("data-request-key") ?? null)}
      onPointerLeave={() => markKey(null)}
    >
      <AgGridReact<TraceRow>
        theme={theme}
        rowData={rows}
        columnDefs={columnDefs}
        context={context}
        getRowId={(params) => String(params.data.seq)}
        rowClassRules={rowClassRules}
        domLayout="autoHeight"
        // Once the rows are drawn, not when the grid is ready: the evidence link that opened this trace
        // scrolls to a row, which must exist by then.
        onFirstDataRendered={(event) => setApi(event.api)}
        // Ids can be selected and copied; a drag that selects text does not open the step.
        enableCellTextSelection
        onRowClicked={(event) => {
          if (event.data && !window.getSelection()?.toString()) onSelect(event.data.seq);
        }}
        onCellFocused={(event) => {
          // From the keyboard too: a focused Request-Id cell marks its twins.
          const column = typeof event.column === "object" && event.column ? event.column.getColId() : null;
          const row = event.rowIndex === null || event.rowIndex === undefined ? null : event.api.getDisplayedRowAtIndex(event.rowIndex);
          markKey(column === "paypalRequestId" && context.keyColors.has(row?.data?.paypalRequestId ?? "") ? (row?.data?.paypalRequestId ?? null) : null);
        }}
        onCellKeyDown={(event) => {
          const key = (event.event as KeyboardEvent | null)?.key;
          if ((key === "Enter" || key === " ") && event.data) onSelect(event.data.seq);
        }}
      />
    </div>
  );
}
