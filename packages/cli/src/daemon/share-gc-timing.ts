import { constants, performance, PerformanceObserver, type PerformanceEntry } from 'node:perf_hooks';

const MAX_ENTRIES = 64;
const KINDS = new Map<number, string>([
  [constants.NODE_PERFORMANCE_GC_MINOR, 'minor'],
  [constants.NODE_PERFORMANCE_GC_MAJOR, 'major'],
  [constants.NODE_PERFORMANCE_GC_INCREMENTAL, 'incremental'],
  [constants.NODE_PERFORMANCE_GC_WEAKCB, 'weakCallbacks'],
]);

type GcSpan = { start: number; end: number; kind: string };
type GcWindow = { windowStart: number; dispatch: number; intervalStart: number; intervalEnd: number };

/** Completed GC entries only; durations are wall time. Never export VM flags or GC details. */
export class RecentShareGc {
  private readonly spans: GcSpan[] = [];
  private evictedThrough = -Infinity;

  add(entries: ReadonlyArray<Pick<PerformanceEntry, 'startTime' | 'duration'> & { detail?: { kind: number } }>): void {
    const first = Math.max(0, entries.length - MAX_ENTRIES);
    // A burst may already have filled the observer's delivery buffer. Bound our work and
    // conservatively flag overlapping queries when discarding entries from that batch.
    if (first) this.evictedThrough = performance.timeOrigin + performance.now();
    for (let i = first; i < entries.length; i++) {
      const entry = entries[i]!;
      const kind = KINDS.get(entry.detail?.kind ?? 0) ?? 'unknown';
      const start = performance.timeOrigin + entry.startTime;
      if (!Number.isFinite(start) || !Number.isFinite(entry.duration) || entry.duration < 0) continue;
      if (this.spans.length === MAX_ENTRIES) {
        const dropped = this.spans.shift()!;
        this.evictedThrough = Math.max(this.evictedThrough, dropped.end);
      }
      this.spans.push({ start, end: start + entry.duration, kind });
    }
  }

  summarize({ windowStart, dispatch, intervalStart, intervalEnd }: GcWindow) {
    const relevant = this.spans.filter(gc => gc.end > windowStart && gc.start < dispatch);
    const overlaps: Array<[number, number]> = [];
    let longest: { kind: string; ms: number } | undefined;
    for (const gc of relevant) {
      const ms = Math.min(dispatch, gc.end) - Math.max(windowStart, gc.start);
      if (!longest || ms > longest.ms) longest = { kind: gc.kind, ms };
      const from = Math.max(intervalStart, gc.start);
      const to = Math.min(intervalEnd, gc.end);
      if (to > from) overlaps.push([from, to]);
    }
    // Do not count nested/overlapping GC intervals twice when comparing them with a loop delay.
    let through = intervalStart;
    let covered = 0;
    for (const [start, end] of overlaps.sort((a, b) => a[0] - b[0])) {
      covered += Math.max(0, end - Math.max(through, start));
      through = Math.max(through, end);
    }
    return {
      observedCount: relevant.length, retentionLimited: this.evictedThrough > windowStart,
      maxLoopIntervalOverlapMs: Math.round(covered),
      ...(longest ? { longestKind: longest.kind, longestOverlapMs: Math.round(longest.ms) } : {}),
    };
  }
}

export function observeShareGc() {
  const recent = new RecentShareGc();
  const observer = new PerformanceObserver(list => recent.add(list.getEntries()));
  observer.observe({ entryTypes: ['gc'] });
  return {
    snapshot(window: GcWindow) {
      // The observer callback can still be pending at response close.
      recent.add(observer.takeRecords());
      return recent.summarize(window);
    },
    close() { observer.disconnect(); },
  };
}
