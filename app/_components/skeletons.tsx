// What a results page looks like while its data loads: the same blocks at the same sizes, so the
// page does not jump when the content arrives. Shapes only, no made-up numbers.

const block = "rounded-control bg-surface-2 motion-safe:animate-pulse";

function MatrixSkeleton({ columns }: { columns: number }) {
  return (
    <div className="overflow-hidden rounded-panel border border-border" aria-hidden="true">
      <div className="flex gap-6 border-b border-border bg-surface p-4">
        {Array.from({ length: columns }, (_, index) => (
          <div key={index} className="flex flex-1 flex-col gap-2">
            <div className={`h-5 w-28 ${block}`} />
            <div className={`h-10 w-20 ${block}`} />
            <div className={`h-4 w-48 max-w-full ${block}`} />
          </div>
        ))}
      </div>
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="flex items-center gap-6 border-b border-border px-4 py-3 last:border-b-0">
          <div className={`h-5 w-56 max-w-[40%] ${block}`} />
          <div className={`ml-auto h-6 w-14 ${block}`} />
          {columns > 1 && <div className={`h-6 w-14 ${block}`} />}
        </div>
      ))}
    </div>
  );
}

/** The proof page or a run page, loading. */
export function ResultsSkeleton({ columns, label }: { columns: 1 | 2; label: string }) {
  return (
    // At least a screen tall, so the footer stays below the fold and does not jump when the page arrives.
    <div className="mx-auto flex min-h-svh w-full max-w-7xl flex-col gap-6 px-4 py-10 sm:px-6" role="status">
      <span className="sr-only">{label}</span>
      <div className="flex flex-col gap-3" aria-hidden="true">
        <div className={`h-9 w-72 max-w-full ${block}`} />
        <div className={`h-5 w-[36rem] max-w-full ${block}`} />
        <div className={`h-5 w-[28rem] max-w-full ${block}`} />
      </div>
      <MatrixSkeleton columns={columns} />
    </div>
  );
}
