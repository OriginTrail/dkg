// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  listAssertions: vi.fn(),
  promoteAssertion: vi.fn(),
}));

// PR #2131 — SubGraphBar/SubGraphOverviewGrid now call `fetchSubGraphs`
// through `api-wrapper` so the chip row and cards resolve in mock mode.
// Point the wrapper at the same mock so this suite drives the same path
// the component actually takes.
vi.mock('../src/ui/api-wrapper.js', () => ({
  api: { fetchSubGraphs: vi.fn(async () => ({ subGraphs: [] })) },
}));

vi.mock('../src/ui/api.js', () => ({
  listJoinRequests: vi.fn(async () => ({ requests: [] })),
  approveJoinRequest: vi.fn(),
  rejectJoinRequest: vi.fn(),
  listParticipants: vi.fn(async () => ({ allowedAgents: [] })),
  listAssertions: apiMocks.listAssertions,
  promoteAssertion: apiMocks.promoteAssertion,
  executeQuery: vi.fn(),
  writeProfileQueryCatalog: vi.fn(),
  fetchSubGraphs: vi.fn(async () => ({ subGraphs: [] })),
  // ka.tsx (pulled in transitively via the components barrel) imports these —
  // they must exist on the full mock or module-load fails.
  knowledgeAssetPublish: vi.fn(),
  partialPublishWarning: vi.fn(() => ''),
  PARTIAL_PUBLISH_STATUS_SUFFIX: 'binding incomplete',
}));

const {
  EmptyState,
  StatStrip,
} = await import('../src/ui/components/ContextGraphPrimitives.js');

const {
  AssertionsList,
  LayerGraphPanel,
  VerifiableMemoryHeroBanner,
} = await import('../src/ui/views/project/components.js');

const {
  ActivityFeed,
} = await import('../src/ui/components/ActivityFeed.js');

async function render(node: React.ReactElement): Promise<{
  container: HTMLDivElement;
  root: Root;
  unmount: () => Promise<void>;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(node);
  });

  return {
    container,
    root,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

async function waitForText(container: HTMLElement, text: string): Promise<void> {
  const started = Date.now();
  let last = '';
  while (Date.now() - started < 1000) {
    last = container.textContent ?? '';
    if (last.includes(text)) return;
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  }
  throw new Error(`Timed out waiting for text "${text}" in "${last}"`);
}

describe('Context Graph shared empty/stat patterns', () => {
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders EmptyState without requiring an action', async () => {
    const { container, unmount } = await render(
      React.createElement(EmptyState, {
        icon: 'i',
        title: 'No entities yet',
        description: 'Import data to populate this layer.',
        tone: 'wm',
      }),
    );

    expect(container.querySelector('.v10-empty-state')).toBeTruthy();
    expect(container.querySelector('.v10-empty-state-icon')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('.v10-empty-state-action')).toBeNull();
    expect(container.textContent).toContain('No entities yet');
    expect(container.textContent).toContain('Import data to populate this layer.');

    await unmount();
  });

  it('renders StatStrip cells with layer tone and labelled values', async () => {
    const { container, unmount } = await render(
      React.createElement(StatStrip, {
        layer: 'vm',
        items: [
          { id: 'assets', value: 2, label: 'Knowledge Assets' },
          { id: 'triples', value: '1,234', label: 'Verifiable Triples' },
        ],
      }),
    );

    expect(container.querySelector('.v10-stat-strip')?.getAttribute('data-layer')).toBe('vm');
    expect(Array.from(container.querySelectorAll('.v10-stat-strip-value')).map(el => el.textContent))
      .toEqual(['2', '1,234']);
    expect(container.textContent).toContain('Knowledge Assets');
    expect(container.textContent).toContain('Verifiable Triples');

    await unmount();
  });

  it('keeps compact StatStrip labels before values in DOM reading order', async () => {
    const { container, unmount } = await render(
      React.createElement(StatStrip, {
        compact: true,
        items: [
          { id: 'entities', value: 12, label: 'Entities' },
        ],
      }),
    );

    const cell = container.querySelector('.v10-stat-strip-cell');
    expect(cell?.children[0]?.className).toBe('v10-stat-strip-label');
    expect(cell?.children[0]?.textContent).toBe('Entities');
    expect(cell?.children[1]?.className).toBe('v10-stat-strip-value');
    expect(cell?.children[1]?.textContent).toBe('12');

    await unmount();
  });

  it('uses the quieter inline empty pattern for empty activity feeds (N6 polish #23)', async () => {
    // The Overview activity feed switched off the shared centered/bold
    // `EmptyState` primitive — that read as a load-bearing message on
    // an otherwise calm Overview. Quieter inline tertiary hint receeds
    // so the surface stays the focal area. Empty-state copy is still
    // surfaced (the hint is the user-facing payload).
    const { container, unmount } = await render(
      React.createElement(ActivityFeed, {
        entities: [],
        onSelectEntity: vi.fn(),
        emptyHint: 'No recent updates yet.',
      }),
    );

    const empty = container.querySelector('.v10-activity-feed-empty');
    expect(empty).toBeTruthy();
    // Quieter inline class replaces the shared `EmptyState` shell.
    expect(empty?.querySelector('.v10-activity-feed-empty-hint')).toBeTruthy();
    // The shared EmptyState primitive is no longer used here.
    expect(empty?.querySelector('.v10-empty-state')).toBeNull();
    expect(container.textContent).toContain('No recent updates yet.');

    await unmount();
  });

  // PR #694 Comment 8 — when the lifecycle SPARQL errors, the feed
  // must render a distinguishable indicator instead of degrading to
  // a normal empty state. The Comment 3 catch-side fix made
  // `events.length === 0` true in both success-empty and error
  // states, so the explicit `lifecycleError` prop is the signal.
  //
  // qa-lead copy tweak (also folded into the Comment 11 commit) —
  // dropped "Retrying…" because the hook only re-fetches on cgId
  // change, not on a timer. Test asserts the exact (shorter) copy.
  it('renders the lifecycle error indicator, distinct from the empty hint', async () => {
    const { container, unmount } = await render(
      React.createElement(ActivityFeed, {
        entities: [],
        onSelectEntity: vi.fn(),
        emptyHint: 'No recent updates yet.',
        lifecycleError: 'SPARQL query failed: 503',
      }),
    );

    const empty = container.querySelector('.v10-activity-feed-empty');
    expect(empty).toBeTruthy();
    // Error indicator present.
    const err = empty?.querySelector('.v10-activity-feed-error');
    expect(err).toBeTruthy();
    // qa-lead copy tweak — exact text (no "Retrying…").
    expect(err?.textContent?.trim()).toBe("Couldn't load recent activity.");
    // Empty hint is replaced by the error indicator — we don't show
    // both, so the user isn't given two contradictory states.
    expect(empty?.querySelector('.v10-activity-feed-empty-hint')).toBeNull();
    // The underlying error message is exposed via the title attribute
    // for power users / diagnostics.
    expect(err?.getAttribute('title')).toBe('SPARQL query failed: 503');

    await unmount();
  });

  // PR #694 Comment 11 — the prior Comment 8 fix did an early-return
  // on `lifecycleError`, which blanked typed Decision/Task/PR rows
  // sourced from the BASE entity-list path even though they have
  // nothing to do with the lifecycle stream. The error indicator
  // now renders inline (above the buckets, below the title) and
  // only replaces the empty hint when there are no rows at all.
  it('renders the error indicator inline AND keeps typed base-path rows when both are present', async () => {
    // Construct a typed Decision row in the entity-list path. The
    // lifecycle stream errored independently — the indicator must
    // not blank the typed row.
    const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
    const TYPE_DECISION = 'http://dkg.io/ontology/decisions/Decision';
    const DC_CREATED = 'http://purl.org/dc/terms/created';
    const triples = [
      { subject: 'urn:decision:1', predicate: RDF_TYPE, object: TYPE_DECISION, layer: 'working' as const },
      { subject: 'urn:decision:1', predicate: DC_CREATED, object: '"2026-05-22T10:00:00Z"', layer: 'working' as const },
    ];
    const { buildMemoryEntities } = await import('../src/ui/hooks/useMemoryEntities.js');
    const entityList = [...buildMemoryEntities(triples).values()];

    const { container, unmount } = await render(
      React.createElement(ActivityFeed, {
        entities: entityList,
        onSelectEntity: vi.fn(),
        title: 'Recent activity',
        // Lifecycle stream errored: pass [] for events (consumer
        // would do this mid-error per the Comment 6 fix) AND the
        // error string. Without Comment 11 the early-return would
        // hide the typed row even though it doesn't come from the
        // lifecycle stream.
        lifecycleEvents: [],
        lifecycleError: 'SPARQL query failed: 503',
      }),
    );

    // Typed row renders.
    const rows = container.querySelectorAll('.v10-activity-feed-row');
    expect(rows.length).toBeGreaterThan(0);
    // Error banner ALSO renders.
    const err = container.querySelector('.v10-activity-feed-error');
    expect(err).toBeTruthy();
    expect(err?.textContent?.trim()).toBe("Couldn't load recent activity.");
    // The populated-feed path does NOT render the empty hint.
    expect(container.querySelector('.v10-activity-feed-empty-hint')).toBeNull();

    await unmount();
  });

  // PR #694 Comment 13 — the saturation badge must read `${limit}+`
  // ONLY when the joiner reports rows were actually dropped
  // (`hasMore = merged.length > cap`, computed pre-slice). The
  // prior `items.length >= effectiveLimit` heuristic lied at the
  // boundary (exactly `limit` rows rendered as `${limit}+`).
  //
  // Drive the saturation through the lifecycle path: that's the
  // joiner path where the new `hasMore` is honest (the legacy
  // entity-list path returns the already-capped `base` and reports
  // `hasMore: false` by construction — no consumer surface today).
  it('renders `${limit}+` on the title badge only when joiner reports hasMore=true', async () => {
    const { ActivityFeed } = await import('../src/ui/components/ActivityFeed.js');
    const events = [];
    for (let i = 0; i < 15; i++) {
      events.push({
        eventUri: `urn:evt:promote-${i}`,
        kind: 'promoted' as const,
        assertionUri: `urn:assert:doc-${i}`,
        assertionName: `doc-${i}`,
        agentUri: 'did:dkg:agent:bob',
        publishedAt: `2026-05-${String((i % 28) + 1).padStart(2, '0')}T10:00:00Z`,
      });
    }
    const { container, unmount } = await render(
      React.createElement(ActivityFeed, {
        entities: [],
        onSelectEntity: vi.fn(),
        title: 'Recent activity',
        limit: 10,
        lifecycleEvents: events,
      }),
    );
    expect(container.querySelector('.v10-activity-feed-title-count')?.textContent).toBe('10+');
    await unmount();
  });

  it('renders the EXACT count on the title badge when at the boundary (merged.length === cap)', async () => {
    // Reviewer's named case: exactly `limit` rows. Pre-fix the
    // `items.length >= effectiveLimit` heuristic rendered `'10+'`
    // here, lying about a project that had exactly 10 rows. The
    // joiner now reports `hasMore: false` at the boundary.
    const events = [];
    for (let i = 0; i < 10; i++) {
      events.push({
        eventUri: `urn:evt:promote-${i}`,
        kind: 'promoted' as const,
        assertionUri: `urn:assert:doc-${i}`,
        assertionName: `doc-${i}`,
        agentUri: 'did:dkg:agent:bob',
        publishedAt: `2026-05-${String((i % 28) + 1).padStart(2, '0')}T10:00:00Z`,
      });
    }
    const { container, unmount } = await render(
      React.createElement(ActivityFeed, {
        entities: [],
        onSelectEntity: vi.fn(),
        title: 'Recent activity',
        limit: 10,
        lifecycleEvents: events,
      }),
    );
    expect(container.querySelector('.v10-activity-feed-title-count')?.textContent).toBe('10');
    await unmount();
  });

  it('renders the exact count on the title badge below the cap', async () => {
    const events = [];
    for (let i = 0; i < 3; i++) {
      events.push({
        eventUri: `urn:evt:promote-${i}`,
        kind: 'promoted' as const,
        assertionUri: `urn:assert:doc-${i}`,
        assertionName: `doc-${i}`,
        agentUri: 'did:dkg:agent:bob',
        publishedAt: `2026-05-${String((i % 28) + 1).padStart(2, '0')}T10:00:00Z`,
      });
    }
    const { container, unmount } = await render(
      React.createElement(ActivityFeed, {
        entities: [],
        onSelectEntity: vi.fn(),
        title: 'Recent activity',
        limit: 10,
        lifecycleEvents: events,
      }),
    );

    const badge = container.querySelector('.v10-activity-feed-title-count');
    expect(badge?.textContent).toBe('3');

    await unmount();
  });

  it('replaces the title-count number with an em-dash when lifecycleError is set (PR #694 polish carry-over b)', async () => {
    // Title row would otherwise show "0" next to "Recent activity"
    // while the inline error indicator below reads "Couldn't load
    // recent activity." — contradicting itself (precise count vs
    // not-loaded). The em-dash placeholder keeps the row anchored
    // without claiming a specific number.
    const { container, unmount } = await render(
      React.createElement(ActivityFeed, {
        entities: [],
        onSelectEntity: vi.fn(),
        title: 'Recent activity',
        lifecycleEvents: [],
        lifecycleError: 'SPARQL query failed: 503',
      }),
    );

    const badge = container.querySelector('.v10-activity-feed-title-count');
    expect(badge).toBeTruthy();
    expect(badge?.textContent).toBe('—');
    expect(badge?.getAttribute('data-state')).toBe('error');
    // The title row still renders (anchored heading).
    expect(container.querySelector('.v10-activity-feed-title-label')?.textContent).toBe('Recent activity');

    await unmount();
  });

  it('keeps the title-count number when error is null even with empty events', async () => {
    // Regression guard for the carry-over fix — the em-dash only
    // fires on a lifecycle ERROR, not on an empty-but-healthy feed.
    const { container, unmount } = await render(
      React.createElement(ActivityFeed, {
        entities: [],
        onSelectEntity: vi.fn(),
        title: 'Recent activity',
        lifecycleEvents: [],
        lifecycleError: null,
      }),
    );

    const badge = container.querySelector('.v10-activity-feed-title-count');
    expect(badge?.textContent).toBe('0');
    expect(badge?.getAttribute('data-state')).toBeNull();

    await unmount();
  });

  it('keeps the title-count number when lifecycleError is set BUT events were preserved from a successful prior fetch (Codex interaction between carry-overs)', async () => {
    // The composition of carry-over (a) + carry-over (b):
    //   (a) preserves cached rows on a same-graph refresh failure
    //       → `events` still contains the prior rows.
    //   (b) falls back to `—` when lifecycleError is set.
    // Naive (b) would say `—` while N actual rows render below.
    // Codex caught the contradiction on PR #769 — the badge must
    // agree with the visible row count, not the error state, when
    // both fire.
    const events = [
      {
        eventUri: 'urn:evt:promote-1',
        kind: 'promoted' as const,
        assertionUri: 'urn:assert:doc-1',
        assertionName: 'doc-1',
        agentUri: 'did:dkg:agent:alice',
        publishedAt: '2026-05-25T10:00:00Z',
      },
      {
        eventUri: 'urn:evt:promote-2',
        kind: 'promoted' as const,
        assertionUri: 'urn:assert:doc-2',
        assertionName: 'doc-2',
        agentUri: 'did:dkg:agent:bob',
        publishedAt: '2026-05-26T10:00:00Z',
      },
      {
        eventUri: 'urn:evt:promote-3',
        kind: 'promoted' as const,
        assertionUri: 'urn:assert:doc-3',
        assertionName: 'doc-3',
        agentUri: 'did:dkg:agent:carol',
        publishedAt: '2026-05-27T10:00:00Z',
      },
    ];
    const { container, unmount } = await render(
      React.createElement(ActivityFeed, {
        entities: [],
        onSelectEntity: vi.fn(),
        title: 'Recent activity',
        lifecycleEvents: events,
        lifecycleError: 'SPARQL query failed: 503',
      }),
    );

    const badge = container.querySelector('.v10-activity-feed-title-count');
    expect(badge?.textContent).toBe('3');
    // No error state on the badge — the visible list takes precedence
    // over the error signal when both fire.
    expect(badge?.getAttribute('data-state')).toBeNull();

    await unmount();
  });

  it('shows the explained interim empty state for SWM assertions', async () => {
    apiMocks.listAssertions.mockResolvedValueOnce([]);
    const { container, unmount } = await render(
      React.createElement(AssertionsList, {
        contextGraphId: 'cg-test',
        layer: 'swm',
        onComplete: vi.fn(),
      }),
    );

    await waitForText(container, 'No Shared Working Memory assertions listed yet.');
    expect(container.querySelector('.v10-layer-empty-shell .v10-empty-state')).toBeTruthy();
    expect(container.textContent).toContain('Promoted assertion contents are available as Shared Working Memory entities.');
    expect(container.textContent).not.toContain('No assertions in this layer');

    await unmount();
  });

  it('keeps graph and VM empty states inside the shared content gutter', async () => {
    const { container, unmount } = await render(
      React.createElement(React.Fragment, null,
        React.createElement(LayerGraphPanel, {
          layer: 'wm',
          triples: [],
          onNodeClick: vi.fn(),
          contextGraphId: 'cg-test',
        }),
        React.createElement('div', { className: 'v10-layer-expand-body entities-tab' },
          React.createElement(VerifiableMemoryHeroBanner, {
            entities: [],
            tripleCount: 0,
            contextGraphId: 'cg-test',
          }),
        ),
      ),
    );

    expect(container.querySelector('.v10-graph-view .v10-layer-empty-shell .v10-empty-state')).toBeTruthy();
    expect(container.querySelector('.v10-layer-expand-body.entities-tab > .v10-vm-hero')).toBeTruthy();
    expect(container.textContent).toContain('No triples in Working Memory');
    expect(container.textContent).toContain('No Knowledge Assets yet.');

    await unmount();
  });

  it('keeps WM assertions empty copy separate from the SWM backend-gated copy', async () => {
    apiMocks.listAssertions.mockResolvedValueOnce([]);
    const { container, unmount } = await render(
      React.createElement(AssertionsList, {
        contextGraphId: 'cg-test',
        layer: 'wm',
        onComplete: vi.fn(),
      }),
    );

    await waitForText(container, 'No Working Memory assertions yet.');
    expect(container.textContent).toContain('Create or import data to stage assertions in Working Memory.');
    expect(container.textContent).not.toContain('Promoted assertion contents are available');

    await unmount();
  });

  it('renders assertion rows when SWM assertions become listable', async () => {
    apiMocks.listAssertions.mockResolvedValueOnce([
      // PR #710 Fix D — React key + busy state now use `graphUri`
      // (unique per row); fixtures must include it.
      { name: 'turn-anno-test', graphUri: 'urn:dkg:assertion:cg-test:0xabc:turn-anno-test', tripleCount: 3 },
    ]);
    const { container, unmount } = await render(
      React.createElement(AssertionsList, {
        contextGraphId: 'cg-test',
        layer: 'swm',
        onComplete: vi.fn(),
      }),
    );

    await waitForText(container, 'turn-anno-test');
    expect(container.textContent).toContain('3 triples');
    expect(container.textContent).not.toContain('No Shared Working Memory assertions listed yet.');

    await unmount();
  });

  // #706 — WM Assertions tab was silently dropping sub-graph-scoped
  // assertions because the client-side filter only matched the root
  // `did:dkg:context-graph:<cg>/assertion/…` shape. Fix surfaces both
  // shapes and tags each row with an inline sub-graph chip when the
  // assertion is scoped to a partition. Root rows render no chip.
  it('renders sub-graph chip on partitioned assertions and omits it on root rows (#706)', async () => {
    apiMocks.listAssertions.mockResolvedValueOnce([
      { name: 'root-doc', graphUri: 'did:dkg:context-graph:cg-test/assertion/0xabc/root-doc', tripleCount: 2 },
      { name: 'scoped-doc', graphUri: 'did:dkg:context-graph:cg-test/epcis-supply-chain/assertion/0xabc/scoped-doc', tripleCount: 5, subGraph: 'epcis-supply-chain' },
      // Long slug to exercise the 18-char middle-ellipsis truncation.
      { name: 'long-scoped-doc', graphUri: 'did:dkg:context-graph:cg-test/pharmaceutical-derived-product-graph/assertion/0xabc/long-scoped-doc', tripleCount: 1, subGraph: 'pharmaceutical-derived-product-graph' },
    ]);
    const { container, unmount } = await render(
      React.createElement(AssertionsList, {
        contextGraphId: 'cg-test',
        layer: 'wm',
        onComplete: vi.fn(),
      }),
    );

    await waitForText(container, 'root-doc');
    await waitForText(container, 'scoped-doc');
    await waitForText(container, 'long-scoped-doc');

    // Three rows rendered (no silent drop on sub-graph rows).
    const rows = container.querySelectorAll('.v10-item-row');
    expect(rows.length).toBe(3);

    // Locate each row by its name and verify chip presence/absence.
    const rowFor = (name: string) =>
      Array.from(rows).find(r => r.querySelector('.v10-item-name')?.textContent === name)!;

    const rootRow = rowFor('root-doc');
    const scopedRow = rowFor('scoped-doc');
    const longRow = rowFor('long-scoped-doc');

    // Root row has no sub-graph chip.
    expect(rootRow.querySelector('.v10-item-subgraph')).toBeNull();

    // Short slug renders verbatim (≤ 18 chars).
    const scopedChip = scopedRow.querySelector('.v10-item-subgraph');
    expect(scopedChip).toBeTruthy();
    expect(scopedChip!.textContent).toContain('epcis-supply-chain');
    // Tooltip carries the full slug regardless of truncation.
    expect(scopedChip!.getAttribute('title')).toBe('In sub-graph: epcis-supply-chain');

    // Long slug (>18 chars) gets middle-ellipsis truncated.
    const longChip = longRow.querySelector('.v10-item-subgraph');
    expect(longChip).toBeTruthy();
    expect(longChip!.textContent).toContain('…');
    expect(longChip!.textContent).not.toContain('pharmaceutical-derived-product-graph');
    // Tooltip preserves the full slug for power users.
    expect(longChip!.getAttribute('title')).toBe('In sub-graph: pharmaceutical-derived-product-graph');

    await unmount();
  });
});
