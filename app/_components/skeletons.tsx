// What a results page looks like while its data loads: the same blocks at the same sizes, so the
// page does not jump when the content arrives. Shapes only, no made-up numbers.

const block = "rounded-control bg-surface-2 motion-safe:animate-pulse";

/** A results page, loading: the title, one score per store and the six rows, at their sizes. */
function ProofSkeleton({ label, stores }: { label: string; stores: 1 | 2 }) {
  return (
    <div className="mx-auto flex min-h-svh w-full max-w-6xl flex-col px-4 pb-24 sm:px-6" role="status">
      <span className="sr-only">{label}</span>
      <div className="flex flex-col items-center pb-[4.5rem] pt-12 sm:pb-14 sm:pt-16" aria-hidden="true">
        <div className={`h-12 w-[min(42rem,90%)] sm:h-16 ${block}`} />
        <div className={`mt-5 h-6 w-80 max-w-[80%] ${block}`} />
        <div className={`mt-10 grid w-full max-w-2xl gap-4 ${stores === 2 ? "grid-cols-2" : ""}`}>
          {Array.from({ length: stores }, (_, index) => (
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
            {stores === 2 && <div className={`h-5 w-40 max-md:hidden ${block}`} />}
          </div>
        ))}
      </div>
    </div>
  );
}

/** The proof page or a run page, loading. */
export function ResultsSkeleton({ columns, label }: { columns: 1 | 2; label: string }) {
  return <ProofSkeleton label={label} stores={columns} />;
}
