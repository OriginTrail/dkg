/**
 * GH #1264 — RS prevention: a confirmed one-shot `publish()` MUST self-promote
 * the KC into the SCOPED context-graph graphs the Random Sampling prover reads
 * (`<NAME>/context/<cgId>/_meta` + `<NAME>/context/<cgId>`).
 *
 * Before the fix `publish()` wrote the KC only to the legacy label graphs and
 * relied on chain-reconcile to promote it to scoped — which never reliably
 * fired for the publisher's OWN KC, so every prover tick reported
 * `kc-not-synced` and no proof landed (#1259 covered only the gossip-receiver
 * strand). This is the deterministic gate the issue asked for: it asserts the
 * scoped graphs are populated in the EXACT shape `extractV10KCFromStore`
 * (`random-sampling/src/ka-extractor.ts`) queries, so the prover can build a
 * proof on its first tick.
 *
 * The publisher package does not depend on `random-sampling`, so this asserts
 * the scoped graphs directly rather than importing the extractor; each
 * assertion is cross-referenced to the extractor query it satisfies. The
 * end-to-end "a core prover actually submits a proof" proof is the devnet
 * `v10-e2e` phase-1 RS gate.
 */
import { describe, it, expect } from 'vitest';
import { DKGPublisher } from '../src/dkg-publisher.js';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  TypedEventBus,
  generateEd25519Keypair,
  contextGraphMetaUri,
  contextGraphDataUri,
} from '@origintrail-official/dkg-core';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';
import { toHex } from '../src/metadata.js';
import { wrapPublisherForTest, mockSealCtx } from './_helpers/seal.js';
import { mockChainStubACKProvider } from './_helpers/acks.js';

const TEST_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const DKG_ONT = 'http://dkg.io/ontology/';
const XSD_INT = 'http://www.w3.org/2001/XMLSchema#integer';

/** Exact subject+predicate+object match (we already scoped the query to one graph). */
const hasTriple = (quads: Quad[], subject: string, predicate: string, object: string): boolean =>
  quads.some((q) => q.subject === subject && q.predicate === predicate && q.object === object);

/**
 * Mock chain that mints the seal signature the publisher's preflight requires
 * and counts `getKAContextGraphId` calls so the test can prove the fix resolves
 * the cgId from chain truth (the exact call the RS prover uses).
 */
class AdapterSigningChain extends MockChainAdapter {
  getKAContextGraphIdCalls = 0;
  constructor(private readonly wallet: ethers.Wallet) {
    super('mock:31337', wallet.address);
    this.seedIdentity(wallet.address, 1n);
    this.minimumRequiredSignatures = 1;
  }
  override async signMessage(
    messageHash: Uint8Array,
  ): Promise<{ r: Uint8Array; vs: Uint8Array }> {
    const sig = ethers.Signature.from(await this.wallet.signMessage(messageHash));
    return { r: ethers.getBytes(sig.r), vs: ethers.getBytes(sig.yParityAndS) };
  }
  async signTypedData(
    domain: ethers.TypedDataDomain,
    types: Record<string, Array<{ name: string; type: string }>>,
    value: Record<string, unknown>,
  ): Promise<string> {
    return this.wallet.signTypedData(domain, types, value);
  }
  // The on-chain cgId the promotion MUST scope by — deliberately DIFFERENT from
  // the local context-graph label / fallback so a test proves the promotion uses
  // this chain-truth value, not the local id (the exact failure mode #1264 fixes).
  chainTruthCgId = 7n;
  override async getKAContextGraphId(_kaId: bigint): Promise<bigint> {
    this.getKAContextGraphIdCalls++;
    return this.chainTruthCgId;
  }
}

async function sealForWallet(
  publisher: DKGPublisher,
  wallet: ethers.Wallet,
  chain: AdapterSigningChain,
): Promise<DKGPublisher> {
  return wrapPublisherForTest(publisher, {
    author: wallet,
    ctx: mockSealCtx({
      chainId: await chain.getEvmChainId(),
      kav10Address: await chain.getKnowledgeAssetsLifecycleAddress(),
    }),
    v10ACKProvider: mockChainStubACKProvider(),
  });
}

async function quadsIn(store: OxigraphStore, graph: string): Promise<Quad[]> {
  const res = await store.query(
    `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graph}> { ?s ?p ?o } }`,
  );
  return res.type === 'quads' ? res.quads : [];
}

describe('GH #1264 — publish() self-promotes a confirmed KC to the scoped graphs (RS prevention)', () => {
  it('lands the KC in the scoped meta + data graphs the RS prover reads', async () => {
    const wallet = new ethers.Wallet(TEST_KEY);
    const chain = new AdapterSigningChain(wallet);
    const store = new OxigraphStore();
    // Local context-graph label is '5', but the mock chain returns a DIFFERENT
    // on-chain cgId (chainTruthCgId = 7) from getKAContextGraphId. The promotion
    // MUST scope by chain-truth → `did:dkg:context-graph:5/context/7/{_meta,}` —
    // proving it uses the chain-truth value and not the local label/fallback.
    const CG = '5';
    const CHAIN_TRUTH = chain.chainTruthCgId.toString(); // '7' — what the RS prover reads
    const publisher = await sealForWallet(
      new DKGPublisher({
        store,
        chain,
        eventBus: new TypedEventBus(),
        keypair: await generateEd25519Keypair(),
        publisherNodeIdentityId: 1n,
      }),
      wallet,
      chain,
    );

    const root = 'urn:test:rs-entity';
    const result = await publisher.publish({
      contextGraphId: CG,
      quads: [
        {
          subject: root,
          predicate: `${DKG_ONT}name`,
          object: '"RS Test Entity"',
          graph: `did:dkg:context-graph:${CG}`,
        },
        {
          subject: root,
          predicate: `${DKG_ONT}value`,
          object: '"42"',
          graph: `did:dkg:context-graph:${CG}`,
        },
      ],
    });

    expect(result.status).toBe('confirmed');
    expect(result.kaId).toBeGreaterThan(0n);

    // The fix resolves the scoped cgId from CHAIN TRUTH (`getKAContextGraphId`,
    // the same call the prover uses) rather than the laggy local resolver.
    expect(chain.getKAContextGraphIdCalls).toBeGreaterThan(0);

    const scopedMeta = contextGraphMetaUri(CG, CHAIN_TRUTH); // …/context/7/_meta
    const scopedData = contextGraphDataUri(CG, CHAIN_TRUTH); // …/context/7

    // Discriminator: NOTHING lands under the local/fallback cgId (5). A regression
    // that ignored getKAContextGraphId's return and used the local fallback would
    // populate context/5 instead — this fails closed on that.
    expect(
      (await quadsIn(store, contextGraphMetaUri(CG, CG))).length,
      'scoped graphs must be under the chain-truth cgId (7), not the local fallback (5)',
    ).toBe(0);

    // ── Scoped META ────────────────────────────────────────────────────────
    const metaQuads = await quadsIn(store, scopedMeta);

    // ka-extractor.ts:183-189 resolves the UAL via an EXACT typed-integer match
    // `?ual dkg:batchId "<kaId>"^^xsd:integer`. The typing + exact value + UAL
    // subject are all load-bearing: a plain/mistyped literal (kaId 1 vs 10) or a
    // row on the wrong subject silently fails the prover. Assert all three.
    expect(
      hasTriple(metaQuads, result.ual, `${DKG_ONT}batchId`, `"${result.kaId}"^^<${XSD_INT}>`),
      'scoped _meta must carry `<ual> dkg:batchId "<kaId>"^^xsd:integer`',
    ).toBe(true);

    // ka-extractor.ts:204-220 reads root entities from the collapsed UAL subject
    // (`<ual> dkg:rootEntity <root>`). Assert the exact subject/predicate/object.
    expect(
      hasTriple(metaQuads, result.ual, `${DKG_ONT}rootEntity`, root),
      'scoped _meta must carry `<ual> dkg:rootEntity <root>`',
    ).toBe(true);

    // merkleRoot is written as a bare-hex (NO `0x`) untyped literal on the UAL
    // subject — the exact shape `publishFromSharedMemory` writes.
    expect(
      hasTriple(metaQuads, result.ual, `${DKG_ONT}merkleRoot`, `"${toHex(result.merkleRoot)}"`),
      'scoped _meta must carry `<ual> dkg:merkleRoot "<bare-hex>"`',
    ).toBe(true);

    // ── Scoped DATA ────────────────────────────────────────────────────────
    // ka-extractor.ts:260-276 — public triples pulled per root entity.
    const dataQuads = await quadsIn(store, scopedData);
    expect(
      dataQuads.some(
        (q) => q.subject === root && q.predicate === `${DKG_ONT}name`,
      ),
      'scoped data missing the published name triple',
    ).toBe(true);
    expect(
      dataQuads.some(
        (q) => q.subject === root && q.predicate === `${DKG_ONT}value`,
      ),
      'scoped data missing the published value triple',
    ).toBe(true);
  });

  it('multi-root publish re-emits the <ual>/<tokenId> pairing rows in scoped meta', async () => {
    const wallet = new ethers.Wallet(TEST_KEY);
    const chain = new AdapterSigningChain(wallet);
    const store = new OxigraphStore();
    const CG = '5';
    const publisher = await sealForWallet(
      new DKGPublisher({
        store,
        chain,
        eventBus: new TypedEventBus(),
        keypair: await generateEd25519Keypair(),
        publisherNodeIdentityId: 1n,
      }),
      wallet,
      chain,
    );

    // Two distinct root entities. This drives the PUBLIC pairing rows
    // (`<ual>/<tokenId>` rootEntity + partOf) end-to-end through publish()'s
    // promotion. The private per-token `privateMerkleRoot` push is the SAME loop
    // body guarded by the same `partitionMultiRoot` flag; its exact shape is
    // unit-tested over the identical writer contract in
    // test/multi-root-token-rows.test.ts. (A multi-root *private* publish can't
    // reach `confirmed` here — the stub ACK provider doesn't clear the private
    // slices — so the promotion, which only runs on confirm, can't be exercised
    // with private data through the mock; the parity above covers that shape.)
    const ROOT_A = 'urn:test:rs-multi:alpha';
    const ROOT_B = 'urn:test:rs-multi:beta';
    const dataGraph = `did:dkg:context-graph:${CG}`;
    const result = await publisher.publish({
      contextGraphId: CG,
      quads: [
        { subject: ROOT_A, predicate: `${DKG_ONT}name`, object: '"Alpha"', graph: dataGraph },
        { subject: ROOT_B, predicate: `${DKG_ONT}name`, object: '"Beta"', graph: dataGraph },
      ],
    });
    expect(result.status).toBe('confirmed');

    const scopedMeta = contextGraphMetaUri(CG, chain.chainTruthCgId.toString()); // chain-truth cgId (7)
    const metaQuads = await quadsIn(store, scopedMeta);

    // Collapsed aggregate rows survive on the UAL subject for BOTH roots
    // (read-both consumers, incl. the RS extractor's UNION).
    expect(hasTriple(metaQuads, result.ual, `${DKG_ONT}rootEntity`, ROOT_A)).toBe(true);
    expect(hasTriple(metaQuads, result.ual, `${DKG_ONT}rootEntity`, ROOT_B)).toBe(true);

    // Per-token pairing rows: each member root sits on its OWN `<ual>/<tokenId>`
    // subject with a `partOf <ual>` link back (the join key the AccessHandler uses
    // to pair a member root with its private bag). Resolve the token subject
    // structurally so the test is independent of canonical token numbering.
    const tokenSubjects = new Set<string>();
    for (const memberRoot of [ROOT_A, ROOT_B]) {
      const tokenRow = metaQuads.find(
        (q) =>
          q.predicate === `${DKG_ONT}rootEntity` &&
          q.object === memberRoot &&
          q.subject.startsWith(`${result.ual}/`),
      );
      expect(tokenRow, `missing <ual>/<tokenId> rootEntity row for ${memberRoot}`).toBeDefined();
      const tokenSubject = tokenRow!.subject;
      expect(
        hasTriple(metaQuads, tokenSubject, `${DKG_ONT}partOf`, result.ual),
        `token subject ${tokenSubject} must link partOf the UAL`,
      ).toBe(true);
      tokenSubjects.add(tokenSubject);
    }
    // Distinct token subjects per member root (no `<ual>/0` collision).
    expect(tokenSubjects.size).toBe(2);
  });
});
