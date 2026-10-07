// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from 'vitest';
import {
  DKG_ONTOLOGY,
  SYSTEM_CONTEXT_GRAPHS,
  contextGraphCatalogUri,
  contextGraphDataGraphUri,
} from '@origintrail-official/dkg-core';
import { type OxigraphStore, type TripleStore } from '@origintrail-official/dkg-storage';

import { PeerGateRevision } from '../src/internal/peer-gate-revision.js';
import {
  AGENT, CG_DID, CONTROL_GRAPH, KA_GRAPH, KA_UAL, MEMORY_LAYER, META_GRAPH, NAME, SWM_META_GRAPH, quad, stack,
} from './_helpers/recipient-fence-stack.js';

const CG = '0xabc/proj';
const OTHER_CG = '0xother/graph';
const DELEGATION = `did:dkg:agent-delegation:${CG}:d1`;
const ALLOWED_PEER = DKG_ONTOLOGY.DKG_ALLOWED_PEER;

describe('PeerGateRevision', () => {
  const revision = () => new PeerGateRevision(new Set([ALLOWED_PEER, DKG_ONTOLOGY.DKG_ACCESS_POLICY]));
  const moved = (gate: PeerGateRevision, graph: string, act: () => void): boolean => {
    const before = gate.read(graph);
    act();
    return gate.read(graph) !== before;
  };

  it('moves one graph for its own facts and every graph for everything', () => {
    const gate = revision();
    expect(gate.read(CG)).toBe('0:0');
    expect(moved(gate, CG, () => gate.noteFacts(CG))).toBe(true);
    expect(moved(gate, OTHER_CG, () => gate.noteFacts(CG))).toBe(false);
    expect(moved(gate, OTHER_CG, () => gate.noteEverything())).toBe(true);
    expect(moved(gate, CG, () => gate.noteEverything())).toBe(true);
  });

  it.each([
    ['a knowledge-asset subject', { subject: KA_UAL }],
    ['an assertion lifecycle subject', { subject: 'urn:dkg:assertion:a1' }],
    ['a share subject', { subject: 'urn:dkg:share:s1' }],
    ['an agent subject', { subject: AGENT }],
    ['a predicate the record does not read', { predicate: MEMORY_LAYER }],
    ['a context graph subject with a predicate the record does not read', { subject: CG_DID, predicate: MEMORY_LAYER }],
  ])('does not move for a removal naming %s', (_label, scope) => {
    const gate = revision();
    expect(moved(gate, CG, () => gate.noteRemoval(CG, scope))).toBe(false);
  });

  it.each([
    ['nothing', {}],
    ['the context graph itself', { subject: CG_DID }],
    ['a sub-graph', { subject: `${CG_DID}/sub` }],
    ['a delegation', { subject: DELEGATION }],
    ['a predicate the record reads', { predicate: ALLOWED_PEER }],
    ['an empty subject', { subject: '' }],
    ['a bracketed subject', { subject: `<${KA_UAL}>` }],
    ['a subject without a scheme', { subject: 'relative-name' }],
    ['an unsafe predicate', { predicate: 'urn:p q' }],
  ])('moves for a removal naming %s', (_label, scope) => {
    const gate = revision();
    expect(moved(gate, CG, () => gate.noteRemoval(CG, scope))).toBe(true);
  });
});

describe('peer gate revision through the production store wrapper (GH#3067)', () => {
  const stores: OxigraphStore[] = [];
  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close()));
  });
  const open = async () => {
    const built = await stack();
    stores.push(built.store);
    return { ...built, read: (graph = CG) => built.projection.peerGateRevision.read(graph) };
  };

  type Wrapper = TripleStore;
  const noise: Array<[string, (store: Wrapper) => Promise<unknown>]> = [
    ['a knowledge-asset metadata delete in the graph\'s own _meta', (s) => s.deleteByPatternWithoutCount!({ graph: META_GRAPH, subject: KA_UAL })],
    ['an assertion layer delete in _meta', (s) => s.deleteByPatternWithoutCount!({ graph: META_GRAPH, subject: KA_GRAPH, predicate: MEMORY_LAYER })],
    ['a lifecycle delete in _meta', (s) => s.deleteByPatternWithoutCount!({ graph: META_GRAPH, subject: 'urn:dkg:assertion:a1' })],
    ['a knowledge-asset metadata replace in _meta', (s) => s.replaceSubject!(META_GRAPH, KA_UAL, [quad(KA_UAL, NAME, META_GRAPH)])],
    ['a promote-queue job replace', (s) => s.replaceSubject!(CONTROL_GRAPH, 'urn:dkg:promote-queue:job:j1', [
      quad('urn:dkg:promote-queue:job:j1', 'urn:dkg:promote-queue:state', CONTROL_GRAPH)])],
    ['a share metadata delete', (s) => s.deleteByPatternWithoutCount!({ graph: SWM_META_GRAPH, subject: 'urn:dkg:share:s1' })],
    ['a knowledge-asset graph drop', (s) => s.dropGraph(KA_GRAPH)],
    ['an insert of content', (s) => s.insert([quad('urn:x:doc', NAME, KA_GRAPH)])],
    ['an insert of knowledge-asset metadata', (s) => s.insert([quad(KA_UAL, MEMORY_LAYER, META_GRAPH)])],
    ['a metadata fact of another context graph', (s) => s.insert([quad(`did:dkg:context-graph:${OTHER_CG}`, ALLOWED_PEER, `did:dkg:context-graph:${OTHER_CG}/_meta`)])],
    ['a delete of another context graph\'s subject', (s) => s.deleteByPatternWithoutCount!({
      graph: `did:dkg:context-graph:${OTHER_CG}/_meta`, subject: KA_UAL })],
    ['a read', (s) => s.query('SELECT * WHERE { GRAPH ?g { ?s ?p ?o } } LIMIT 5')],
  ];

  it.each(noise)('does not move for %s', async (label, run) => {
    const { wrapper, read } = await open();
    const before = read();
    await run(wrapper);
    expect(read(), label).toBe(before);
  });

  it('moves the cache revision of the graph for the knowledge-asset metadata deletes that leave the gate alone', async () => {
    const { wrapper, projection, read } = await open();
    const cache = projection.readContextGraphAuthorityFactsRevision(CG);
    const gate = read();
    await wrapper.deleteByPatternWithoutCount!({ graph: META_GRAPH, subject: KA_UAL });
    expect(projection.readContextGraphAuthorityFactsRevision(CG)).not.toBe(cache);
    expect(read()).toBe(gate);
  });

  const signal: Array<[string, (store: Wrapper) => Promise<unknown>]> = [
    ['an insert of an allowed peer', (s) => s.insert([quad(CG_DID, ALLOWED_PEER, META_GRAPH)])],
    ['a delete of an allowed peer', (s) => s.delete([quad(CG_DID, ALLOWED_PEER, META_GRAPH)])],
    ['an insert of the access policy', (s) => s.insert([quad(CG_DID, DKG_ONTOLOGY.DKG_ACCESS_POLICY, META_GRAPH)])],
    ['an insert of a delegation fact', (s) => s.insert([quad(DELEGATION, DKG_ONTOLOGY.DKG_DELEGATION_AGENT, META_GRAPH)])],
    ['a removal of the graph\'s own facts by subject', (s) => s.deleteByPatternWithoutCount!({ graph: META_GRAPH, subject: CG_DID })],
    ['a removal of a whole meta graph', (s) => s.dropGraph(META_GRAPH)],
    ['a replace of the meta graph', (s) => s.replaceGraph!(META_GRAPH, [quad(CG_DID, NAME, META_GRAPH)])],
    ['a replace of the graph\'s own subject', (s) => s.replaceSubject!(META_GRAPH, CG_DID, [quad(CG_DID, ALLOWED_PEER, META_GRAPH)])],
    ['a replace of the catalog subject', (s) => s.replaceSubject!(contextGraphCatalogUri(CG), CG_DID, [
      quad(CG_DID, DKG_ONTOLOGY.DCT_ACCESS_RIGHTS, contextGraphCatalogUri(CG))])],
    ['a removal of a catalog fact by predicate', (s) => s.deleteByPatternWithoutCount!({
      graph: contextGraphCatalogUri(CG), subject: CG_DID, predicate: DKG_ONTOLOGY.DCT_ACCESS_RIGHTS })],
    ['a removal in the agents graph', (s) => s.deleteByPatternWithoutCount!({
      graph: contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.AGENTS), subject: CG_DID })],
    ['a prefix delete', (s) => s.deleteBySubjectPrefix(KA_GRAPH, 'urn:x:')],
    ['a removal naming an empty graph', (s) => s.deleteByPatternWithoutCount!({ graph: '' })],
    ['a removal naming a bracketed graph, which the store rejects', (s) =>
      s.deleteByPatternWithoutCount!({ graph: `<${KA_GRAPH}>` }).catch(() => undefined)],
    ['a SPARQL update', (s) => s.update!(`INSERT DATA { GRAPH <${KA_GRAPH}> { <urn:x:a> <${NAME}> "v" } }`)],
  ];

  it.each(signal)('moves for %s', async (label, run) => {
    const { wrapper, read } = await open();
    const before = read();
    await run(wrapper);
    expect(read(), label).not.toBe(before);
  });

  it('moves for a counted removal of allowed peers by predicate', async () => {
    const { wrapper, read } = await open();
    await wrapper.insert([quad(CG_DID, ALLOWED_PEER, META_GRAPH)]);
    const before = read();
    await wrapper.deleteByPattern({ graph: META_GRAPH, predicate: ALLOWED_PEER });
    expect(read()).not.toBe(before);
  });

  it('moves for a counted removal naming an empty graph, which removes the allowlist from every graph', async () => {
    const { wrapper, read } = await open();
    await wrapper.insert([quad(CG_DID, ALLOWED_PEER, META_GRAPH)]);
    const before = read();
    expect(await wrapper.deleteByPattern({ graph: '' })).toBeGreaterThan(0);
    expect(read()).not.toBe(before);
  });

  it('moves for an explicit invalidation of the graph, and not for a fresh-read request', async () => {
    const { projection, read } = await open();
    const before = read();
    projection.requireFreshRead(CG);
    expect(read()).toBe(before);
    projection.markDirty(CG);
    expect(read()).not.toBe(before);
  });
});
