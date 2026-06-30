import { useEffect } from 'react';
import { listPcaContracts } from '../api.js';
import { pcaStorageScopeForContracts, usePcaStore } from '../stores/pca.js';

let scopeBootstrap: Promise<void> | null = null;

/**
 * Ensure locally persisted PCA state is loaded under the current chain +
 * deployment scope before non-conviction surfaces read `usePcaOverview`.
 */
export function usePcaScopeBootstrap(): void {
  const scopeKey = usePcaStore((s) => s.scopeKey);
  const setScope = usePcaStore((s) => s.setScope);

  useEffect(() => {
    if (scopeKey) return;
    if (!scopeBootstrap) {
      scopeBootstrap = listPcaContracts()
        .then((contracts) => {
          setScope(pcaStorageScopeForContracts(contracts));
        })
        .catch(() => {
          // PCA may be unavailable on this chain; readers stay on the empty
          // unscoped state until the conviction tab shows the deployment gate.
        })
        .finally(() => {
          scopeBootstrap = null;
        });
    }
  }, [scopeKey, setScope]);
}
