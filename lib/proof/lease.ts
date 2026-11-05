// The runner's lease on a run. A run executes in the memory of the process that started it; when
// that process dies, as in a restart during a deploy, nothing else would ever finish the run. So the
// runner renews a heartbeat while it works, and a run whose heartbeat has lapsed, or that has run
// past its limit, is interrupted: its unfinished scenarios end INCONCLUSIVE and it blocks nothing.

/** How often the runner renews its lease. */
export const HEARTBEAT_MS = 5_000;
/** A lease not renewed for this long has lost its process: nine missed beats. */
export const LEASE_MS = 45_000;
/**
 * No run lasts longer, alive or not. The slowest live run waits 150 s for webhooks after up to
 * three store timeouts and retried PayPal calls; analyses continue after the run has finished.
 */
export const RUN_LIMIT_MS = 10 * 60_000;

export const INTERRUPTED_REASON = "Run interrupted: the server restarted while waiting for PayPal. Run again.";
export const OVERDUE_REASON = "Run stopped: it ran past its time limit. Run again.";
export const INTERRUPTED_HEADLINE = "Run interrupted";

export interface LeaseFacts {
  status: string;
  createdAt: Date;
  startedAt: Date | null;
  lastHeartbeatAt: Date | null;
}

/**
 * Whether a run still has a process working on it, and if not, why. A queued run that never started
 * counts from its creation; a running run from its last heartbeat, or its start for runs recorded
 * before heartbeats existed.
 */
export function leaseState(run: LeaseFacts, now = Date.now()): "finished" | "live" | "interrupted" | "overdue" {
  if (run.status !== "QUEUED" && run.status !== "RUNNING") return "finished";
  // A lapsed lease means the process is gone, however long ago the run began.
  const lastSign = (run.lastHeartbeatAt ?? run.startedAt ?? run.createdAt).getTime();
  if (now - lastSign > LEASE_MS) return "interrupted";
  // A live process past the limit is stuck.
  const began = (run.startedAt ?? run.createdAt).getTime();
  return now - began > RUN_LIMIT_MS ? "overdue" : "live";
}
