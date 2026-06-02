// @vitest-environment happy-dom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectProfileContext, type ProjectProfile } from '../src/ui/hooks/useProjectProfile.js';
import { AgentsContext, type AgentsData } from '../src/ui/hooks/useAgents.js';
import type { AssertionInfo, AssertionStateInfo, AssertionTriple } from '../src/ui/api.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// S4 — DOM tests for AssertionDetailView (T08 / T09 / T10 / T17). We
// override only the two assertion data reads on the real api.js module
// (keeping every other export the component tree pulls in) plus stub the
// lazy RdfGraph so the Graph tab doesn't load the force-graph bundle.

const stateMock = vi.hoisted(() => ({
  fetchAssertionState: vi.fn<(cg: string, uri: string) => Promise<AssertionStateInfo | null>>(),
  fetchAssertionTriples: vi.fn<(cg: string, g: string) => Promise<AssertionTriple[]>>(),
  promoteAssertion: vi.fn<() => Promise<{ promotedCount: number }>>(),
}));

vi.mock('../src/ui/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/ui/api.js')>('../src/ui/api.js');
  return {
    ...actual,
    fetchAssertionState: stateMock.fetchAssertionState,
    fetchAssertionTriples: stateMock.fetchAssertionTriples,
    promoteAssertion: stateMock.promoteAssertion,
  };
});

vi.mock('@origintrail-official/dkg-graph-viz/react', () => ({
  RdfGraph: () => React.createElement('div', { 'data-testid': 'rdf-graph' }, 'graph'),
}));

const { AssertionDetailView } = await import('../src/ui/views/project/components.js');

const profile: ProjectProfile = {
  contextGraphId: 'cg-test',
  displayName: 'Context Graph Test',
  primaryColor: '#64748b',
  accentColor: '#22c55e',
  subGraphs: [],
  typeBindings: [],
  views: [],
  filterChips: [],
  queryCatalogs: [],
  savedQueries: [],
  loading: false,
  forSubGraph: () => undefined,
  forType: typeIri => ({ typeIri, label: typeIri.split(/[/#]/).pop() ?? typeIri, color: '#64748b' }),
  view: () => undefined,
  chipsFor: () => [],
  savedQueryCatalogsFor: () => [],
  savedQueriesFor: () => [],
};

const agents: AgentsData = {
  agents: new Map(),
  list: [],
  loading: false,
  get: () => undefined,
  openAgent: vi.fn(),
};

const NAME = 'http://schema.org/name';
const TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

const sampleTriples: AssertionTriple[] = [
  { subject: 'urn:e:battery', predicate: TYPE, object: 'http://schema.org/Thing' },
  { subject: 'urn:e:battery', predicate: NAME, object: '"Battery cell 003"' },
];

function query(selector: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`Missing element ${selector}`);
  return el;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise(r => setTimeout(r, 0));
  });
}

function render(root: Root, assertion: AssertionInfo, sourceLayer: 'wm' | 'swm' = 'wm') {
  return act(async () => {
    root.render(
      React.createElement(ProjectProfileContext.Provider, { value: profile },
        React.createElement(AgentsContext.Provider, { value: agents },
          React.createElement(AssertionDetailView, {
            assertion,
            sourceLayer,
            contextGraphId: 'cg-test',
            onNavigate: vi.fn(),
            onComplete: vi.fn(),
          }))),
    );
  });
}

async function mount(assertion: AssertionInfo, sourceLayer: 'wm' | 'swm' = 'wm'): Promise<Root> {
  document.body.innerHTML = '<div id="root"></div>';
  const root = createRoot(query('#root'));
  await render(root, assertion, sourceLayer);
  await flush();
  return root;
}

// Post-#864 `AssertionInfo.graphUri` is the DATA-GRAPH (partition) URI.
const wmAssertion: AssertionInfo = { name: 'epcis-demo', graphUri: 'did:dkg:context-graph:cg-test/demo/assertion/0xabc/epcis-demo', subGraph: 'demo' };

describe('AssertionDetailView', () => {
  let root: Root | undefined;

  beforeEach(() => {
    stateMock.fetchAssertionState.mockReset();
    stateMock.fetchAssertionTriples.mockReset();
    stateMock.promoteAssertion.mockReset();
    stateMock.fetchAssertionTriples.mockResolvedValue(sampleTriples);
    stateMock.promoteAssertion.mockResolvedValue({ promotedCount: 3 });
  });

  afterEach(async () => {
    if (root) {
      await act(async () => { root!.unmount(); });
      root = undefined;
    }
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('renders the 3-line header for a sub-graph-scoped WM created assertion (T09 / T17)', async () => {
    stateMock.fetchAssertionState.mockResolvedValue({
      state: 'created', layer: 'wm',
      assertionGraph: 'did:dkg:context-graph:cg-test/demo/assertion/0xabc/epcis-demo',
      createdBy: 'did:dkg:agent:0xabc',
    });
    root = await mount(wmAssertion);

    // Line 1: ▤ + mono name.
    expect(query('.v10-ka-name').textContent).toContain('epcis-demo');
    // Line 2: assertion · N entities · M triples.
    const uals = document.querySelectorAll('.v10-ka-ual');
    expect(uals[0].textContent).toContain('assertion ·');
    expect(uals[0].textContent).toContain('2 triples');
    // Line 3: subgraph (only because this assertion is scoped).
    expect([...uals].some(u => u.textContent?.includes('subgraph: demo'))).toBe(true);
    // Right-rail badge shows the layer glyph + label + state.
    const badge = query('.v10-trust-badge');
    expect(badge.textContent).toContain('Working');
    expect(badge.textContent).toContain('created');
  });

  it('omits the line-3 subgraph row for a root-scoped assertion (T09 conditional)', async () => {
    stateMock.fetchAssertionState.mockResolvedValue({
      state: 'created', layer: 'wm',
      assertionGraph: 'did:dkg:context-graph:cg-test/assertion/0xabc/root-doc',
    });
    root = await mount({ name: 'root-doc', graphUri: 'did:dkg:context-graph:cg-test/assertion/0xabc/root-doc' });
    const uals = [...document.querySelectorAll('.v10-ka-ual')];
    expect(uals.some(u => u.textContent?.includes('subgraph:'))).toBe(false);
  });

  it('shows the Promote CTA only for created + wm (T08)', async () => {
    stateMock.fetchAssertionState.mockResolvedValue({
      state: 'created', layer: 'wm',
      assertionGraph: 'did:dkg:context-graph:cg-test/demo/assertion/0xabc/epcis-demo',
    });
    root = await mount(wmAssertion);
    expect(query('.v10-ka-header-actions').textContent).toContain('Promote to SWM');
  });

  it('hides the Promote CTA for a promoted (SWM) assertion (T08)', async () => {
    stateMock.fetchAssertionState.mockResolvedValue({
      state: 'promoted', layer: 'swm',
      assertionGraph: 'did:dkg:context-graph:cg-test/demo/assertion/0xabc/epcis-demo',
    });
    root = await mount(wmAssertion);
    expect(query('.v10-ka-header-actions').textContent).not.toContain('Promote to SWM');
    // Badge reflects the promoted state.
    expect(query('.v10-trust-badge').textContent).toContain('promoted');
  });

  // Codex round-2 finding 1 (hardening) — a discarded assertion is
  // LAYERLESS: the badge is a neutral muted `discarded`, NO layer glyph /
  // name and NEVER VM-green (the api.ts discarded→vm fallback is
  // unreachable today, but this render guard makes it harmless). State
  // row also drops the `(Layer)` suffix.
  it('renders a discarded assertion with a neutral layerless badge (no vm-green)', async () => {
    stateMock.fetchAssertionState.mockResolvedValue({
      // memoryLayer absent (discard deletes it) → the api fallback would
      // pick vm; the render guard must override to neutral.
      state: 'discarded', layer: 'vm',
      assertionGraph: 'did:dkg:context-graph:cg-test/demo/assertion/0xabc/epcis-demo',
    });
    root = await mount(wmAssertion);
    const badge = query('.v10-ka-header-actions .v10-trust-badge, .v10-ka-header-actions .v10-trust-badge-discarded') as HTMLElement;
    expect(badge.classList.contains('v10-trust-badge-discarded')).toBe(true);
    expect(badge.classList.contains('vm')).toBe(false); // never VM-green
    expect(badge.textContent).toBe('discarded');
    expect(badge.textContent).not.toContain('Verifiable');
    expect(badge.textContent).not.toContain('◉'); // no layer glyph
    // No Promote CTA on a discarded assertion.
    expect(query('.v10-ka-header-actions').textContent).not.toContain('Promote to SWM');
    // State row is layerless ("discarded", no "(Layer)").
    expect(document.body.textContent).toContain('discarded');
    expect(document.body.textContent).not.toContain('discarded (');
  });

  // Codex round-6 finding 2 — an entity label that is a lang/typed RDF
  // literal must render DECODED in the Entities pane (`Hola`), not as the
  // raw `Hola"@es` (the round-2 consumer audit missed buildMemoryEntities'
  // label path; round-6 decodes at the shared label chokepoint).
  it('Entities pane decodes a lang-tagged entity label (Hola, not Hola"@es)', async () => {
    stateMock.fetchAssertionState.mockResolvedValue({
      state: 'created', layer: 'wm',
      assertionGraph: 'did:dkg:context-graph:cg-test/demo/assertion/0xabc/epcis-demo',
    });
    stateMock.fetchAssertionTriples.mockReset();
    stateMock.fetchAssertionTriples.mockResolvedValue([
      { subject: 'urn:e:greet', predicate: TYPE, object: 'http://schema.org/Thing' },
      { subject: 'urn:e:greet', predicate: 'http://schema.org/name', object: '"Hola"@es' },
    ]);
    root = await mount(wmAssertion);
    const body = document.body.textContent ?? '';
    expect(body).toContain('Hola');
    expect(body).not.toContain('Hola"@es');
    expect(body).not.toContain('"@es');
  });

  // Codex round-6 finding 3 — a triple-FETCH error must render a DISTINCT
  // "couldn't load" state, NOT the empty-state copy (an operational
  // failure must not look like valid-but-empty data).
  it('triple-fetch error shows the error state, not the empty-state copy', async () => {
    stateMock.fetchAssertionState.mockResolvedValue({
      state: 'created', layer: 'wm',
      assertionGraph: 'did:dkg:context-graph:cg-test/demo/assertion/0xabc/epcis-demo',
    });
    stateMock.fetchAssertionTriples.mockReset();
    stateMock.fetchAssertionTriples.mockRejectedValue(new Error('HTTP 500'));
    root = await mount(wmAssertion);
    const body = document.body.textContent ?? '';
    // Error state, distinct from the genuinely-empty copy.
    expect(body).toContain("Couldn't load this assertion's contents.");
    expect(body).not.toContain('This assertion has no extracted entities.');
    expect(body).not.toContain('No entities in this assertion.');
  });

  it('Triples tab renders a plain s/p/o table with NO filter pills (T10)', async () => {
    stateMock.fetchAssertionState.mockResolvedValue({
      state: 'created', layer: 'wm',
      assertionGraph: 'did:dkg:context-graph:cg-test/demo/assertion/0xabc/epcis-demo',
    });
    root = await mount(wmAssertion);
    // Switch to the Triples tab.
    const tabs = [...document.querySelectorAll('.v10-content-tab')];
    const triplesTab = tabs.find(t => t.textContent === 'Triples')!;
    await act(async () => { triplesTab.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    expect(document.querySelector('.v10-ka-triples-table')).not.toBeNull();
    // The entity-detail filter-pill chrome must NOT appear here.
    expect(document.querySelector('.v10-triples-filter-pills')).toBeNull();
    expect(document.querySelector('.v10-ka-pill')).toBeNull();
    expect(query('.v10-ka-triples-table').textContent).toContain('Battery cell 003');
  });

  // Codex round-9 (9-1) — the triples loading treatment is SHARED across
  // all three tabs. Pre-fix only the Entities pane gated on triplesLoading;
  // the Triples tab rendered a "0 of 0" table and the Graph tab fell through
  // to "No assertion graph data" while the fetch was still pending.
  it('triples loading: the Triples and Graph tabs show the loading treatment, not 0-of-0 / no-data', async () => {
    stateMock.fetchAssertionState.mockResolvedValue({
      state: 'created', layer: 'wm',
      assertionGraph: 'did:dkg:context-graph:cg-test/demo/assertion/0xabc/epcis-demo',
    });
    // Triples fetch never settles → triplesLoading stays true, triples empty.
    stateMock.fetchAssertionTriples.mockReset();
    stateMock.fetchAssertionTriples.mockReturnValue(new Promise(() => {}));
    root = await mount(wmAssertion);

    // Entities tab (default) shows loading.
    expect(document.body.textContent).toContain('Loading assertion entities');

    // Triples tab — must NOT render the empty "0 of 0" table.
    const tabs = () => [...document.querySelectorAll('.v10-content-tab')];
    await act(async () => { tabs().find(t => t.textContent === 'Triples')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    expect(document.querySelector('.v10-ka-triples-table')).toBeNull();
    expect(document.body.textContent).not.toContain('0 of 0 triples shown');
    expect(document.body.textContent).toContain('Loading assertion entities');

    // Graph tab — must NOT render "No assertion graph data".
    await act(async () => { tabs().find(t => t.textContent === 'Graph')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    expect(document.body.textContent).not.toContain('No assertion graph data');
    expect(document.body.textContent).toContain('Loading assertion entities');
  });

  it('triples error: ALL three tabs show the error state, not empty content', async () => {
    stateMock.fetchAssertionState.mockResolvedValue({
      state: 'created', layer: 'wm',
      assertionGraph: 'did:dkg:context-graph:cg-test/demo/assertion/0xabc/epcis-demo',
    });
    stateMock.fetchAssertionTriples.mockReset();
    stateMock.fetchAssertionTriples.mockRejectedValue(new Error('HTTP 500'));
    root = await mount(wmAssertion);

    const ERR = "Couldn't load this assertion's contents.";
    const tabs = () => [...document.querySelectorAll('.v10-content-tab')];

    // Entities tab.
    expect(document.body.textContent).toContain(ERR);

    // Triples tab — error, NOT the empty table.
    await act(async () => { tabs().find(t => t.textContent === 'Triples')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    expect(document.body.textContent).toContain(ERR);
    expect(document.querySelector('.v10-ka-triples-table')).toBeNull();
    expect(document.body.textContent).not.toContain('0 of 0 triples shown');

    // Graph tab — error, NOT "No assertion graph data".
    await act(async () => { tabs().find(t => t.textContent === 'Graph')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    expect(document.body.textContent).toContain(ERR);
    expect(document.body.textContent).not.toContain('No assertion graph data');
  });

  // Codex round-2 finding 3 — the Triples table must DISPLAY literals
  // decoded (datatype/lang suffix dropped, body unescaped), not the raw
  // N-Triples form. The producer (rawBindingValue) keeps the full form for
  // the Graph tab + buildMemoryEntities; the table renders through
  // decodeRdfStringLiteral. Pin typed / lang / escaped cases.
  it('Triples tab decodes typed / lang / escaped literals for display (no mangled suffix)', async () => {
    stateMock.fetchAssertionState.mockResolvedValue({
      state: 'created', layer: 'wm',
      assertionGraph: 'did:dkg:context-graph:cg-test/demo/assertion/0xabc/epcis-demo',
    });
    stateMock.fetchAssertionTriples.mockReset();
    stateMock.fetchAssertionTriples.mockResolvedValue([
      { subject: 'urn:e:1', predicate: 'http://schema.org/quantity', object: '"42"^^<http://www.w3.org/2001/XMLSchema#integer>' },
      { subject: 'urn:e:1', predicate: 'http://schema.org/greeting', object: '"bonjour"@fr' },
      { subject: 'urn:e:1', predicate: 'http://schema.org/quote', object: '"say \\"hi\\""' },
    ]);
    root = await mount(wmAssertion);
    const tabs = [...document.querySelectorAll('.v10-content-tab')];
    await act(async () => { tabs.find(t => t.textContent === 'Triples')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    const table = query('.v10-ka-triples-table').textContent ?? '';
    // Decoded values shown; raw suffixes/escapes NOT shown.
    expect(table).toContain('42');
    expect(table).not.toContain('^^<');
    expect(table).toContain('bonjour');
    expect(table).not.toContain('@fr');
    expect(table).toContain('say "hi"');     // unescaped
    expect(table).not.toContain('\\"');       // no raw backslash-escape
  });

  it('hydrating: badge omits the · state suffix and the Promote CTA stays hidden', async () => {
    // Never-resolving state fetch keeps the view in the hydrating phase.
    stateMock.fetchAssertionState.mockReturnValue(new Promise(() => {}));
    root = await mount(wmAssertion);
    const badge = query('.v10-trust-badge');
    expect(badge.textContent).toContain('Working');
    expect(badge.textContent).not.toContain('·');
    expect(query('.v10-ka-header-actions').textContent).not.toContain('Promote to SWM');
  });

  // Codex round-11 (11-1) — during the state hydrate the badge + tone must
  // reflect the KNOWN-true source layer (the list the detail opened from),
  // NOT the old `?? 'wm'` invention. An SWM assertion opened while its state
  // is still loading shows "◈ Shared", never "◇ Working".
  it('hydrating: badge reflects the SWM source layer, not an invented wm (11-1)', async () => {
    stateMock.fetchAssertionState.mockReturnValue(new Promise(() => {}));
    root = await mount(wmAssertion, 'swm'); // opened from the SWM list
    const badge = query('.v10-trust-badge');
    expect(badge.textContent).toContain('Shared'); // SWM trust label
    expect(badge.textContent).not.toContain('Working'); // no wm-flash
    expect(badge.textContent).toContain('◈'); // SWM glyph
    expect(badge.textContent).not.toContain('◇'); // not the WM glyph
  });

  // 11-1 — on a state-fetch error the badge must still show the source layer
  // (the value is real + known), NOT 'wm', so it doesn't contradict the
  // "state unavailable" message in the right rail.
  it('state-error: badge shows the SWM source layer alongside "state unavailable" (no wm contradiction)', async () => {
    stateMock.fetchAssertionState.mockResolvedValue(null);
    root = await mount(wmAssertion, 'swm');
    const badge = query('.v10-trust-badge');
    expect(badge.textContent).toContain('Shared');
    expect(badge.textContent).not.toContain('Working');
    expect(document.body.textContent).toContain('state unavailable');
  });

  // Codex round-11 (11-2) — header counts during load must NOT read as
  // `0 entities · 0 triples` (a false "empty" claim). entityCount is unknown
  // until the fetch → `…`; tripleCount seeds from the row when present, else
  // `…` — never 0 before the fetch settles.
  it('hydrating: header counts show placeholders, never 0 entities / 0 triples (11-2)', async () => {
    stateMock.fetchAssertionState.mockReturnValue(new Promise(() => {}));
    // Row carries NO tripleCount → both counts are placeholders.
    root = await mount({ name: 'x', graphUri: 'did:dkg:context-graph:cg-test/demo/assertion/0xabc/x', subGraph: 'demo' });
    const line = query('.v10-ka-ual').textContent ?? '';
    expect(line).not.toContain('0 entities');
    expect(line).not.toContain('0 triples');
    expect(line).toContain('… entities');
    expect(line).toContain('… triples');
  });

  // 11-2 — when the row carries a tripleCount it seeds immediately (no
  // 0-flash, no placeholder for that field); entities stay `…` until the
  // fetch resolves.
  it('hydrating: a row-seeded tripleCount shows immediately; entities stay a placeholder (11-2)', async () => {
    stateMock.fetchAssertionState.mockReturnValue(new Promise(() => {}));
    root = await mount({ name: 'x', graphUri: 'did:dkg:context-graph:cg-test/demo/assertion/0xabc/x', subGraph: 'demo', tripleCount: 142 });
    const line = query('.v10-ka-ual').textContent ?? '';
    expect(line).toContain('142 triples'); // row-seeded, no 0-flash
    expect(line).toContain('… entities');  // still unknown
    expect(line).not.toContain('0 entities');
    expect(line).not.toContain('0 triples');
  });

  // 11-2 — once resolved, the real counts replace the placeholders (incl. a
  // genuine zero, which is now a TRUE statement, not a hydrate artefact).
  it('resolved: header shows the real fetched counts (placeholders replaced)', async () => {
    stateMock.fetchAssertionState.mockResolvedValue({
      state: 'created', layer: 'wm',
      assertionGraph: 'did:dkg:context-graph:cg-test/demo/assertion/0xabc/epcis-demo',
    });
    // sampleTriples = 2 triples, 1 root entity (urn:e:battery).
    root = await mount(wmAssertion);
    const line = query('.v10-ka-ual').textContent ?? '';
    expect(line).toContain('2 triples');
    expect(line).not.toContain('… triples');
    expect(line).not.toContain('… entities');
    // Real entity count is present (not a placeholder).
    expect(line).toMatch(/\d+ entities/);
  });

  // 11-2 — a triples-FETCH error must keep the count placeholders, NEVER
  // surface `0 entities · 0 triples` (an operational failure must not read as
  // valid-but-empty).
  it('triples error: header counts stay placeholders, never 0 (11-2)', async () => {
    stateMock.fetchAssertionState.mockResolvedValue({
      state: 'created', layer: 'wm',
      assertionGraph: 'did:dkg:context-graph:cg-test/demo/assertion/0xabc/epcis-demo',
    });
    stateMock.fetchAssertionTriples.mockReset();
    stateMock.fetchAssertionTriples.mockRejectedValue(new Error('HTTP 500'));
    root = await mount(wmAssertion); // wmAssertion carries no tripleCount
    const line = query('.v10-ka-ual').textContent ?? '';
    expect(line).not.toContain('0 entities');
    expect(line).not.toContain('0 triples');
    expect(line).toContain('… entities');
    expect(line).toContain('… triples');
  });

  // Codex round-8 (8-1) — the empty-state must NOT FLASH during hydration.
  // On first mount `stateInfo` is null, so `assertionGraph` is undefined
  // and the triples effect sets `triplesLoading=false` immediately —
  // leaving the empty-state branch reachable BEFORE the lifecycle lookup
  // resolves (with `assertionEmptyStateCopy(undefined)`). The hydrating
  // treatment must win while `stateLoading` is true.
  it('hydrating (state fetch unresolved): Entities pane shows the loading treatment, NOT the empty-state flash', async () => {
    // State never resolves → stateLoading stays true → assertionGraph
    // undefined → triples effect early-returns with triplesLoading=false.
    stateMock.fetchAssertionState.mockReturnValue(new Promise(() => {}));
    root = await mount(wmAssertion);
    const body = document.body.textContent ?? '';
    // Hydrating treatment is shown …
    expect(body).toContain('Loading assertion entities');
    // … and NONE of the empty-state copies flash through.
    expect(body).not.toContain('This assertion has no extracted entities.');
    expect(body).not.toContain('No entities in this assertion');
    expect(body).not.toContain('now live in Shared Working Memory');
    expect(body).not.toContain('Knowledge Assets in Verifiable Memory');
  });

  it('state-fetch error: panel shows "state unavailable" + quiet trail hint, CTA hidden', async () => {
    stateMock.fetchAssertionState.mockResolvedValue(null);
    root = await mount(wmAssertion);
    expect(document.body.textContent).toContain('state unavailable');
    expect(document.querySelector('.v10-ka-trail-hint')?.textContent)
      .toContain("Lifecycle state couldn't load");
    expect(query('.v10-ka-header-actions').textContent).not.toContain('Promote to SWM');
  });

  // ux-lead §4.7.1 sibling edge — a created-WM assertion with a PRESENT
  // but EMPTY data graph (assertionGraph truthy, zero triples) must show
  // the "no extracted entities" copy, NOT the promoted line. The branch
  // keys purely on state==='promoted', so created → the generic empty
  // copy regardless of why it's empty. (This case does NOT hit the
  // triplesLoading bug — assertionGraph is truthy, the fetch resolves,
  // `.finally` unsticks loading — the risk is purely copy selection.)
  it('created-WM with a present-but-empty data graph shows "no extracted entities", not the promoted line', async () => {
    stateMock.fetchAssertionState.mockResolvedValue({
      state: 'created', layer: 'wm',
      assertionGraph: 'did:dkg:context-graph:cg-test/demo/assertion/0xabc/epcis-demo',
    });
    stateMock.fetchAssertionTriples.mockReset();
    stateMock.fetchAssertionTriples.mockResolvedValue([]); // present graph, zero triples
    root = await mount(wmAssertion);

    expect(document.body.textContent).not.toContain('Loading assertion entities');
    expect(document.body.textContent).toContain('No entities in this assertion');
    expect(document.body.textContent).toContain('This assertion has no extracted entities.');
    // The promoted forward-path line must NOT appear for a created assertion.
    expect(document.body.textContent).not.toContain('now live in Shared Working Memory');
    // A created-WM assertion still offers the Promote CTA.
    expect(query('.v10-ka-header-actions').textContent).toContain('Promote to SWM');
  });

  // Local-review 🟡 — AssertionDetailView is NOT keyed in ProjectView, so
  // switching `selectedAssertion` REUSES the instance. Navigating from
  // assertion A (triples mid-load) to assertion B that resolves WITHOUT a
  // dkg:assertionGraph (a promoted assertion, or a legacy record) must
  // reset triplesLoading in the effect's early-return — otherwise the
  // Entities pane sticks on "Loading assertion entities…" forever and the
  // promoted empty-state never renders. This pins the fix.
  it('A (triples mid-load) → B with no assertionGraph: triplesLoading resets, empty-state renders', async () => {
    // A — state resolves WITH a data graph; its triples fetch never
    // settles (stuck mid-load).
    stateMock.fetchAssertionState.mockResolvedValueOnce({
      state: 'created', layer: 'wm',
      assertionGraph: 'did:dkg:context-graph:cg-test/demo/assertion/0xabc/epcis-demo',
    });
    stateMock.fetchAssertionTriples.mockReset();
    stateMock.fetchAssertionTriples.mockReturnValueOnce(new Promise(() => {}));
    root = await mount(wmAssertion);
    // A is mid-load → the Entities pane shows the loading text.
    expect(document.body.textContent).toContain('Loading assertion entities');

    // B — a PROMOTED assertion: state resolves with NO assertionGraph
    // (its triples moved to /_shared_memory). Re-render the SAME instance
    // (no unmount) with a new assertion — the real ProjectView trigger.
    stateMock.fetchAssertionState.mockResolvedValueOnce({ state: 'promoted', layer: 'swm' });
    await render(root, { name: 'promoted-b', graphUri: 'did:dkg:context-graph:cg-test/assertion/0xabc/promoted-b' });
    await flush();

    // triplesLoading must have reset → no stuck loading text, and the
    // promoted empty-state renders with ux-lead's locked forward-path
    // copy ("entities" not "contents"; points to the SWM tab).
    expect(document.body.textContent).not.toContain('Loading assertion entities');
    expect(document.body.textContent).toContain('No entities in this assertion');
    expect(document.body.textContent).toContain(
      'its entities now live in Shared Working Memory. Open the Shared Working Memory tab to view them.',
    );
  });

  // Codex round-3 finding 3 — a published/finalized assertion (empty data
  // graph: entities moved to VM) must show the VM / Knowledge-Assets
  // empty-state line, NOT "no extracted entities" and NOT the SWM line.
  it('published assertion empty-state shows the VM / Knowledge-Assets line (not "no extracted entities")', async () => {
    stateMock.fetchAssertionState.mockResolvedValue({
      state: 'published', layer: 'vm',
      // post-publish the data graph is empty
      assertionGraph: 'did:dkg:context-graph:cg-test/demo/assertion/0xabc/epcis-demo',
    });
    stateMock.fetchAssertionTriples.mockReset();
    stateMock.fetchAssertionTriples.mockResolvedValue([]);
    root = await mount(wmAssertion);
    const body = document.body.textContent ?? '';
    expect(body).toContain('No entities in this assertion');
    expect(body).toContain('its entities are now Knowledge Assets in Verifiable Memory. Open the Verifiable Memory tab to view them.');
    expect(body).not.toContain('no extracted entities');
    // Scope the SWM-line check to the empty-state element — the lifecycle
    // trail in the right rail always renders the static stage title
    // "Promoted to Shared Working Memory" (the pipeline legend), so
    // checking the whole body would false-positive.
    const emptyStateText = document.querySelector('.v10-empty-state')?.textContent ?? body;
    expect(emptyStateText).not.toContain('now live in Shared Working Memory');
  });

  // Codex round-1 finding 1 — on assertion switch the hook must CLEAR
  // `data` so the previous assertion's state isn't briefly visible while
  // the new fetch is in flight. A → B where B's state never resolves: the
  // badge/State row must NOT show A's resolved state.
  it('switching to a slow-resolving assertion does not leave the prior state visible (stale-data clear)', async () => {
    // A — resolves to created/wm with a recognisable subgraph badge state.
    stateMock.fetchAssertionState.mockResolvedValueOnce({
      state: 'created', layer: 'wm',
      assertionGraph: 'did:dkg:context-graph:cg-test/demo/assertion/0xabc/epcis-demo',
    });
    root = await mount(wmAssertion);
    expect(query('.v10-trust-badge').textContent).toContain('created');

    // B — state never resolves (stuck hydrating). After the switch the
    // badge must drop the `· created` suffix (hydrating), NOT keep A's.
    stateMock.fetchAssertionState.mockReturnValueOnce(new Promise(() => {}));
    await render(root, { name: 'b', graphUri: 'did:dkg:context-graph:cg-test/assertion/0xabc/b' });
    await flush();
    const badge = query('.v10-trust-badge');
    expect(badge.textContent).not.toContain('created'); // A's state is gone
    expect(badge.textContent).not.toContain('·');        // hydrating: no state suffix
  });

  // Codex round-1 finding 2 — promoting FROM the detail view flips the
  // state in `_meta` but leaves graphUri unchanged. The view must REFETCH
  // its state + triples so the badge/CTA reflect the new state without a
  // remount.
  it('promoting from the detail refetches state + triples (post-promote staleness)', async () => {
    // Mount: created/wm → Promote CTA visible.
    stateMock.fetchAssertionState.mockResolvedValueOnce({
      state: 'created', layer: 'wm',
      assertionGraph: 'did:dkg:context-graph:cg-test/demo/assertion/0xabc/epcis-demo',
    });
    root = await mount(wmAssertion);
    expect(query('.v10-trust-badge').textContent).toContain('created');
    expect(query('.v10-ka-header-actions').textContent).toContain('Promote to SWM');
    expect(stateMock.fetchAssertionState).toHaveBeenCalledTimes(1);

    // After promote success the nonce bumps → state refetches and now
    // resolves to promoted/swm.
    stateMock.fetchAssertionState.mockResolvedValueOnce({
      state: 'promoted', layer: 'swm',
      assertionGraph: 'did:dkg:context-graph:cg-test/demo/assertion/0xabc/epcis-demo',
    });
    const cta = [...document.querySelectorAll('.v10-ka-header-actions button')]
      .find(b => b.textContent?.includes('Promote to SWM'))!;
    await act(async () => { cta.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    // promoteAssertion fired; state refetched (≥2 calls); badge now promoted;
    // CTA gone (promoted is not created+wm).
    expect(stateMock.promoteAssertion).toHaveBeenCalledTimes(1);
    expect(stateMock.fetchAssertionState.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(query('.v10-trust-badge').textContent).toContain('promoted');
    expect(query('.v10-ka-header-actions').textContent).not.toContain('Promote to SWM');
  });
});
