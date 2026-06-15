/**
 * SECURITY (Codex #1171) — `isContextGraphRegistered` must only trust the
 * AUTHORITATIVE graphs for the `<cgUri> a dkg:ContextGraph` registration triple:
 * the system ONTOLOGY data graph (public CGs + every publish) or the CG's own
 * `_meta` graph (curated CGs). The previous cross-graph `ASK { GRAPH ?g … }`
 * matched ANY graph, so a publisher could author that triple in their own content
 * graph (the rdf:type OBJECT is not a reserved IRI) and SPOOF registration —
 * mis-deriving the ownership key in `reconstructSharedMemoryOwnership` after
 * restart. These tests pin: legit registration in either authoritative graph is
 * detected; a type triple authored in any other (user) graph is NOT.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DKGPublisher } from '../src/dkg-publisher.js';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  TypedEventBus,
  generateEd25519Keypair,
  contextGraphDataUri,
  contextGraphDataGraphUri,
  contextGraphMetaUri,
  SYSTEM_CONTEXT_GRAPHS,
} from '@origintrail-official/dkg-core';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const CG_TYPE = 'http://dkg.io/ontology/ContextGraph';

describe('isContextGraphRegistered — authoritative-graph scoping (Codex #1171)', () => {
  let store: OxigraphStore;
  let isRegistered: (cgId: string) => Promise<boolean>;

  beforeEach(async () => {
    store = new OxigraphStore();
    const publisher = new DKGPublisher({
      store,
      // isContextGraphRegistered only reads `this.store`; a no-op chain stub is fine.
      chain: { chainId: 'none' } as unknown as ChainAdapter,
      eventBus: new TypedEventBus(),
      keypair: await generateEd25519Keypair(),
    });
    isRegistered = (cgId) =>
      (publisher as unknown as { isContextGraphRegistered(id: string): Promise<boolean> })
        .isContextGraphRegistered(cgId);
  });

  // Write the registration type triple for `cgId` into `graph`.
  const writeTypeTriple = (cgId: string, graph: string) =>
    store.insert([{ subject: contextGraphDataUri(cgId), predicate: RDF_TYPE, object: CG_TYPE, graph }]);

  it('unregistered CG ⇒ false', async () => {
    expect(await isRegistered('0xabc/never-registered')).toBe(false);
  });

  it('registered in the system ONTOLOGY data graph (public + publish path) ⇒ true', async () => {
    const cg = '0xabc/public-cg';
    await writeTypeTriple(cg, contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY));
    expect(await isRegistered(cg)).toBe(true);
  });

  it('registered in the CG `_meta` graph (curated create path) ⇒ true', async () => {
    const cg = '0xabc/curated-cg';
    await writeTypeTriple(cg, contextGraphMetaUri(cg));
    expect(await isRegistered(cg)).toBe(true);
  });

  it('SPOOF: type triple authored in another CG\'s content graph ⇒ false', async () => {
    const victim = '0xvictim/cg';
    // an attacker publishes content into THEIR CG and authors the victim's type
    // triple there — a user data graph, not the authoritative ontology/_meta graph.
    await writeTypeTriple(victim, contextGraphDataGraphUri('0xattacker/cg'));
    expect(await isRegistered(victim)).toBe(false);
  });

  it('SPOOF: type triple authored in the victim CG\'s own data graph ⇒ false', async () => {
    const victim = '0xvictim2/cg';
    // the CG's own data graph (named by its DID) carries user-authored content; a
    // type triple planted there must NOT count as registration.
    await writeTypeTriple(victim, contextGraphDataUri(victim));
    expect(await isRegistered(victim)).toBe(false);
  });
});
