/**
 * Codex review "multi-root-access" — conditional collapse regression tests.
 *
 * The P3.1 collapse put ALL member `dkg:rootEntity` and per-root
 * `dkg:privateMerkleRoot` rows on the bare UAL subject. Private bags are
 * stored and served strictly per root, so on a multi-root KA the
 * AccessHandler could only pick an engine-arbitrary root: non-first bags
 * became unreachable via any request shape, requests were denied when the
 * arbitrary pick had no bag, and wrong-member data verified silently (the F3
 * guard recomputes the attestation over whatever is served).
 *
 * Fix under test:
 *  1. writers (generateKCMetadata / restateKaPartition /
 *     restateLabelGraphForUpdate) re-emit the pre-trim `<ual>/<tokenId>`
 *     pairing rows for MULTI-root publishes only — single-root keeps the
 *     full collapse;
 *  2. the AccessHandler serves the first member root that actually HAS a
 *     private bag instead of denying on an arbitrary pick.
 */
import { describe, it, expect } from 'vitest';
import {
  TypedEventBus,
  encodeAccessRequest,
  decodeAccessResponse,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { AccessHandler } from '../src/access-handler.js';
import {
  generateKCMetadata,
  restateKaPartition,
  restateLabelGraphForUpdate,
  toHex,
  type KAMetadata,
} from '../src/metadata.js';

const DKG_NS = 'http://dkg.io/ontology/';
const CG = 'multi-root-token-rows-cg';
const META = `did:dkg:context-graph:${CG}/_meta`;
const PRIVATE = `did:dkg:context-graph:${CG}/_private`;
const UAL = 'did:dkg:hardhat:31337/0x00000000000000000000000000000000000000cc/5';
const ROOT_A = 'urn:test:tokenrows:alpha';
const ROOT_B = 'urn:test:tokenrows:beta';
const PRIV_A = new Uint8Array(32).fill(0xaa);
const PRIV_B = new Uint8Array(32).fill(0xbb);

function kaEntry(rootEntity: string, tokenId: bigint, privateMerkleRoot?: Uint8Array): KAMetadata {
  return {
    rootEntity,
    kcUal: UAL,
    tokenId,
    publicTripleCount: 1,
    privateTripleCount: privateMerkleRoot ? 1 : 0,
    privateMerkleRoot,
  };
}

function kcMeta() {
  return {
    ual: UAL,
    contextGraphId: CG,
    merkleRoot: new Uint8Array(32).fill(1),
    publisherPeerId: 'test-peer',
    accessPolicy: 'public' as const,
    timestamp: new Date('2026-06-12T00:00:00Z'),
  };
}

async function requestPrivate(handler: AccessHandler, kaUal: string) {
  const data = encodeAccessRequest({
    kaUal,
    requesterPeerId: 'requester-peer',
    paymentProof: new Uint8Array(0),
    requesterSignature: new Uint8Array(0),
  });
  const raw = await handler.handler(
    data,
    { toString: () => 'requester-peer', toBytes: () => new Uint8Array() } as never,
  );
  return decodeAccessResponse(raw);
}

const tokenRows = (quads: Quad[]) => quads.filter((q) => q.subject.startsWith(`${UAL}/`));

describe('generateKCMetadata — conditional collapse', () => {
  it('single-root publish keeps the full collapse (no token rows)', () => {
    const quads = generateKCMetadata(kcMeta(), [kaEntry(ROOT_A, 1n, PRIV_A)]);
    expect(tokenRows(quads)).toEqual([]);
    // Collapsed rows still on the UAL subject.
    expect(quads).toContainEqual(
      { subject: UAL, predicate: `${DKG_NS}rootEntity`, object: ROOT_A, graph: META },
    );
  });

  it('multi-root publish re-emits exact per-token pairing rows alongside the collapsed rows', () => {
    const quads = generateKCMetadata(kcMeta(), [
      kaEntry(ROOT_A, 1n, PRIV_A),
      kaEntry(ROOT_B, 2n, PRIV_B),
    ]);
    // Collapsed aggregate rows survive (read-both consumers).
    expect(quads).toContainEqual({ subject: UAL, predicate: `${DKG_NS}rootEntity`, object: ROOT_A, graph: META });
    expect(quads).toContainEqual({ subject: UAL, predicate: `${DKG_NS}rootEntity`, object: ROOT_B, graph: META });
    // Pairing rows: token N ties root N to private root N.
    for (const [n, root, priv] of [['1', ROOT_A, PRIV_A], ['2', ROOT_B, PRIV_B]] as const) {
      expect(quads).toContainEqual({ subject: `${UAL}/${n}`, predicate: `${DKG_NS}rootEntity`, object: root, graph: META });
      expect(quads).toContainEqual({ subject: `${UAL}/${n}`, predicate: `${DKG_NS}partOf`, object: UAL, graph: META });
      expect(quads).toContainEqual({ subject: `${UAL}/${n}`, predicate: `${DKG_NS}privateMerkleRoot`, object: `"${toHex(priv)}"`, graph: META });
      expect(quads).toContainEqual({ subject: `${UAL}/${n}`, predicate: `${DKG_NS}privateTripleCount`, object: '"1"^^<http://www.w3.org/2001/XMLSchema#integer>', graph: META });
    }
  });
});

describe('AccessHandler on the dual (multi-root) shape', () => {
  async function seedDualShapeStore(): Promise<OxigraphStore> {
    const store = new OxigraphStore();
    await store.insert(generateKCMetadata(kcMeta(), [
      kaEntry(ROOT_A, 1n, PRIV_A),
      kaEntry(ROOT_B, 2n, PRIV_B),
    ]));
    await store.insert([
      { subject: ROOT_A, predicate: 'http://ex.org/secretA', object: '"alpha-secret"', graph: PRIVATE },
      { subject: ROOT_B, predicate: 'http://ex.org/secretB', object: '"beta-secret"', graph: PRIVATE },
    ]);
    return store;
  }

  it('legacy `<ual>/<n>` requests resolve EXACTLY root N with root N\'s attestation', async () => {
    const handler = new AccessHandler(await seedDualShapeStore(), new TypedEventBus());

    const res1 = await requestPrivate(handler, `${UAL}/1`);
    expect(res1.granted).toBe(true);
    expect(new TextDecoder().decode(res1.nquads)).toContain('alpha-secret');
    expect(toHex(Uint8Array.from(res1.privateMerkleRoot))).toBe(toHex(PRIV_A));

    const res2 = await requestPrivate(handler, `${UAL}/2`);
    expect(res2.granted).toBe(true);
    expect(new TextDecoder().decode(res2.nquads)).toContain('beta-secret');
    expect(toHex(Uint8Array.from(res2.privateMerkleRoot))).toBe(toHex(PRIV_B));
  });
});

describe('AccessHandler hardening on already-written collapsed multi-root stores', () => {
  it('serves the member root that HAS a bag instead of denying on an arbitrary pick', async () => {
    const store = new OxigraphStore();
    // Pre-fix collapsed-only rows (no token rows): two member roots, but a
    // private bag exists ONLY for ROOT_B. Pre-hardening, an engine that
    // bound ROOT_A first denied "No private triples available".
    await store.insert([
      { subject: UAL, predicate: `${DKG_NS}rootEntity`, object: ROOT_A, graph: META },
      { subject: UAL, predicate: `${DKG_NS}rootEntity`, object: ROOT_B, graph: META },
      { subject: UAL, predicate: `${DKG_NS}privateMerkleRoot`, object: `"${toHex(PRIV_B)}"`, graph: META },
      { subject: UAL, predicate: `${DKG_NS}contextGraph`, object: `did:dkg:context-graph:${CG}`, graph: META },
      { subject: UAL, predicate: `${DKG_NS}accessPolicy`, object: '"public"', graph: META },
    ]);
    await store.insert([
      { subject: ROOT_B, predicate: 'http://ex.org/secretB', object: '"beta-secret"', graph: PRIVATE },
    ]);

    const handler = new AccessHandler(store, new TypedEventBus());
    const res = await requestPrivate(handler, UAL);
    expect(res.granted).toBe(true);
    expect(new TextDecoder().decode(res.nquads)).toContain('beta-secret');
  });
});

describe('restate writers — conditional collapse', () => {
  const DATA = `did:dkg:context-graph:${CG}/context/9/data`;
  const CTX_META = `did:dkg:context-graph:${CG}/context/9/_meta`;

  async function metaQuadsOf(store: OxigraphStore, graph: string): Promise<Quad[]> {
    const res = await store.query(`SELECT ?s ?p ?o WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
    return res.type === 'bindings'
      ? res.bindings.map((b) => ({ subject: b['s'], predicate: b['p'], object: b['o'], graph }))
      : [];
  }

  it('restateKaPartition: single-root collapses fully; multi-root re-emits token rows', async () => {
    const store = new OxigraphStore();
    const base = {
      store, dataGraph: DATA, metaGraph: CTX_META, ual: UAL, kaId: 7n,
      merkleRoot: new Uint8Array(32).fill(2),
    };

    await restateKaPartition({
      ...base,
      payloadByRoot: new Map([[ROOT_A, [{ subject: ROOT_A, predicate: 'http://ex.org/p', object: '"v"', graph: '' }]]]),
      privateRootByRoot: new Map([[ROOT_A, PRIV_A]]),
    });
    expect(tokenRows(await metaQuadsOf(store, CTX_META))).toEqual([]);

    await restateKaPartition({
      ...base,
      payloadByRoot: new Map([
        [ROOT_A, [{ subject: ROOT_A, predicate: 'http://ex.org/p', object: '"v"', graph: '' }]],
        [ROOT_B, [{ subject: ROOT_B, predicate: 'http://ex.org/p', object: '"w"', graph: '' }]],
      ]),
      privateRootByRoot: new Map([[ROOT_A, PRIV_A], [ROOT_B, PRIV_B]]),
    });
    const rows = await metaQuadsOf(store, CTX_META);
    expect(rows).toContainEqual({ subject: `${UAL}/1`, predicate: `${DKG_NS}rootEntity`, object: ROOT_A, graph: CTX_META });
    expect(rows).toContainEqual({ subject: `${UAL}/1`, predicate: `${DKG_NS}privateMerkleRoot`, object: `"${toHex(PRIV_A)}"`, graph: CTX_META });
    expect(rows).toContainEqual({ subject: `${UAL}/2`, predicate: `${DKG_NS}rootEntity`, object: ROOT_B, graph: CTX_META });
    expect(rows).toContainEqual({ subject: `${UAL}/2`, predicate: `${DKG_NS}privateMerkleRoot`, object: `"${toHex(PRIV_B)}"`, graph: CTX_META });
    expect(rows).toContainEqual({ subject: `${UAL}/2`, predicate: `${DKG_NS}partOf`, object: UAL, graph: CTX_META });
  });

  it('restateLabelGraphForUpdate: multi-root update re-emits token rows; a later single-root update collapses them again', async () => {
    const store = new OxigraphStore();
    const LABEL_DATA = `did:dkg:context-graph:${CG}`;
    const base = { store, dataGraph: LABEL_DATA, metaGraph: META, ual: UAL, merkleRoot: new Uint8Array(32).fill(3) };

    await restateLabelGraphForUpdate({
      ...base,
      payloadByRoot: new Map([
        [ROOT_A, [{ subject: ROOT_A, predicate: 'http://ex.org/p', object: '"v"', graph: '' }]],
        [ROOT_B, [{ subject: ROOT_B, predicate: 'http://ex.org/p', object: '"w"', graph: '' }]],
      ]),
      privateRootByRoot: new Map([[ROOT_B, PRIV_B]]),
    });
    let rows = await metaQuadsOf(store, META);
    expect(rows).toContainEqual({ subject: `${UAL}/1`, predicate: `${DKG_NS}rootEntity`, object: ROOT_A, graph: META });
    expect(rows).toContainEqual({ subject: `${UAL}/2`, predicate: `${DKG_NS}rootEntity`, object: ROOT_B, graph: META });
    expect(rows).toContainEqual({ subject: `${UAL}/2`, predicate: `${DKG_NS}privateMerkleRoot`, object: `"${toHex(PRIV_B)}"`, graph: META });
    // Token 1 had no private bag — no pairing row.
    expect(rows).not.toContainEqual({ subject: `${UAL}/1`, predicate: `${DKG_NS}privateMerkleRoot`, object: `"${toHex(PRIV_B)}"`, graph: META });

    // Shrink back to one root: token subjects are purged (the restate IS the
    // migration), single-root keeps the collapse.
    await restateLabelGraphForUpdate({
      ...base,
      payloadByRoot: new Map([[ROOT_A, [{ subject: ROOT_A, predicate: 'http://ex.org/p', object: '"v2"', graph: '' }]]]),
    });
    rows = await metaQuadsOf(store, META);
    expect(tokenRows(rows)).toEqual([]);
    expect(rows).toContainEqual({ subject: UAL, predicate: `${DKG_NS}rootEntity`, object: ROOT_A, graph: META });
  });
});
