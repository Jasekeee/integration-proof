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

/** The proof page, loading: the title, both scores and the six rows, at their sizes. */
function ProofSkeleton({ label }: { label: string }) {
  return (
    <div className="mx-auto flex min-h-svh w-full max-w-6xl flex-col px-4 pb-24 sm:px-6" role="status">
      <span className="sr-only">{label}</span>
      <div className="flex flex-col items-center pb-8 pt-12 sm:pb-12 sm:pt-16" aria-hidden="true">
        <div className={`h-12 w-[min(42rem,90%)] sm:h-16 ${block}`} />
        <div className={`mt-5 h-6 w-80 max-w-[80%] ${block}`} />
        <div className="mt-10 grid w-full max-w-2xl grid-cols-2 gap-4">
          {[0, 1].map((index) => (
            <div key={index} className="flex flex-col items-center gap-3">
              <div className={`h-[clamp(4rem,9vw,7.5rem)] w-[70%] ${block}`} />
              <div className={`h-5 w-32 ${block}`} />
            </div>
          ))}
        </div>
        <div className={`mt-8 h-5 w-[30rem] max-w-[90%] ${block}`} />
        <div className={`mt-8 h-12 w-56 rounded-full ${block}`} />
      </div>
      <div className="border-t border-border" aria-hidden="true">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="flex items-center gap-6 border-b border-border px-1 py-6 sm:px-5">
            <div className={`h-6 w-56 max-w-[45%] ${block}`} />
            <div className={`ml-auto h-5 w-40 max-md:hidden ${block}`} />
            <div className={`h-5 w-40 max-md:hidden ${block}`} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** The proof page or a run page, loading. */
export function ResultsSkeleton({ columns, label }: { columns: 1 | 2; label: string }) {
  if (columns === 2) return <ProofSkeleton label={label} />;
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
