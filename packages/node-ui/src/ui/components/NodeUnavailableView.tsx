import { useEffect } from 'react';
import { useLayoutStore } from '../stores/layout.js';
import { applyTheme } from '../lib/applyTheme.js';
import { RefreshCw } from 'lucide-react';

/** A failed status probe must never present fabricated operational health. */
export function NodeUnavailableView() {
  const theme = useLayoutStore((state) => state.theme);
  useEffect(() => { applyTheme(theme); }, [theme]);

  return (
    <main className="v10-app" style={{ alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <section role="alert" style={{ maxWidth: 480, lineHeight: 'var(--lh-loose)' }}>
        <h1>Node unavailable</h1>
        <p>Live node data could not be loaded. The node may be stopped, timing out or returning errors.</p>
        <p>Node status, balances, graphs and integration readiness are unavailable. Check that the node is running, then reload the page.</p>
        <button type="button" className="v10-modal-btn primary ds-btn ds-primary" onClick={() => window.location.reload()}>
          <RefreshCw size={12} />Retry connection
        </button>
      </section>
    </main>
  );
}
