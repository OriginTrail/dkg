import { RetryButton } from './ds/RetryButton.js';

/** A failed status probe must never present fabricated operational health.
 * The document theme is applied by App, which renders this view. */
export function NodeUnavailableView() {

  return (
    <main className="v10-app v10-unavailable">
      <section role="alert" className="v10-unavailable-card">
        <h1>Node unavailable</h1>
        <p>Live node data could not be loaded. The node may be stopped, timing out or returning errors.</p>
        <p>Node status, balances, graphs and integration readiness are unavailable. Check that the node is running, then reload the page.</p>
        <RetryButton size="md" onClick={() => window.location.reload()} />
      </section>
    </main>
  );
}
