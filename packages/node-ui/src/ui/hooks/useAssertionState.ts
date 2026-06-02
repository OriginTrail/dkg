import { useEffect, useState } from 'react';
import { fetchAssertionState, type AssertionStateInfo } from '../api.js';

/**
 * Per-mount fetch of a single assertion's CURRENT lifecycle state for
 * the S4 assertion detail view (α verdict lock-b — lazy: the state is
 * fetched on detail-view mount, NOT carried on every `listAssertions`
 * row). `dkg:state` + `dkg:memoryLayer` are mutable literals on the
 * lifecycle entity in `<cg>/_meta`; see `fetchAssertionState` in
 * `api.ts` for the query shape and the data-model writers.
 *
 * Three terminal shapes the detail view distinguishes:
 *   - `{ loading: true }`            — hydrating; the CTA stays hidden and
 *                                      the trail renders all-neutral with
 *                                      no "you are here" marker.
 *   - `{ data: AssertionStateInfo }` — resolved; drives the trail
 *                                      `is-current` halo, the badge state
 *                                      suffix, and the Promote CTA gate.
 *   - `{ error: string }` / data null — fetch failed OR no lifecycle
 *                                      record; the metadata panel shows
 *                                      "state unavailable" and the trail
 *                                      renders all-neutral with a quiet
 *                                      danger hint.
 */
export interface UseAssertionStateResult {
  data: AssertionStateInfo | null;
  loading: boolean;
  error: string | null;
}

export function useAssertionState(
  contextGraphId: string | undefined,
  graphUri: string | undefined,
  // Codex round-1 — bump this to force a re-fetch even when the URI is
  // unchanged (e.g. after a promote FROM the detail view flips the state
  // in `_meta`; the same `graphUri` would otherwise skip the effect and
  // leave the trail/badge/CTA stale at the pre-promote state).
  refreshKey?: number,
): UseAssertionStateResult {
  const [data, setData] = useState<AssertionStateInfo | null>(null);
  const [loading, setLoading] = useState<boolean>(Boolean(contextGraphId && graphUri));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!contextGraphId || !graphUri) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    // Codex round-1 — clear `data` when the assertion changes so a
    // consumer reading `data` during the in-flight window can't see the
    // PREVIOUS assertion's state (stale state/layer/assertionGraph). The
    // detail view's `assertionGraph` derives from `data` and drives the
    // triples fetch, so a stale value would briefly query the wrong
    // graph. Mirror of the `triplesLoading` reset discipline.
    setData(null);
    setLoading(true);
    setError(null);
    fetchAssertionState(contextGraphId, graphUri)
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        // Leave any prior data in place is pointless here — the URI
        // identity changed, so a stale state would be wrong. Clear it
        // and surface the error so the detail view shows "unavailable".
        setData(null);
        setLoading(false);
        setError(err instanceof Error ? err.message : 'Failed to load assertion state');
      });
    return () => { cancelled = true; };
  }, [contextGraphId, graphUri, refreshKey]);

  return { data, loading, error };
}
