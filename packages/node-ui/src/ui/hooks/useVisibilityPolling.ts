import { useEffect, useRef } from 'react';

/**
 * Like `setInterval(callback, intervalMs)` but pauses while the tab is
 * hidden (BUG-007). The dashboard previously fired ~75 fetch calls per
 * minute on idle — most components had their own `setInterval(...,
 * 5_000)` polling the same `/api/status` and `/api/wallets/balances`
 * endpoints, and none of them paused when the user switched away.
 *
 * The hook accepts a `runImmediately` flag because most callers want
 * an initial fetch on mount; subsequent ticks are deferred whenever
 * `document.hidden` becomes true and resume (with one immediate tick
 * to refresh stale data) the moment the tab regains focus.
 *
 * Returns nothing; cleanup is automatic on unmount.
 */
export function useVisibilityPolling(
  callback: () => void,
  intervalMs: number,
  options: { runImmediately?: boolean } = {},
): void {
  const cbRef = useRef(callback);
  cbRef.current = callback;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (intervalMs <= 0) return undefined;
    let timer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;

    const start = () => {
      if (timer || cancelled) return;
      timer = setInterval(() => cbRef.current(), intervalMs);
    };
    const stop = () => {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    };

    const onVisibility = () => {
      if (document.hidden) {
        stop();
        return;
      }
      // Becoming visible: refresh once so stale UI snaps to current,
      // then resume the cadence.
      cbRef.current();
      start();
    };

    // BUG-007 / codex #752: the eager mount call must also pause when
    // the tab is hidden. Browser session restore and "open all tabs"
    // commonly mount React in a backgrounded tab; without this guard
    // every `useVisibilityPolling` consumer still fires one fetch on
    // mount, which is most of the daemon-fan-out we were trying to
    // suppress. The visibilitychange handler will run the deferred
    // initial refresh as soon as the user returns to the tab.
    if (optionsRef.current.runImmediately !== false && !document.hidden) cbRef.current();
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      stop();
    };
  }, [intervalMs]);
}
