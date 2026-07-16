/**
 * `dkg_get_entity_sources` — addressed-read provenance tool.
 *
 * The engine contract (scoped `GRAPH ?g` binds the source, but a VM read also
 * returns root / per-collection graphs) is pinned in packages/query. Here we
 * pin the tool surface:
 *   - issues the controlled single-tier `GRAPH ?g` query (never the SWM-union);
 *   - attributes a fact to a KA ONLY from a per-KA partition;
 *   - collapses a root/per-KA duplicate and keeps genuine multi-publisher;
 *   - discloses (does not silently drop) facts with no citable KA;
 *   - does NOT offer working-memory (needs an agent identity);
 *   - refuses an injection-shaped entity URI.
 */
import { describe, it, expect } from 'vitest';
import { registerReadTools } from '../src/tools.js';
import { FakeServer, FakeClient, makeConfig } from './harness.js';

// cgId must match makeConfig()'s defaultProject ('test-cg'): the tool anchors
// parseEntitySource on the resolved project id, so per-KA graphs only attribute
// when their CG segment equals it.
const CG = 'test-cg';
const VM = (addr: string, n: string) => `did:dkg:context-graph:${CG}/_verifiable_memory/${addr}/${n}`;
const SWM = (addr: string, n: string) => `did:dkg:context-graph:${CG}/_shared_memory/${addr}/${n}`;
const ROOT = `did:dkg:context-graph:${CG}`;
const PERCGID = `did:dkg:context-graph:${CG}/context/7`;

describe('dkg_get_entity_sources', () => {
  it('issues a scoped, single-view GRAPH ?g query and defaults to verifiable-memory', async () => {
    const server = new FakeServer();
    const client = new FakeClient();
    registerReadTools(server.asMcpServer(), client.asDkgClient(), makeConfig());

    const result = await server.call('dkg_get_entity_sources', { uri: 'urn:x:1' });
    expect(result.isError).toBeFalsy();
    const call = client.queryCalls.at(-1)!;
    // Assert the FULL addressed-read shape, anchored at the END so nothing can
    // be appended (a `toContain` would still pass with a trailing LIMIT/ORDER
    // BY, which would silently break the no-modifiers provenance contract).
    const sparql = String(call.sparql).trim();
    expect(sparql.endsWith('SELECT ?p ?o ?g WHERE { GRAPH ?g { <urn:x:1> ?p ?o } }')).toBe(true);
    expect(sparql).not.toMatch(/\b(LIMIT|OFFSET|ORDER\s+BY|DISTINCT|REDUCED)\b/i);
    expect(call.view).toBe('verifiable-memory');
    expect(call.contextGraphId).toBe('test-cg');
    // Never the WM∪SWM union path (that would duplicate every sourced row).
    expect(call.includeSharedMemory).toBeUndefined();
  });

  it('normalizes a full-DID project id so per-KA graphs still attribute', async () => {
    // The client accepts/normalizes `did:dkg:context-graph:<id>`; the anchor
    // must use the same normalized id or every per-KA graph reads unattributed.
    const server = new FakeServer();
    const client = new FakeClient({
      query: async () => ({ bindings: [{ p: 'http://schema.org/name', o: '"X"', g: VM('0xaa', '7') }] }),
    });
    registerReadTools(server.asMcpServer(), client.asDkgClient(), makeConfig());
    const result = await server.call('dkg_get_entity_sources', {
      uri: 'urn:x:1',
      projectId: 'did:dkg:context-graph:test-cg',
    });
    expect(result.content[0].text).toContain('0xaa/7'); // attributed despite DID-form id
    expect(client.queryCalls.at(-1)!.contextGraphId).toBe('test-cg');
  });

  it('attributes facts to KA sources, collapses the root duplicate, and discloses unattributed facts', async () => {
    const server = new FakeServer();
    const client = new FakeClient({
      query: async () => ({
        bindings: [
          // X-name: in a per-KA partition AND duplicated in the root graph.
          { p: 'http://schema.org/name', o: '"X-name"', g: VM('0xaa', '7') },
          { p: 'http://schema.org/name', o: '"X-name"', g: ROOT },
          // X-color: a single per-KA source.
          { p: 'http://schema.org/color', o: '"X-color"', g: VM('0xbb', '8') },
          // X-shape: only in the per-collection graph → no citable KA.
          { p: 'http://schema.org/shape', o: '"square"', g: PERCGID },
        ],
      }),
    });
    registerReadTools(server.asMcpServer(), client.asDkgClient(), makeConfig());

    const result = await server.call('dkg_get_entity_sources', { uri: 'urn:x:1' });
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;

    // Attributed facts carry their KA; the root duplicate of X-name collapses
    // (X-name appears once, attributed to the per-KA source).
    expect(text).toContain('X-name');
    expect(text).toContain('0xaa/7');
    expect(text).toContain('X-color');
    expect(text).toContain('0xbb/8');
    expect((text.match(/X-name/g) ?? []).length).toBe(1);
    // Two verifiable KA sources (0xaa/7 + 0xbb/8); the bare root is NOT a
    // source line (backtick-delimited exact match — the per-KA URIs share the
    // root as a prefix, so a bare `toContain(ROOT)` would false-positive).
    expect(text).toContain('Sources (2 verifiable KAs)');
    expect(text).not.toContain(`\`${ROOT}\``);
    // The per-collection-only fact is disclosed, not shown as a KA source.
    expect(text).not.toContain('square');
    expect(text).toMatch(/1 additional fact/);
  });

  it('keeps genuine multi-publisher attribution (same fact asserted by two KAs)', async () => {
    const server = new FakeServer();
    const client = new FakeClient({
      query: async () => ({
        bindings: [
          { p: 'http://schema.org/name', o: '"shared"', g: VM('0xaa', '1') },
          { p: 'http://schema.org/name', o: '"shared"', g: VM('0xbb', '2') },
        ],
      }),
    });
    registerReadTools(server.asMcpServer(), client.asDkgClient(), makeConfig());
    const result = await server.call('dkg_get_entity_sources', { uri: 'urn:x:1' });
    const text = result.content[0].text;
    expect((text.match(/shared/g) ?? []).length).toBe(1); // one fact line
    expect(text).toContain('0xaa/1');
    expect(text).toContain('0xbb/2'); // ...with both KA sources
    expect(text).toContain('Sources (2 verifiable KAs)');
  });

  it('reports no KA-attributable facts when only non-per-KA graphs match', async () => {
    const server = new FakeServer();
    const client = new FakeClient({
      query: async () => ({ bindings: [{ p: 'http://schema.org/name', o: '"only-root"', g: ROOT }] }),
    });
    registerReadTools(server.asMcpServer(), client.asDkgClient(), makeConfig());
    const result = await server.call('dkg_get_entity_sources', { uri: 'urn:x:1' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/No KA-attributable facts/);
  });

  it('caps rendered facts at `limit`, discloses the remainder, and truncates deterministically', async () => {
    const server = new FakeServer();
    const client = new FakeClient({
      // Rows returned in REVERSE order (p4..p0) to prove the cap selects by a
      // stable sort, not backend row order.
      query: async () => ({
        bindings: Array.from({ length: 5 }, (_, i) => {
          const n = 4 - i;
          return { p: `http://schema.org/p${n}`, o: `"v${n}"`, g: VM('0xaa', String(n)) };
        }),
      }),
    });
    registerReadTools(server.asMcpServer(), client.asDkgClient(), makeConfig());
    const result = await server.call('dkg_get_entity_sources', { uri: 'urn:x:1', limit: 2 });
    const text = result.content[0].text;
    // Exactly 2 fact lines rendered (one `←` arrow each), remainder disclosed.
    expect((text.match(/←/g) ?? []).length).toBe(2);
    expect(text).toMatch(/3 more attributed fact\(s\) not shown/);
    // Deterministic: the two LOWEST by (predicate, object) are shown regardless
    // of input order — p0/p1, never the late-sorting p2..p4. (prettyTerm strips
    // the literal quotes, so match the bare value.)
    expect(text).toContain('schema:p0');
    expect(text).toContain('schema:p1');
    expect(text).not.toContain('schema:p2');
    expect(text).not.toContain('schema:p4');
  });

  it('forwards an explicit shared-working-memory view', async () => {
    const server = new FakeServer();
    const client = new FakeClient();
    registerReadTools(server.asMcpServer(), client.asDkgClient(), makeConfig());
    await server.call('dkg_get_entity_sources', { uri: 'urn:x:1', view: 'shared-working-memory' });
    expect(client.queryCalls.at(-1)!.view).toBe('shared-working-memory');
  });

  it('does not offer working-memory (rejected at the schema)', async () => {
    const server = new FakeServer();
    const client = new FakeClient();
    registerReadTools(server.asMcpServer(), client.asDkgClient(), makeConfig());
    await expect(
      server.call('dkg_get_entity_sources', { uri: 'urn:x:1', view: 'working-memory' }),
    ).rejects.toThrow();
  });

  it('frames shared-working-memory sources as DRAFT, not on-chain/verifiable', async () => {
    // SWM per-KA (author, number) is a reserved, pre-mint UAL — not on chain.
    const server = new FakeServer();
    const client = new FakeClient({
      query: async () => ({ bindings: [{ p: 'http://schema.org/name', o: '"draft-name"', g: SWM('0xaa', '3') }] }),
    });
    registerReadTools(server.asMcpServer(), client.asDkgClient(), makeConfig());
    const result = await server.call('dkg_get_entity_sources', { uri: 'urn:x:1', view: 'shared-working-memory' });
    const text = result.content[0].text;
    expect(text).toContain('draft KA');
    expect(text).toContain('not yet on-chain');
    // Must NOT assert the verifiable/on-chain framing for a draft tier.
    expect(text).not.toContain('verifiable KA');
  });

  it('does not fabricate a KA for an adversarially-named CG whose id embeds a layer tail', async () => {
    // CG id is valid (validateContextGraphId allows `/` and `_`); its ROOT
    // graph looks like a per-KA partition to a greedy parser. Anchoring on the
    // known project id must classify it as unattributed, not "KA 0xaa/1".
    const evilCg = 'evil/_verifiable_memory/0xaa/1';
    const server = new FakeServer();
    const client = new FakeClient({
      query: async () => ({ bindings: [{ p: 'http://schema.org/name', o: '"x"', g: `did:dkg:context-graph:${evilCg}` }] }),
    });
    registerReadTools(server.asMcpServer(), client.asDkgClient(), makeConfig());
    const result = await server.call('dkg_get_entity_sources', { uri: 'urn:x:1', projectId: evilCg });
    const text = result.content[0].text;
    expect(text).not.toContain('KA `0xaa/1`');
    expect(text).toMatch(/No KA-attributable facts/);
  });

  it('forwards subGraphName and attributes a sub-graph-scoped per-KA source', async () => {
    const server = new FakeServer();
    const client = new FakeClient({
      query: async () => ({
        bindings: [{ p: 'http://schema.org/name', o: '"sub-name"', g: `did:dkg:context-graph:${CG}/decisions/_verifiable_memory/0xaa/7` }],
      }),
    });
    registerReadTools(server.asMcpServer(), client.asDkgClient(), makeConfig());
    const result = await server.call('dkg_get_entity_sources', { uri: 'urn:x:1', subGraphName: 'decisions' });
    expect(client.queryCalls.at(-1)!.subGraphName).toBe('decisions');
    // The sub-graph segment between cgId and the layer slug still attributes.
    expect(result.content[0].text).toContain('0xaa/7');
  });

  it('rejects an injection-shaped entity URI before querying', async () => {
    const server = new FakeServer();
    const client = new FakeClient();
    registerReadTools(server.asMcpServer(), client.asDkgClient(), makeConfig());
    const before = client.queryCalls.length;
    const result = await server.call('dkg_get_entity_sources', { uri: 'urn:x> } UNION { ?s ?p ?o' });
    expect(result.isError).toBe(true);
    expect(client.queryCalls.length).toBe(before);
  });

  it('fails closed on a mismatched angle bracket instead of silently re-targeting', async () => {
    // `<urn:x` must NOT be unwrapped to `urn:x` (a different, valid entity);
    // only a matched `<…>` pair is stripped, so the stray `<` is rejected.
    const server = new FakeServer();
    const client = new FakeClient();
    registerReadTools(server.asMcpServer(), client.asDkgClient(), makeConfig());
    const before = client.queryCalls.length;
    const result = await server.call('dkg_get_entity_sources', { uri: '<urn:x' });
    expect(result.isError).toBe(true);
    expect(client.queryCalls.length).toBe(before);
  });
});
