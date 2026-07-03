import { useEffect, useState } from 'react';
import { fetchPca, isPcaFeatureUnavailable } from '../api.js';

export type PcaAvailability = 'loading' | 'available' | 'unavailable';

/**
 * Capability probe for the whole `conviction` tab (UX §6.6). The PCA routes
 * return 503 FEATURE_UNAVAILABLE when the chain adapter/contract isn't deployed
 * on this Hub — a tab-level fact, not a per-card error. There is no dedicated
 * capability endpoint (P0 adds ZERO backend routes), so we probe a GET on a
 * sentinel id: on a deployed contract id `0` is unminted → 404 ("available");
 * on an undeployed contract every PCA route → 503 ("unavailable").
 *
 * Only a 503 gates the tab — a 404 (or any transient/network error) means the
 * feature EXISTS, so we fall through to the overview, which degrades per-card on
 * its own. `recheck` re-runs the probe (the Deployment-Unavailable "Recheck").
 */
export function usePcaAvailability(): { status: PcaAvailability; recheck: () => void } {
  const [status, setStatus] = useState<PcaAvailability>('loading');
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    setStatus('loading');
    fetchPca('0')
      .then(() => {
        if (alive) setStatus('available');
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setStatus(isPcaFeatureUnavailable(err) ? 'unavailable' : 'available');
      });
    return () => {
      alive = false;
    };
  }, [nonce]);

  return { status, recheck: () => setNonce((n) => n + 1) };
}
