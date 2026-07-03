import { useState, useEffect, useCallback, useRef } from 'react';

/** Fetch data on mount and optionally on a polling interval. */
export function useFetch<T>(
  fetcher: () => Promise<T>,
  deps: unknown[] = [],
  intervalMs = 0,
): { data: T | null; loading: boolean; error: string | null; refresh: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    try {
      const result = await fetcher();
      if (mountedRef.current) {
        setData(result);
        setError(null);
      }
    } catch (err: any) {
      if (mountedRef.current) {
        if (err?.status === 401) {
          const alreadyRetried = sessionStorage.getItem('__dkg_401_reloaded') === '1';
          if (!alreadyRetried) {
            sessionStorage.setItem('__dkg_401_reloaded', '1');
            window.location.reload();
            return;
          }
          setError('Authentication expired — please refresh the page.');
          return;
        }
        setError(err.message);
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    mountedRef.current = true;
    setLoading(true);
    load();
    let timer: ReturnType<typeof setInterval> | null = null;
    const startTimer = () => {
      if (intervalMs <= 0 || timer) return;
      timer = setInterval(load, intervalMs);
    };
    const stopTimer = () => {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    };
    // Pause polling while the tab is hidden (BUG-007). On the dashboard
    // alone, ~14 components polled `/api/wallets/balances` and friends
    // every 10–60s independently of tab visibility — when the user
    // switches away the daemon kept absorbing all of them. The
    // visibility listener stops the timer when hidden and fires one
    // immediate refresh on resume so stale data is replaced fast.
    const onVisibility = () => {
      if (typeof document === 'undefined') return;
      if (document.hidden) stopTimer();
      else { load(); startTimer(); }
    };
    if (typeof document === 'undefined' || !document.hidden) startTimer();
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
    return () => {
      mountedRef.current = false;
      stopTimer();
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [load, intervalMs]);

  return { data, loading, error, refresh: load };
}

/** Format bytes to human-readable string. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

/** Format milliseconds to human-readable duration. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${h}h ${m}m`;
}

/** Format a unix timestamp to local time string. */
/**
 * Render a timestamp as a date-aware short label (BUG-003).
 *
 * Same-day events show only `H:MM:SS` (the dense form historical
 * callers depend on for the realtime-tailing log views), entries from
 * earlier in the same week show `Wed 14:02`, and anything older shows
 * `Mar 11 14:02`. The previous implementation used
 * `toLocaleTimeString()` unconditionally, so a column showing 100 ops
 * displayed every entry as a clock — three days vs three minutes was
 * indistinguishable. Hovering still surfaces the full date+time via
 * the caller's `title` attribute when set.
 */
export function formatTime(ts: number | string | Date | null | undefined, now: Date = new Date()): string {
  if (ts == null || ts === '') return '—';
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) {
    return `Yesterday ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
  }
  const diffMs = now.getTime() - d.getTime();
  if (diffMs >= 0 && diffMs < 7 * 24 * 60 * 60 * 1000) {
    return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
  }
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Shorten a UUID or peer ID. */
export function shortId(id: string | null | undefined, len = 8): string {
  if (!id) return '—';
  if (id.length <= len * 2) return id;
  return id.slice(0, len) + '...' + id.slice(-4);
}
