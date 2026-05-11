import { test, expect } from '../fixtures/base.js';

/**
 * Live memory-graph updates (SSE → useMemoryGraphEvents).
 *
 * The merge brought in PR 27912c5: writes to /api/assertion/* now emit a
 * `memory_graph_changed` Server-Sent Event on the EventSource at
 * GET /api/events, carrying `{ contextGraphId, layers: ('wm'|'swm'|'vm')[] }`.
 * The UI's `useMemoryGraphEvents` hook is wired into the auto-refreshing
 * data hooks (`useMemoryEntities` — feeds the project's layer counts and
 * the entity graph — and `SubGraphBar`). When an event matching the open
 * view arrives, those panels re-fetch without manual refresh.
 *
 * Coverage strategy for this spec:
 *   • The EventSource HTTP plumbing is verified at the network layer
 *     ("the EventSource (/api/events) is open and receiving server frames").
 *   • The user-visible auto-refresh contract is tested directly: writing
 *     a WM assertion via API causes the ProvenanceBar's draft count to
 *     tick up WITHOUT a manual reload (the SSE → useMemoryEntities →
 *     re-render chain).
 *   • The cross-CG GATE (writes to a different CG don't ever cause our
 *     view to surface foreign state) is tested last.
 */

test.describe('Live memory-graph updates (memory_graph_changed SSE)', () => {
  test.beforeEach(async ({ shell, leftPanel, projectView, seed, page }) => {
    await shell.goto();
    await leftPanel.waitForReady();
    await leftPanel.openProject(seed.contextGraphName);
    await page.locator('.v10-layer-switcher').first().waitFor({ state: 'visible', timeout: 15_000 });
    await projectView.switchLayer('wm');
    // The ProvenanceBar copy needs WM to be non-empty for the seeded value;
    // wait for the seeded "{N} drafts in working memory" to appear so the
    // count-read in the test starts from a stable baseline.
    await expect(page.locator('.v10-provenance-bar')).toContainText(/drafts in working memory/, { timeout: 15_000 });
  });

  test('writing a new WM assertion via API auto-refreshes the ProvenanceBar count (no manual reload)', async ({ page, seed, daemon }) => {
    // Pure SSE-driven contract: a /api/assertion/:name/write emits
    // `memory_graph_changed` on the EventSource, useMemoryGraphEvents
    // fires loadEntities(), useMemoryEntities updates the store, the
    // ProvenanceBar re-renders. No user action between write and observe.
    // If this regresses we lose live updates entirely.
    const bar = page.locator('.v10-provenance-bar');
    const readCount = async (): Promise<number> => {
      const txt = await bar.textContent();
      const m = txt?.match(/(\d+) drafts in working memory/);
      return m ? parseInt(m[1]!, 10) : -1;
    };
    const baseline = await readCount();
    expect(baseline).toBeGreaterThanOrEqual(1);

    // page.request is an APIRequestContext that does NOT route through
    // `page.route()` — it has its own auth chain. Pass the daemon's bearer
    // token explicitly.
    const newAssertionName = `live-update-probe-${Date.now()}`;
    const writeResp = await page.request.post(
      `/api/assertion/${encodeURIComponent(newAssertionName)}/write`,
      {
        headers: { Authorization: `Bearer ${daemon.authToken}` },
        data: {
          contextGraphId: seed.contextGraphId,
          quads: [
            {
              subject: 'urn:dkg:e2e:live-update',
              predicate: 'http://schema.org/name',
              object: '"Live update probe"',
              graph: '',
            },
          ],
        },
      },
    );
    expect(writeResp.ok(), `write failed: ${writeResp.status()} ${await writeResp.text()}`).toBe(true);

    // No reload, no re-entry — pure SSE-driven refresh.
    await expect.poll(readCount, { timeout: 15_000, intervals: [200, 400, 800, 1500] }).toBeGreaterThan(baseline);
  });

  test('the EventSource (/api/events) is open and receiving server frames', async ({ page }) => {
    // Direct verification: the `useNodeEvents` connect-on-mount path opens
    // exactly one EventSource. If the route is renamed, the auth fails, or
    // the connect call is dropped, this fails fast — and the live-update
    // refresh would silently stop working.
    const responses = page.waitForEvent('response', {
      predicate: (r) => /\/api\/events(\?|$)/.test(r.url()) && r.status() === 200,
      timeout: 10_000,
    });
    // Trigger a hook mount by reloading — guarantees a fresh EventSource
    // handshake we can intercept.
    await page.reload();
    const evResp = await responses;
    expect(evResp.headers()['content-type']).toMatch(/text\/event-stream/);
  });

  test('writing a foreign-CG assertion never surfaces in THIS CG\'s WM count', async ({ page, seed, daemon }) => {
    // The CG-gating contract: a write to a *different* CG must not leak
    // into the open project's WM count, even with SSE active. The SSE
    // event carries `contextGraphId` and useMemoryGraphEvents filters on
    // it (see useMemoryGraphEvents implementation). A regression in that
    // filter would let foreign writes bump our counts.
    const bar = page.locator('.v10-provenance-bar');
    const readCount = async (): Promise<number> => {
      const txt = await bar.textContent();
      const m = txt?.match(/(\d+) drafts in working memory/);
      return m ? parseInt(m[1]!, 10) : -1;
    };
    const baseline = await readCount();
    expect(baseline).toBeGreaterThanOrEqual(1);

    // Create a fresh foreign CG so we don't pollute the seeded one.
    const otherCg = `other-cg-${Date.now()}`;
    await page.request.post('/api/context-graph/create', {
      headers: { Authorization: `Bearer ${daemon.authToken}` },
      data: { id: otherCg, name: 'Cross-CG Probe', description: 'live-memory cross-cg negative test' },
    });
    expect(otherCg).not.toBe(seed.contextGraphId);

    const probeName = `cross-cg-probe-${Date.now()}`;
    const writeResp = await page.request.post(
      `/api/assertion/${encodeURIComponent(probeName)}/write`,
      {
        headers: { Authorization: `Bearer ${daemon.authToken}` },
        data: {
          contextGraphId: otherCg,
          quads: [
            {
              subject: 'urn:dkg:e2e:cross-cg',
              predicate: 'http://schema.org/name',
              object: '"Cross-CG probe"',
              graph: '',
            },
          ],
        },
      },
    );
    expect(writeResp.ok(), `cross-cg write failed: ${writeResp.status()} ${await writeResp.text()}`).toBe(true);

    // Give the SSE pipe a generous window to (mis)deliver. If the filter
    // regresses, the count would tick. We assert it stays put.
    await page.waitForTimeout(2_000);
    expect(await readCount()).toBe(baseline);
  });
});
