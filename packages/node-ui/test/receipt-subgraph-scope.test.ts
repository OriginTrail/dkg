/**
 * Regression: a same-named assertion in a DIFFERENT sub-graph must NOT
 * leak its reservedUal/agent/batchId into another sub-graph's receipt.
 *
 * Two sub-graphs ("demo" and "other") in the SAME context graph each carry an
 * assertion with the SAME name ("note") authored by the SAME address. Both
 * stamp the SAME shared member entity on their lifecycle URN (a real-world
 * member entity is NOT namespaced under either assertion URI, so the
 * `?lc dkg:rootEntity <entity>` clause alone does NOT disambiguate which
 * sub-graph's lifecycle URN to join). Each sub-graph has a DIFFERENT
 * reservedUal / agent / batchId. Resolving the receipt must bind the
 * reservedUal/agent/batchId of the SAME sub-graph as the winning ?asrt, never
 * the sibling sub-graph's.
 *
 * Pre-fix the OPTIONAL lifecycle filter derived the expected URN tail from
 * `STRAFTER(?asrt, "/assertion/")` → only `:{addr}:{name}`, dropping the
 * sub-graph segment that sits BEFORE "/assertion/". So BOTH sub-graphs' URNs
 * (`urn:dkg:assertion:cg:demo:{addr}:note` and `…:cg:other:{addr}:note`) ended
 * with `:{addr}:note` and BOTH matched — the join could (and did) bind the
 * WRONG sub-graph's reservedUal under LIMIT 1.
 *
 * The fix pins to the FULL scope (cg + optional subGraphName): the expected
 * URN tail is derived from the assertion URI's `{cg}[/{sub}]` (the segment
 * before "/assertion/") PLUS `{addr}/{name}` (after), `/`→`:`.
 */
import { describe, it, expect } from 'vitest';
import {
  assertionLifecycleUri,
  contextGraphAssertionUri,
  contextGraphMetaUri,
  buildAssertionPublishReceiptQuads,
} from '@origintrail-official/dkg-core';
import { OxigraphStore } from '../../storage/src/index.js';
import { buildSealReceiptQuery } from '../src/ui/hooks/useEntityOnChainReceipt.js';

const DKG = 'http://dkg.io/ontology/';
const PROV = 'http://www.w3.org/ns/prov#';

const CG = 'subgraph-scope-test';
const META = contextGraphMetaUri(CG);
const ADDR = '0x00000000000000000000000000000000000000aa';
const NAME = 'note'; // SAME name in both sub-graphs.
// A SHARED real-world member entity, NOT namespaced under either assertion
// URI, stamped by BOTH sub-graphs' lifecycle URNs — so the lifecycle
// `dkg:rootEntity <entity>` clause alone does not pick a sub-graph; only the
// (now full-scope) URN-tail filter can.
const SHARED_ENTITY = `did:dkg:context-graph:${CG}/member/0xshared`;

const q = (s: string, p: string, o: string) => ({ subject: s, predicate: p, object: o, graph: META });
const lex = (v: string | undefined) =>
  (v ?? '').replace(/^"/, '').replace(/"(\^\^<[^>]*>)?$/, '');

/** Seed one sub-graph's full writer-shaped rows for the SAME (addr,name). */
async function seedSubGraph(
  store: OxigraphStore,
  sub: string,
  entity: string,
  reservedUal: string,
  agentDid: string,
  batchId: string,
  tx: string,
): Promise<void> {
  const asrt = contextGraphAssertionUri(CG, ADDR, NAME, sub);
  const lc = assertionLifecycleUri(CG, ADDR, NAME, sub);
  await store.insert([
    // Seal member-entity link (buildAssertionSealQuads dual-write shape).
    q(asrt, `${DKG}assertionRootEntity`, entity),
    q(asrt, `${DKG}assertionEntity`, entity),
  ]);
  await store.insert(
    buildAssertionPublishReceiptQuads({ assertionUri: asrt, metaGraph: META, txHash: tx, blockNumber: 42n }),
  );
  // Lifecycle URN rows: member-entity stamp + reservedUal + agent.
  await store.insert([
    q(lc, `${DKG}rootEntity`, entity),
    q(lc, `${DKG}reservedUal`, `"${reservedUal}"`),
    q(lc, `${PROV}wasAttributedTo`, agentDid),
  ]);
  // UAL-subject batchId (read-both target for the dropped publishedAtKaId).
  await store.insert([
    { subject: reservedUal, predicate: `${DKG}batchId`, object: `"${batchId}"^^<http://www.w3.org/2001/XMLSchema#integer>`, graph: META },
  ]);
}

const DEMO_UAL = `did:dkg:hardhat:31337/${ADDR}/7`;
const OTHER_UAL = `did:dkg:hardhat:31337/${ADDR}/99`;
const DEMO_AGENT = `did:dkg:agent:${ADDR}`;
const OTHER_AGENT = `did:dkg:agent:0x00000000000000000000000000000000000000bb`;
const DEMO_TX = '0x' + 'ab'.repeat(32);
const OTHER_TX = '0x' + 'cd'.repeat(32);

async function seedBothSubGraphs(): Promise<OxigraphStore> {
  const store = new OxigraphStore();
  // BOTH sub-graphs stamp the SAME shared entity on their lifecycle URN.
  await seedSubGraph(store, 'demo', SHARED_ENTITY, DEMO_UAL, DEMO_AGENT, '111', DEMO_TX);
  await seedSubGraph(store, 'other', SHARED_ENTITY, OTHER_UAL, OTHER_AGENT, '999', OTHER_TX);
  return store;
}

describe('buildSealReceiptQuery — same name + same member entity across sub-graphs', () => {
  it('binds reservedUal/agent/batchId of the SAME sub-graph as the winning ?asrt, not a sibling', async () => {
    const store = await seedBothSubGraphs();

    // The clicked entity is shared by both sub-graphs. The top-level FILTER
    // (EXISTS assertionEntity) binds ?asrt to BOTH assertions; ORDER + LIMIT 1
    // surfaces one. Whichever sub-graph's ?asrt wins, the joined
    // reservedUal/agent/batchId MUST belong to that SAME sub-graph.
    const res = await store.query(buildSealReceiptQuery(CG, SHARED_ENTITY));
    expect(res.type).toBe('bindings');
    const rows = res.type === 'bindings' ? res.bindings : [];
    expect(rows).toHaveLength(1);
    const row = rows[0];

    const asrt = String(row['asrt']);
    // Which sub-graph did ?asrt resolve to? Tie ?ual/?agentLc/?batchId to it.
    const isDemo = asrt.includes('/demo/');
    const isOther = asrt.includes('/other/');
    expect(isDemo || isOther).toBe(true);

    const expected = isDemo
      ? { ual: DEMO_UAL, agent: DEMO_AGENT, tx: DEMO_TX, batchId: '111' }
      : { ual: OTHER_UAL, agent: OTHER_AGENT, tx: OTHER_TX, batchId: '999' };
    const wrong = isDemo
      ? { ual: OTHER_UAL, agent: OTHER_AGENT }
      : { ual: DEMO_UAL, agent: DEMO_AGENT };

    expect(lex(row['tx'])).toBe(expected.tx);
    // THE regression: the lifecycle join must pin to the winning sub-graph.
    expect(lex(row['ual'])).toBe(expected.ual);
    expect(lex(row['ual'])).not.toBe(wrong.ual);
    expect(row['agentLc']).toBe(expected.agent);
    expect(row['agentLc']).not.toBe(wrong.agent);
    expect(lex(row['batchId'])).toBe(expected.batchId);
  });

  it('resolves the ROOT (no sub-graph) partition unchanged', async () => {
    const store = new OxigraphStore();
    const ROOT_UAL = `did:dkg:hardhat:31337/${ADDR}/5`;
    const ROOT_ENTITY = `did:dkg:context-graph:${CG}/assertion/${ADDR}/note/.well-known/genid/1`;
    const asrt = contextGraphAssertionUri(CG, ADDR, NAME);
    const lc = assertionLifecycleUri(CG, ADDR, NAME);
    await store.insert([
      q(asrt, `${DKG}assertionRootEntity`, ROOT_ENTITY),
      q(asrt, `${DKG}assertionEntity`, ROOT_ENTITY),
    ]);
    await store.insert(
      buildAssertionPublishReceiptQuads({ assertionUri: asrt, metaGraph: META, txHash: DEMO_TX, blockNumber: 42n }),
    );
    await store.insert([
      q(lc, `${DKG}rootEntity`, ROOT_ENTITY),
      q(lc, `${DKG}reservedUal`, `"${ROOT_UAL}"`),
      q(lc, `${PROV}wasAttributedTo`, DEMO_AGENT),
    ]);

    const res = await store.query(buildSealReceiptQuery(CG, ROOT_ENTITY));
    const rows = res.type === 'bindings' ? res.bindings : [];
    expect(rows).toHaveLength(1);
    // The full-scope URN derivation must still bind in the no-sub-graph case.
    expect(lex(rows[0]['ual'])).toBe(ROOT_UAL);
    expect(rows[0]['agentLc']).toBe(DEMO_AGENT);
  });
});

/**
 * Regression: a WALLET-SCOPED cgId contains a "/" (V10 convention
 * `<curatorAddress>/<name>`, see deriveCuratorDidFromCgId in
 * packages/core/src/constants.ts). Both URI builders embed the cgId RAW —
 *   assertion URI = did:dkg:context-graph:{cg}[/{sub}]/assertion/{addr}/{name}
 *   lifecycle URN = urn:dkg:assertion:{cg}[:{sub}]:{addr}:{name}
 * so when {cg} itself is `0x…/experimental-music` the slash inside the cgId is
 * PRESERVED in the URN (`urn:dkg:assertion:0x…/experimental-music:{addr}:{name}`).
 *
 * The first attempt at the sub-graph-scope fix ran a BLANKET `REPLACE("/"→":")`
 * over the whole derived scope. That also rewrote the slash INSIDE the
 * wallet-scoped cgId, so the CONCAT produced
 * `:0x…:experimental-music:{addr}:{name}` while the real URN still carries
 * `:0x…/experimental-music:{addr}:{name}` — STRENDS stopped matching and EVERY
 * wallet-scoped CG lost its `?ual`/`?agentLc`/`?batchId` (silently empty).
 *
 * The corrected FILTER anchors on the literal cgId (slashes intact) and only
 * "/"→":" converts the `[/sub]/{addr}/{name}` tail derived from `?asrt`. This
 * suite seeds the REAL writers under a slash-cg for (a) a ROOT assertion and
 * (b) two sibling sub-graphs sharing one member entity, and asserts the join
 * still binds — NON-EMPTY — and never leaks across the sibling sub-graph.
 */
describe('buildSealReceiptQuery — wallet-scoped cgId containing "/"', () => {
  // `<curatorAddress>/<name>` — the V10 wallet-scoped shape. Passes
  // validateContextGraphId (alphanumeric + "/" + "-" all allowed) and matches
  // deriveCuratorDidFromCgId's `0x{40 hex}/.+` pattern.
  const SLASH_CG = '0x00000000000000000000000000000000000000cc/experimental-music';
  const SLASH_META = contextGraphMetaUri(SLASH_CG);
  const sq = (s: string, p: string, o: string) => ({ subject: s, predicate: p, object: o, graph: SLASH_META });

  /** Seed one (root or sub-graph) assertion under the slash-cg via real writers. */
  async function seedSlash(
    store: OxigraphStore,
    entity: string,
    reservedUal: string,
    agentDid: string,
    batchId: string,
    tx: string,
    sub?: string,
  ): Promise<void> {
    const asrt = contextGraphAssertionUri(SLASH_CG, ADDR, NAME, sub);
    const lc = assertionLifecycleUri(SLASH_CG, ADDR, NAME, sub);
    await store.insert([
      sq(asrt, `${DKG}assertionRootEntity`, entity),
      sq(asrt, `${DKG}assertionEntity`, entity),
    ]);
    await store.insert(
      buildAssertionPublishReceiptQuads({ assertionUri: asrt, metaGraph: SLASH_META, txHash: tx, blockNumber: 42n }),
    );
    await store.insert([
      sq(lc, `${DKG}rootEntity`, entity),
      sq(lc, `${DKG}reservedUal`, `"${reservedUal}"`),
      sq(lc, `${PROV}wasAttributedTo`, agentDid),
    ]);
    await store.insert([
      { subject: reservedUal, predicate: `${DKG}batchId`, object: `"${batchId}"^^<http://www.w3.org/2001/XMLSchema#integer>`, graph: SLASH_META },
    ]);
  }

  it('binds NON-EMPTY ?ual/?agentLc/?batchId for a ROOT assertion under a slash-cg', async () => {
    const store = new OxigraphStore();
    const ROOT_ENTITY = `did:dkg:context-graph:${SLASH_CG}/member/0xroot`;
    const ROOT_UAL = `did:dkg:hardhat:31337/${ADDR}/5`;
    await seedSlash(store, ROOT_ENTITY, ROOT_UAL, DEMO_AGENT, '555', DEMO_TX);

    const res = await store.query(buildSealReceiptQuery(SLASH_CG, ROOT_ENTITY));
    expect(res.type).toBe('bindings');
    const rows = res.type === 'bindings' ? res.bindings : [];
    expect(rows).toHaveLength(1);
    const row = rows[0];

    expect(row['asrt']).toBe(contextGraphAssertionUri(SLASH_CG, ADDR, NAME));
    expect(lex(row['tx'])).toBe(DEMO_TX);
    // THE regression: the blanket REPLACE rewrote the cgId's own "/" so the
    // URN-tail STRENDS broke and these all came back EMPTY for slash-cgs.
    expect(lex(row['ual'])).not.toBe('');
    expect(lex(row['ual'])).toBe(ROOT_UAL);
    expect(row['agentLc']).toBe(DEMO_AGENT);
    expect(lex(row['batchId'])).not.toBe('');
    expect(lex(row['batchId'])).toBe('555');
  });

  it('binds the SAME sub-graph (no sibling leak) for a sub-graph assertion under a slash-cg', async () => {
    const store = new OxigraphStore();
    // One shared member entity stamped by BOTH sibling sub-graphs' lifecycle
    // URNs under the slash-cg — only the full-scope (slash-preserving) URN-tail
    // filter can pick the winning sub-graph's reservedUal.
    const SHARED = `did:dkg:context-graph:${SLASH_CG}/member/0xshared`;
    await seedSlash(store, SHARED, DEMO_UAL, DEMO_AGENT, '111', DEMO_TX, 'demo');
    await seedSlash(store, SHARED, OTHER_UAL, OTHER_AGENT, '999', OTHER_TX, 'other');

    const res = await store.query(buildSealReceiptQuery(SLASH_CG, SHARED));
    expect(res.type).toBe('bindings');
    const rows = res.type === 'bindings' ? res.bindings : [];
    expect(rows).toHaveLength(1);
    const row = rows[0];

    const asrt = String(row['asrt']);
    const isDemo = asrt.includes('/demo/');
    const isOther = asrt.includes('/other/');
    expect(isDemo || isOther).toBe(true);

    const expected = isDemo
      ? { ual: DEMO_UAL, agent: DEMO_AGENT, batchId: '111' }
      : { ual: OTHER_UAL, agent: OTHER_AGENT, batchId: '999' };
    const wrong = isDemo
      ? { ual: OTHER_UAL, agent: OTHER_AGENT }
      : { ual: DEMO_UAL, agent: DEMO_AGENT };

    // NON-EMPTY (regression made them empty) AND pinned to the winning sub-graph.
    expect(lex(row['ual'])).not.toBe('');
    expect(lex(row['ual'])).toBe(expected.ual);
    expect(lex(row['ual'])).not.toBe(wrong.ual);
    expect(row['agentLc']).toBe(expected.agent);
    expect(row['agentLc']).not.toBe(wrong.agent);
    expect(lex(row['batchId'])).not.toBe('');
    expect(lex(row['batchId'])).toBe(expected.batchId);
  });
});
