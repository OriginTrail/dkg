// daemon/context-graph-catchup-progress.ts
//
// Which Context Graphs this daemon is catching up, for a write that waits for
// one (`context-graph-write-readiness.ts`).
//
// The catch-up work lives in modules that hold the daemon's state (catch-up
// jobs, the readiness repeat, the activation catch-up), and that state brings
// the agent with it. The write preflight lives in `http-utils.ts`, which every
// route imports and which must load neither. So each kind of catch-up work
// tells this registry what it has in hand, and the preflight asks the
// registry. Nothing here imports anything.

/** One kind of catch-up work this daemon does. */
export interface ContextGraphCatchupProgressSource {
  /** Whether this work is catching the graph up now, or will start again on its own. */
  catchingUp(contextGraphId: string): boolean;
  /** A write waits for the graph: start now what can start now. */
  hurry?(contextGraphId: string): void;
}

const sources = new Set<ContextGraphCatchupProgressSource>();

/** Add a kind of catch-up work; the returned function removes it. */
export function registerContextGraphCatchupProgress(source: ContextGraphCatchupProgressSource): () => void {
  sources.add(source);
  return () => {
    sources.delete(source);
  };
}

/** Whether this daemon is catching the graph up, or will start again on its own. */
export function contextGraphCatchupInProgress(contextGraphId: string): boolean {
  for (const source of sources) {
    if (source.catchingUp(contextGraphId)) return true;
  }
  return false;
}

/** A write waits for the graph: let every kind of catch-up work start what it can. */
export function hurryContextGraphCatchup(contextGraphId: string): void {
  for (const source of sources) source.hurry?.(contextGraphId);
}
