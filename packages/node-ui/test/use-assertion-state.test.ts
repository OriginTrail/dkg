// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAssertionState, fetchAssertionTriples, listAssertions } from '../src/ui/api.js';

// S4 — pins the `_meta`-scoped assertion-state read + the assertion
// data-graph triple read (T19 + the data-shape contract). Mocks the
// transport boundary (`globalThis.fetch`, used by api.ts's `post`) so
// the parser code-path runs verbatim — same pattern as
// `list-assertions.test.ts`.

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as any;
}

describe('fetchAssertionState — reads dkg:state + memoryLayer from _meta (T19)', () => {
  let originalFetch: typeof globalThis.fetch | undefined;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as any;
  });
  afterEach(() => {
    if (originalFetch) globalThis.fetch = originalFetch;
  });

  function setBindings(bindings: unknown[]) {
    fetchMock.mockResolvedValueOnce(jsonResponse({ result: { bindings } }));
  }

  // Post-#864, `AssertionInfo.graphUri` is the DATA-GRAPH (partition) URI,
  // NOT the lifecycle URN. `fetchAssertionState` must take that partition
  // URI and reach `dkg:state` via the INVERSE `dkg:assertionGraph` link
  // (`?lifecycle dkg:assertionGraph <partitionURI>` → `?lifecycle dkg:state`).
  const PARTITION = 'did:dkg:context-graph:cg-A/assertion/0xabc/notes';

  it('queries <cg>/_meta keyed on the DATA-GRAPH URI via the inverse dkg:assertionGraph link (#864)', async () => {
    setBindings([{ state: { value: 'created' }, layer: { value: 'WM' } }]);
    await fetchAssertionState('cg-A', PARTITION);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.sparql).toContain('did:dkg:context-graph:cg-A/_meta');
    // The subject is bound via the inverse link, NOT used directly as the
    // lifecycle subject (feeding the partition URI to `dkg:state` directly
    // would never match → "state unavailable" silent regression).
    expect(body.sparql).toContain('assertionGraph');
    expect(body.sparql).toContain(`<${PARTITION}>`);
    expect(body.sparql).toContain('?lifecycle');
    expect(body.sparql).toContain('state');
    expect(body.sparql).toContain('memoryLayer');
    // The partition URI must NOT be wrapped as the direct dkg:state subject.
    expect(body.sparql).not.toContain(`<${PARTITION}> <http://dkg.io/ontology/state>`);
  });

  it('returns the created/wm shape; assertionGraph echoes the input partition URI', async () => {
    setBindings([{
      state: { value: 'created' },
      layer: { value: 'WM' },
      createdBy: { value: 'did:dkg:agent:0xabc' },
    }]);
    const out = await fetchAssertionState('cg-A', PARTITION);
    expect(out).toEqual({
      state: 'created',
      layer: 'wm',
      assertionGraph: PARTITION, // echoed input — the data graph to read triples from
      createdBy: 'did:dkg:agent:0xabc',
    });
  });

  it('maps SWM / VM memoryLayer literals to swm / vm', async () => {
    setBindings([{ state: { value: 'promoted' }, layer: { value: 'SWM' } }]);
    expect((await fetchAssertionState('cg-A', PARTITION))!.layer).toBe('swm');
    setBindings([{ state: { value: 'published' }, layer: { value: 'VM' } }]);
    expect((await fetchAssertionState('cg-A', PARTITION))!.layer).toBe('vm');
  });

  it('derives the layer from the state when the memoryLayer literal is absent', async () => {
    setBindings([{ state: { value: 'created' } }]);
    expect((await fetchAssertionState('cg-A', PARTITION))!.layer).toBe('wm');
    setBindings([{ state: { value: 'promoted' } }]);
    expect((await fetchAssertionState('cg-A', PARTITION))!.layer).toBe('swm');
    setBindings([{ state: { value: 'finalized' } }]);
    expect((await fetchAssertionState('cg-A', PARTITION))!.layer).toBe('vm');
  });

  it('returns null when no lifecycle entity links to this data graph', async () => {
    setBindings([]);
    expect(await fetchAssertionState('cg-A', PARTITION)).toBeNull();
  });

  it('returns null when the binding has no state literal', async () => {
    setBindings([{ layer: { value: 'WM' } }]);
    expect(await fetchAssertionState('cg-A', PARTITION)).toBeNull();
  });
});

describe('fetchAssertionTriples — reads the assertion data graph', () => {
  let originalFetch: typeof globalThis.fetch | undefined;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as any;
  });
  afterEach(() => {
    if (originalFetch) globalThis.fetch = originalFetch;
  });

  function setBindings(bindings: unknown[]) {
    fetchMock.mockResolvedValueOnce(jsonResponse({ result: { bindings } }));
  }

  it('queries the exact assertion data-graph URI', async () => {
    setBindings([]);
    await fetchAssertionTriples('cg-A', 'did:dkg:context-graph:cg-A/assertion/0xabc/notes');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.sparql).toContain('GRAPH <did:dkg:context-graph:cg-A/assertion/0xabc/notes>');
  });

  it('maps s/p/o bindings, preserving literal quoting on objects', async () => {
    setBindings([
      { s: { value: 'urn:e:1' }, p: { value: 'http://schema.org/name' }, o: { type: 'literal', value: 'Battery cell' } },
      { s: { value: 'urn:e:1' }, p: { value: 'http://example/ref' }, o: { value: 'urn:e:2' } },
    ]);
    const out = await fetchAssertionTriples('cg-A', 'urn:g');
    expect(out).toHaveLength(2);
    // Literal object is re-wrapped in quotes so downstream renderers
    // classify it as a literal (not an IRI).
    expect(out[0].object).toBe('"Battery cell"');
    // IRI object stays bare.
    expect(out[1].object).toBe('urn:e:2');
  });

  it('skips incomplete bindings', async () => {
    setBindings([
      { s: { value: 'urn:e:1' }, p: { value: 'p' }, o: { value: 'o' } },
      { s: { value: 'urn:e:2' }, p: { value: 'p' } }, // no ?o → skipped
    ]);
    const out = await fetchAssertionTriples('cg-A', 'urn:g');
    expect(out).toHaveLength(1);
  });

  // Codex round-1 — rawBindingValue must (a) PRESERVE datatype/lang
  // (the doc comment claimed it but the code dropped them) and (b) ESCAPE
  // embedded `"`/`\` so a quote-containing literal stays well-formed and
  // still classifies as a literal (leading `"`).
  it('preserves datatype on a typed literal', async () => {
    setBindings([
      { s: { value: 'urn:e:1' }, p: { value: 'p' }, o: { type: 'typed-literal', value: '42', datatype: 'http://www.w3.org/2001/XMLSchema#integer' } },
    ]);
    const out = await fetchAssertionTriples('cg-A', 'urn:g');
    expect(out[0].object).toBe('"42"^^<http://www.w3.org/2001/XMLSchema#integer>');
  });

  it('preserves the language tag on a lang-tagged literal', async () => {
    setBindings([
      { s: { value: 'urn:e:1' }, p: { value: 'p' }, o: { type: 'literal', value: 'bonjour', 'xml:lang': 'fr' } },
    ]);
    const out = await fetchAssertionTriples('cg-A', 'urn:g');
    expect(out[0].object).toBe('"bonjour"@fr');
  });

  it('escapes embedded quotes and backslashes in a literal', async () => {
    setBindings([
      { s: { value: 'urn:e:1' }, p: { value: 'p' }, o: { type: 'literal', value: 'say "hi"\\done' } },
    ]);
    const out = await fetchAssertionTriples('cg-A', 'urn:g');
    // Backslash → \\, quote → \" ; still starts with `"` (literal marker).
    expect(out[0].object).toBe('"say \\"hi\\"\\\\done"');
    expect(out[0].object.startsWith('"')).toBe(true);
  });

  // Codex round-6 — control chars (raw newline/tab/CR + other C0) in a
  // multiline extracted literal must be N-Triples-escaped, else the value
  // is invalid N-Triples and breaks the graph/triple parsers.
  it('escapes control chars (newline / tab / CR / other C0) in a literal', async () => {
    // Build the control chars + backslash at RUNTIME (fromCharCode) so the
    // test SOURCE holds no raw control bytes / ambiguous escapes.
    const NL = String.fromCharCode(10), TAB = String.fromCharCode(9), CR = String.fromCharCode(13), BELL = String.fromCharCode(7);
    const BS = String.fromCharCode(92); // backslash
    const raw = 'line1' + NL + 'line2' + TAB + 'col' + CR + 'end' + BELL + 'bell';
    setBindings([
      { s: { value: 'urn:e:1' }, p: { value: 'p' }, o: { type: 'literal', value: raw } },
    ]);
    const out = await fetchAssertionTriples('cg-A', 'urn:g');
    // Expected: two-char escapes BS+n / BS+t / BS+r and the BS+u0007 form.
    const expected = '"' + 'line1' + BS + 'n' + 'line2' + BS + 't' + 'col' + BS + 'r' + 'end' + BS + 'u0007' + 'bell' + '"';
    expect(out[0].object).toBe(expected);
    // No RAW control bytes survive in the output.
    // eslint-disable-next-line no-control-regex
    expect(out[0].object).not.toMatch(new RegExp('[\\u0000-\\u001F]'));
    expect(out[0].object.startsWith('"')).toBe(true);
  });

  // Codex round-5 — a SPARQL-JSON blank node must come back as `_:<id>`
  // (the form `useMemoryEntities.isUri` recognises as a resource), NOT the
  // bare identifier (which is neither a leading-`"` literal nor an
  // IRI-with-scheme → misclassified, bnode RDF structure lost).
  it('renders a blank-node object as _:<id> (resource, not literal/bare)', async () => {
    setBindings([
      { s: { value: 'urn:e:1' }, p: { value: 'http://example/part' }, o: { type: 'bnode', value: 'b0' } },
    ]);
    const out = await fetchAssertionTriples('cg-A', 'urn:g');
    expect(out[0].object).toBe('_:b0');
    // Sanity: it does NOT look like a literal (no leading quote).
    expect(out[0].object.startsWith('"')).toBe(false);
  });
});

// Make-or-break (#864 rebase): the REAL list→detail data flow, NOT a
// state-fetch mock. `listAssertions(wm)` now yields the partition URI as
// `graphUri`; feeding THAT into `fetchAssertionState` must still resolve
// `dkg:state` (via the inverse dkg:assertionGraph link). A direct-subject
// query would silently return null → "state unavailable" for every WM
// assertion. This drives both fns against the real fetch transport with
// the post-#864 partition shape end-to-end.
describe('listAssertions(wm) partition graphUri → fetchAssertionState resolves state (#864 regression guard)', () => {
  let originalFetch: typeof globalThis.fetch | undefined;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as any;
  });
  afterEach(() => {
    if (originalFetch) globalThis.fetch = originalFetch;
  });

  it('the graphUri from listAssertions(wm) feeds fetchAssertionState and hydrates created/wm', async () => {
    const PARTITION = 'did:dkg:context-graph:cg-A/assertion/0xabc/notes';

    // Call 1 — listAssertions(wm): #864 partition enumeration. ?g is the
    // DATA-GRAPH (partition) URI; ?cnt the triple count.
    fetchMock.mockResolvedValueOnce(jsonResponse({
      result: { bindings: [{ g: { value: PARTITION }, cnt: { value: '5' } }] },
    }));
    const rows = await listAssertions('cg-A', 'wm');
    expect(rows).toHaveLength(1);
    // Post-#864 the row's graphUri IS the partition URI (the regression risk).
    expect(rows[0].graphUri).toBe(PARTITION);
    expect(rows[0].tripleCount).toBe(5);

    // Call 2 — fetchAssertionState(graphUri): must resolve via the inverse
    // dkg:assertionGraph link. The daemon returns the lifecycle entity's
    // state for the bound `?lifecycle`.
    fetchMock.mockResolvedValueOnce(jsonResponse({
      result: { bindings: [{ state: { value: 'created' }, layer: { value: 'WM' } }] },
    }));
    const stateInfo = await fetchAssertionState('cg-A', rows[0].graphUri);

    // NOT null → no "state unavailable" silent regression.
    expect(stateInfo).not.toBeNull();
    expect(stateInfo!.state).toBe('created');
    expect(stateInfo!.layer).toBe('wm');
    // assertionGraph echoes the partition URI → the triples pane reads it.
    expect(stateInfo!.assertionGraph).toBe(PARTITION);

    // The state query keyed on the partition URI via the inverse link.
    const stateBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(stateBody.sparql).toContain('assertionGraph');
    expect(stateBody.sparql).toContain(`<${PARTITION}>`);
  });

  // SWM rows carry a DIFFERENT graphUri shape: `listAssertions(swm)` sets
  // graphUri = the LIFECYCLE URN (urn:dkg:assertion:…), not the data-graph
  // URI. The SWM AssertionsList is click-through too (layer !== 'vm'), so
  // fetchAssertionState must also resolve when fed the lifecycle URN
  // directly. The UNION's first branch (input IS the lifecycle subject)
  // handles that; the resolved dkg:assertionGraph gives the data graph to
  // read triples from.
  it('SWM lifecycle-URN graphUri also resolves state (UNION direct-subject branch)', async () => {
    const LIFECYCLE = 'urn:dkg:assertion:cg-A:0xabc:notes';
    const DATA_GRAPH = 'did:dkg:context-graph:cg-A/assertion/0xabc/notes';
    fetchMock.mockResolvedValueOnce(jsonResponse({
      result: { bindings: [{
        state: { value: 'promoted' },
        layer: { value: 'SWM' },
        assertionGraph: { value: DATA_GRAPH }, // resolved off the lifecycle subject
      }] },
    }));
    const stateInfo = await fetchAssertionState('cg-A', LIFECYCLE);
    expect(stateInfo).not.toBeNull();
    expect(stateInfo!.state).toBe('promoted');
    expect(stateInfo!.layer).toBe('swm');
    // For the lifecycle-URN input, assertionGraph comes from the resolved
    // dkg:assertionGraph (so the triples pane reads the data graph, not the
    // lifecycle URN).
    expect(stateInfo!.assertionGraph).toBe(DATA_GRAPH);
    // The query admits the lifecycle URN as the direct subject AND keys
    // off dkg:assertionGraph (the UNION covers both shapes).
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.sparql).toContain(`<${LIFECYCLE}>`);
    expect(body.sparql).toContain('UNION');
    expect(body.sparql).toContain('assertionGraph');
  });

  // Codex round-3 finding 2 — an SWM input (lifecycle URN) whose
  // dkg:assertionGraph did NOT resolve (legacy/partial _meta row) must
  // NOT echo the URN as assertionGraph (that would make
  // fetchAssertionTriples query `GRAPH <urn:dkg:assertion:…>` — a bogus
  // empty render). Return undefined → the panes show their empty-state.
  it('SWM lifecycle-URN with UNRESOLVED dkg:assertionGraph → assertionGraph undefined (not the URN)', async () => {
    const LIFECYCLE = 'urn:dkg:assertion:cg-A:0xabc:legacy-no-graph';
    fetchMock.mockResolvedValueOnce(jsonResponse({
      result: { bindings: [{ state: { value: 'promoted' }, layer: { value: 'SWM' } }] }, // no assertionGraph
    }));
    const stateInfo = await fetchAssertionState('cg-A', LIFECYCLE);
    expect(stateInfo).not.toBeNull();
    expect(stateInfo!.state).toBe('promoted');
    // Must NOT be the lifecycle URN; undefined so the triples pane is empty.
    expect(stateInfo!.assertionGraph).toBeUndefined();
  });

  // Counterpart — a WM data-graph-URI input with no resolved
  // dkg:assertionGraph (it IS the data graph) keeps echoing itself.
  it('WM data-graph-URI input with no resolved dkg:assertionGraph echoes the input (it IS the data graph)', async () => {
    const PARTITION = 'did:dkg:context-graph:cg-A/assertion/0xabc/notes';
    fetchMock.mockResolvedValueOnce(jsonResponse({
      result: { bindings: [{ state: { value: 'created' }, layer: { value: 'WM' } }] }, // no assertionGraph binding
    }));
    const stateInfo = await fetchAssertionState('cg-A', PARTITION);
    expect(stateInfo!.assertionGraph).toBe(PARTITION);
  });

  // Codex round-4 — branch A must bind ?lifecycle UNCONDITIONALLY with the
  // dkg:assertionGraph match OPTIONAL, so an SWM lifecycle-URN row whose
  // _meta carries dkg:state but NOT dkg:assertionGraph (legacy/partial)
  // still resolves its state. Pin the SPARQL shape so it can't regress to
  // requiring the assertionGraph triple to bind the lifecycle subject.
  it('SPARQL: branch A binds the input AS ?lifecycle unconditionally + OPTIONAL assertionGraph (round-4)', async () => {
    const LIFECYCLE = 'urn:dkg:assertion:cg-A:0xabc:legacy-no-graph';
    fetchMock.mockResolvedValueOnce(jsonResponse({
      result: { bindings: [{ state: { value: 'promoted' }, layer: { value: 'SWM' } }] },
    }));
    const stateInfo = await fetchAssertionState('cg-A', LIFECYCLE);
    // State still resolves (the round-4 outcome) and assertionGraph stays
    // undefined (round-3 guard composes).
    expect(stateInfo!.state).toBe('promoted');
    expect(stateInfo!.assertionGraph).toBeUndefined();
    const sparql = JSON.parse(fetchMock.mock.calls[0][1].body).sparql as string;
    // Unconditional BIND of the input as the lifecycle subject…
    expect(sparql).toContain(`BIND(<${LIFECYCLE}> AS ?lifecycle)`);
    // …with the assertionGraph match OPTIONAL (branch A no longer REQUIRES
    // `<input> dkg:assertionGraph ?assertionGraph` to bind ?lifecycle).
    expect(sparql).toMatch(/OPTIONAL\s*\{\s*<urn:dkg:assertion:cg-A:0xabc:legacy-no-graph>\s*<http:\/\/dkg\.io\/ontology\/assertionGraph>\s*\?assertionGraph\s*\}/);
  });
});
