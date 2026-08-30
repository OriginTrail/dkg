/**
 * RandomSamplingProver orchestrator end-to-end tests.
 *
 * Drives the prover with a stub chain adapter (only the
 * RandomSampling + KC view methods it actually uses) plus a real
 * OxigraphStore seeded with KC quads. Pins:
 *   1. Happy path: tick -> submitted, WAL records each transition.
 *   2. Period closed: tick returns period-closed, no chain writes.
 *   3. No eligible CG / KC: tick returns no-challenge.
 *   4. Already solved: tick returns already-solved.
 *   5. cgId == 0 (KC unregistered): tick returns cg-not-found.
 *   6. KC not synced locally (KCNotFoundError): tick returns kc-not-synced.
 *   7. ChallengeNoLongerActive on submit: tick returns submit-stale.
 *   8. Single-flight: concurrent ticks share one outcome.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ChallengeNoLongerActiveError,
  MerkleRootMismatchError,
  NoEligibleContextGraphError,
  NoEligibleKnowledgeCollectionError,
  type ChainAdapter,
  type CreateChallengeResult,
  type NodeChallenge,
  type ProofPeriodStatus,
  type TxResult,
} from '@origintrail-official/dkg-chain';
import {
  V10MerkleTree,
  contextGraphCatalogUri,
  contextGraphDataUri,
  contextGraphMetaUri,
  hashTripleV10,
  structuredKARootV10,
  tripleContentV10,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  createRandomSamplingRepairOperation,
  InMemoryProverWal,
  RandomSamplingProver,
  startProverLoop,
  type RandomSamplingRepairMaterial,
} from '../src/index.js';

const DKG = 'http://dkg.io/ontology/';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

interface FakeChainState {
  status: ProofPeriodStatus;
  challengeForNode: NodeChallenge | null;
  createChallenge: () => Promise<CreateChallengeResult>;
  expectedRoot: Uint8Array;
  expectedLeafCount: number;
  cgIdForKc: bigint;
  submitProof: (leaf: Uint8Array, proof: Uint8Array[]) => Promise<TxResult>;
  /** When set, exposes `chain.getBlockNumber` so the wall-clock stale
   *  check inside the prover engages. Tests that omit this fall back
   *  to "stale check always false" (the production-safe default). */
  blockNumber?: number;
}

function makeChain(state: FakeChainState): ChainAdapter {
  // OT-RFC-49 WS-B proof-race snapshot: the on-chain `createChallenge` PINS the
  // current (root, leafCount) onto the Challenge struct, and `submitProof` (and
  // the prover) verify against THOSE pinned values, not a live re-read. Mirror
  // that here — pin the snapshot from the chain's reported (root, leafCount)
  // onto any surfaced challenge that doesn't already carry it. Without this the
  // prover reads `challenge.challengeRoot`/`challengeLeafCount` as undefined and
  // every build fails `leaf-count-mismatch`.
  const pin = (ch: NodeChallenge | null): NodeChallenge | null =>
    ch === null
      ? null
      : {
          ...ch,
          challengeRoot: ch.challengeRoot ?? state.expectedRoot,
          challengeLeafCount:
            ch.challengeLeafCount ?? BigInt(state.expectedLeafCount),
        };
  // Only the methods the prover touches need to be implemented.
  const partial: Partial<ChainAdapter> = {
    chainType: 'evm',
    chainId: '31337',
    getActiveProofPeriodStatus: vi.fn(async () => state.status),
    getNodeChallenge: vi.fn(async () => pin(state.challengeForNode)),
    createChallenge: vi.fn(async () => {
      const r = await state.createChallenge();
      return { ...r, challenge: pin(r.challenge)! };
    }),
    getLatestMerkleRoot: vi.fn(async () => state.expectedRoot),
    getMerkleLeafCount: vi.fn(async () => state.expectedLeafCount),
    getKAContextGraphId: vi.fn(async () => state.cgIdForKc),
    submitProof: vi.fn(state.submitProof),
  };
  if (state.blockNumber !== undefined) {
    partial.getBlockNumber = vi.fn(async () => state.blockNumber!);
  }
  return partial as ChainAdapter;
}

interface KCFixture {
  cgId: bigint;
  kaId: bigint;
  ual: string;
  rootEntities: string[];
  publicTriples: { subject: string; predicate: string; object: string }[];
}

async function seedKCMetadata(store: OxigraphStore, fixture: KCFixture): Promise<void> {
  const cgIdStr = fixture.cgId.toString();
  // Mirror the agent's CG name → on-chain id mapping the extractor
  // looks up. `cg-<n>` is a synthetic name; in production the name is
  // human-chosen (e.g. "devnet-test"), but the URI shape is identical.
  const cgName = `cg-${cgIdStr}`;
  await store.insert([
    {
      subject: `did:dkg:context-graph:${cgName}`,
      predicate: 'https://dkg.network/ontology#ContextGraphOnChainId',
      object: `"${cgIdStr}"`,
      graph: 'did:dkg:context-graph:ontology',
    },
  ]);
  const metaGraph = contextGraphMetaUri(cgName, cgIdStr);

  const metaQuads: Quad[] = [
    { subject: fixture.ual, predicate: `${DKG}batchId`, object: `"${fixture.kaId}"^^<${XSD}integer>`, graph: metaGraph },
  ];
  for (let i = 0; i < fixture.rootEntities.length; i++) {
    const kaUri = `${fixture.ual}/${i + 1}`;
    metaQuads.push(
      { subject: kaUri, predicate: `${DKG}partOf`, object: fixture.ual, graph: metaGraph },
      { subject: kaUri, predicate: `${DKG}rootEntity`, object: fixture.rootEntities[i], graph: metaGraph },
    );
  }
  await store.insert(metaQuads);
}

async function seedKC(store: OxigraphStore, fixture: KCFixture): Promise<{ root: Uint8Array; leafCount: number }> {
  await seedKCMetadata(store, fixture);
  const cgIdStr = fixture.cgId.toString();
  const cgName = `cg-${cgIdStr}`;
  const dataGraph = contextGraphDataUri(cgName, cgIdStr);
  await store.insert(fixture.publicTriples.map((t) => ({ ...t, graph: dataGraph })));

  // PUBLIC path is structured: hashPair(publicRoot, privateDataHash). The fixture
  // seeds no private data, so the prover extracts privateRoots=[] -> sentinel sibling.
  const leaves = fixture.publicTriples.map((t) => hashTripleV10(t.subject, t.predicate, t.object));
  const { root, leafCount } = structuredKARootV10(leaves, []);
  return { root, leafCount };
}

/**
 * Seed the PUBLIC `_catalog` named graph for a curated CG (OT-RFC-49 WS-C).
 * The graph URI is keyed by the NUMERIC on-chain id (no name mapping), exactly
 * what `extractCatalogLeavesFromStore` reads back. Returns the committed
 * (root, leafCount) the prover must rebuild to satisfy the builder guard.
 */
async function seedCatalog(
  store: OxigraphStore,
  cgId: bigint,
  triples: { subject: string; predicate: string; object: string }[],
): Promise<{ root: Uint8Array; leafCount: number }> {
  const catalogGraph = contextGraphCatalogUri(String(cgId));
  await store.insert(triples.map((t) => ({ ...t, graph: catalogGraph })));
  const leaves = triples.map((t) =>
    hashTripleV10(t.subject, t.predicate, t.object),
  );
  const tree = new V10MerkleTree(leaves);
  return { root: tree.root, leafCount: tree.leafCount };
}

const IDENTITY_ID = 42n;

function makeChallenge(overrides: Partial<NodeChallenge> = {}): NodeChallenge {
  return {
    knowledgeAssetId: 7n,
    chunkId: 0n,
    knowledgeAssetStorageContract: '0x0',
    epoch: 1n,
    activeProofPeriodStartBlock: 1000n,
    proofingPeriodDurationInBlocks: 50n,
    solved: false,
    isCurated: false,
    ...overrides,
  };
}

describe('RandomSamplingProver — happy path', () => {
  let store: OxigraphStore;
  beforeEach(() => {
    store = new OxigraphStore();
  });

  it('tick: extracts, builds, submits, and WAL records every transition', async () => {
    const fixture: KCFixture = {
      cgId: 11n,
      kaId: 7n,
      ual: 'did:dkg:hardhat:31337/0xpub/7',
      rootEntities: ['urn:e:1', 'urn:e:2', 'urn:e:3'],
      publicTriples: [
        { subject: 'urn:e:1', predicate: 'urn:p:k', object: '"a"' },
        { subject: 'urn:e:2', predicate: 'urn:p:k', object: '"b"' },
        { subject: 'urn:e:3', predicate: 'urn:p:k', object: '"c"' },
      ],
    };
    const { root, leafCount } = await seedKC(store, fixture);

    const submitProof = vi.fn(async () => ({ hash: '0xabc123', blockNumber: 1001, success: true }));
    const challenge = makeChallenge({
      knowledgeAssetId: fixture.kaId,
      chunkId: 1n,
    });
    const chain = makeChain({
      status: { activeProofPeriodStartBlock: 1000n, isValid: true },
      challengeForNode: null,
      createChallenge: async () => ({
        challenge,
        contextGraphId: fixture.cgId,
        hash: '0xchallenge',
        blockNumber: 1000,
        success: true,
      }),
      expectedRoot: root,
      expectedLeafCount: leafCount,
      cgIdForKc: fixture.cgId,
      submitProof,
    });

    const wal = new InMemoryProverWal();
    const prover = new RandomSamplingProver({ chain, store, identityId: IDENTITY_ID, wal });
    const outcome = await prover.tick();

    expect(outcome).toEqual({
      kind: 'submitted',
      txHash: '0xabc123',
      kaId: fixture.kaId,
      cgId: fixture.cgId,
      chunkId: 1n,
    });
    expect(submitProof).toHaveBeenCalledTimes(1);

    const trail = (await wal.readAll()).map((e) => e.status);
    expect(trail).toEqual(['challenge', 'extracted', 'built', 'submitted']);
    await prover.close();
  });
});

describe('RandomSamplingProver — mid-period update (content pinning)', () => {
  let store: OxigraphStore;
  beforeEach(() => {
    store = new OxigraphStore();
  });

  it('reuses the proof it already verified when an update flips the live root before a submit retry', async () => {
    // #1716: the challenge pins root/leaf-count at issuance, but the CONTENT
    // was re-read live on every retry. First tick builds a valid proof against
    // the pinned root, then the submit fails transiently. A mid-period UPDATE
    // then changes the sampled KA's content (new live root). Without the
    // content pin, the retry re-extracts, fails root-mismatch, and misses an
    // honest proof. With it, the retry reuses the already-verified material.
    const fixture: KCFixture = {
      cgId: 11n,
      kaId: 7n,
      ual: 'did:dkg:hardhat:31337/0xpub/7',
      rootEntities: ['urn:e:1', 'urn:e:2', 'urn:e:3'],
      publicTriples: [
        { subject: 'urn:e:1', predicate: 'urn:p:k', object: '"a"' },
        { subject: 'urn:e:2', predicate: 'urn:p:k', object: '"b"' },
        { subject: 'urn:e:3', predicate: 'urn:p:k', object: '"c"' },
      ],
    };
    const { root, leafCount } = await seedKC(store, fixture);
    const dataGraph = contextGraphDataUri(`cg-${fixture.cgId}`, fixture.cgId.toString());

    let submitCalls = 0;
    const submitProof = vi.fn(async (
      _content: Uint8Array,
      _proof: Uint8Array[],
    ) => {
      submitCalls += 1;
      if (submitCalls === 1) throw new Error('transient submit failure');
      return { hash: '0xretry', blockNumber: 1002, success: true };
    });
    const challenge = makeChallenge({
      knowledgeAssetId: fixture.kaId,
      chunkId: 1n,
      challengeRoot: root,
      challengeLeafCount: BigInt(leafCount),
      activeProofPeriodStartBlock: 1000n,
      solved: false,
    });
    const chain = makeChain({
      status: { activeProofPeriodStartBlock: 1000n, isValid: true },
      challengeForNode: challenge,
      createChallenge: async () => ({
        challenge,
        contextGraphId: fixture.cgId,
        hash: '0xchallenge',
        blockNumber: 1000,
        success: true,
      }),
      expectedRoot: root,
      expectedLeafCount: leafCount,
      cgIdForKc: fixture.cgId,
      submitProof,
    });
    const prover = new RandomSamplingProver({ chain, store, identityId: IDENTITY_ID });

    // Tick 1: builds + verifies the proof (pins it), then the submit throws.
    await expect(prover.tick()).rejects.toThrow('transient submit failure');
    expect(submitProof).toHaveBeenCalledTimes(1);

    // A mid-period UPDATE mutates the sampled KA's content → new live root,
    // while the on-chain challenge stays pinned to the original root.
    await store.delete([
      { subject: 'urn:e:1', predicate: 'urn:p:k', object: '"a"', graph: dataGraph },
    ]);
    await store.insert([
      { subject: 'urn:e:1', predicate: 'urn:p:k', object: '"MUTATED"', graph: dataGraph },
    ]);

    // Tick 2: a fresh extract no longer matches the pinned root, but the prover
    // submits the material it already verified this period instead of missing.
    const outcome = await prover.tick();
    expect(outcome).toMatchObject({ kind: 'submitted', txHash: '0xretry' });
    expect(submitProof).toHaveBeenCalledTimes(2);
    const [firstContent, firstProof] = submitProof.mock.calls[0]!;
    const [retryContent, retryProof] = submitProof.mock.calls[1]!;
    expect(retryContent).toEqual(firstContent);
    expect(retryProof).toEqual(firstProof);
    expect(new TextDecoder().decode(retryContent)).not.toContain('MUTATED');
    await prover.close();
  });

  it('does not reuse material after the chain deterministically rejects it', async () => {
    const fixture: KCFixture = {
      cgId: 12n,
      kaId: 8n,
      ual: 'did:dkg:hardhat:31337/0xpub/8',
      rootEntities: ['urn:e:1', 'urn:e:2', 'urn:e:3'],
      publicTriples: [
        { subject: 'urn:e:1', predicate: 'urn:p:k', object: '"a"' },
        { subject: 'urn:e:2', predicate: 'urn:p:k', object: '"b"' },
        { subject: 'urn:e:3', predicate: 'urn:p:k', object: '"c"' },
      ],
    };
    const { root, leafCount } = await seedKC(store, fixture);
    const dataGraph = contextGraphDataUri(`cg-${fixture.cgId}`, fixture.cgId.toString());
    const submitProof = vi.fn(async (
      _content: Uint8Array,
      _proof: Uint8Array[],
    ) => {
      throw new MerkleRootMismatchError('0xbad', '0xexpected');
    });
    const challenge = makeChallenge({
      knowledgeAssetId: fixture.kaId,
      chunkId: 1n,
      challengeRoot: root,
      challengeLeafCount: BigInt(leafCount),
      activeProofPeriodStartBlock: 1000n,
      solved: false,
    });
    const chain = makeChain({
      status: { activeProofPeriodStartBlock: 1000n, isValid: true },
      challengeForNode: challenge,
      createChallenge: async () => ({
        challenge,
        contextGraphId: fixture.cgId,
        hash: '0xchallenge',
        blockNumber: 1000,
        success: true,
      }),
      expectedRoot: root,
      expectedLeafCount: leafCount,
      cgIdForKc: fixture.cgId,
      submitProof,
    });
    const prover = new RandomSamplingProver({ chain, store, identityId: IDENTITY_ID });

    await expect(prover.tick()).resolves.toMatchObject({
      kind: 'data-corrupted',
      reason: 'root-mismatch',
    });
    await store.delete([
      { subject: 'urn:e:1', predicate: 'urn:p:k', object: '"a"', graph: dataGraph },
    ]);
    await store.insert([
      { subject: 'urn:e:1', predicate: 'urn:p:k', object: '"MUTATED"', graph: dataGraph },
    ]);

    await expect(prover.tick()).resolves.toMatchObject({
      kind: 'data-corrupted',
      reason: 'root-mismatch',
    });
    expect(submitProof).toHaveBeenCalledTimes(1);
    await prover.close();
  });
});

describe('RandomSamplingProver — curated catalog (OT-RFC-49 WS-C)', () => {
  let store: OxigraphStore;
  beforeEach(() => {
    store = new OxigraphStore();
  });

  it('tick: a curated CG proves the PUBLIC _catalog (extracts catalog, builds flat-kc, submits)', async () => {
    const cgId = 11n;
    const kaId = 7n;
    // Plaintext public catalog floor triples; none use DKG_COMMITTED_ROOT, so
    // all survive the catalogCommittedLeaves filter and form the committed set.
    const catalogTriples = [
      { subject: 'did:dkg:context-graph:11', predicate: 'urn:p:floor', object: '"catalog-a"' },
      { subject: 'did:dkg:context-graph:11', predicate: 'urn:p:floor', object: '"catalog-b"' },
      { subject: 'did:dkg:context-graph:11', predicate: 'urn:p:floor', object: '"catalog-c"' },
    ];
    const { root, leafCount } = await seedCatalog(store, cgId, catalogTriples);

    const submitProof = vi.fn(async () => ({
      hash: '0xcat123',
      blockNumber: 1001,
      success: true,
    }));
    // isCurated + the PINNED (challengeRoot, challengeLeafCount) snapshot the
    // curated branch proves against (WS-B Trap 1), set to the catalog commitment.
    const challenge = makeChallenge({
      knowledgeAssetId: kaId,
      chunkId: 1n,
      isCurated: true,
      challengeRoot: root,
      challengeLeafCount: BigInt(leafCount),
    });
    const chain = makeChain({
      status: { activeProofPeriodStartBlock: 1000n, isValid: true },
      challengeForNode: null,
      createChallenge: async () => ({
        challenge,
        contextGraphId: cgId,
        hash: '0xchallenge',
        blockNumber: 1000,
        success: true,
      }),
      expectedRoot: root,
      expectedLeafCount: leafCount,
      cgIdForKc: cgId,
      submitProof,
    });

    const wal = new InMemoryProverWal();
    const prover = new RandomSamplingProver({
      chain,
      store,
      identityId: IDENTITY_ID,
      wal,
    });
    const outcome = await prover.tick();

    expect(outcome).toEqual({
      kind: 'submitted',
      txHash: '0xcat123',
      kaId,
      cgId,
      chunkId: 1n,
    });
    expect(submitProof).toHaveBeenCalledTimes(1);
    // Same transition trail as the public flat-kc path — confirms the curated
    // dispatch reaches build + submit, not a short-circuit.
    const trail = (await wal.readAll()).map((e) => e.status);
    expect(trail).toEqual(['challenge', 'extracted', 'built', 'submitted']);
    await prover.close();
  });

  it('tick: a curated CG whose _catalog has not synced returns kc-not-synced (no submit)', async () => {
    const cgId = 12n;
    const kaId = 8n;
    // No catalog seeded → extractCatalogLeavesFromStore throws
    // CatalogLeavesMissingError → mapped to the kc-not-synced skip.
    const submitProof = vi.fn(async () => ({
      hash: '0xno',
      blockNumber: 1,
      success: true,
    }));
    const challenge = makeChallenge({
      knowledgeAssetId: kaId,
      chunkId: 1n,
      isCurated: true,
      challengeRoot: new Uint8Array(32),
      challengeLeafCount: 0n,
    });
    const chain = makeChain({
      status: { activeProofPeriodStartBlock: 1000n, isValid: true },
      challengeForNode: null,
      createChallenge: async () => ({
        challenge,
        contextGraphId: cgId,
        hash: '0xc',
        blockNumber: 1000,
        success: true,
      }),
      expectedRoot: new Uint8Array(32),
      expectedLeafCount: 0,
      cgIdForKc: cgId,
      submitProof,
    });

    const wal = new InMemoryProverWal();
    const prover = new RandomSamplingProver({
      chain,
      store,
      identityId: IDENTITY_ID,
      wal,
    });
    const outcome = await prover.tick();

    expect(outcome).toEqual({ kind: 'kc-not-synced', kaId, cgId });
    expect(submitProof).not.toHaveBeenCalled();
    await prover.close();
  });
});

describe('RandomSamplingProver — short-circuits', () => {
  let store: OxigraphStore;
  beforeEach(() => { store = new OxigraphStore(); });

  it('does NOT short-circuit when isValid is false — falls through to createChallenge', async () => {
    // View-side `isValid: false` was previously a terminal short-circuit.
    // That stalled single-tenant deployments because no external tx ever
    // rotated the period. The prover now ignores `isValid` and trusts the
    // on-chain auto-rotation that happens inside `createChallenge`.
    const createChallenge = vi.fn(async () => {
      throw new NoEligibleContextGraphError();
    });
    const chain = makeChain({
      status: { activeProofPeriodStartBlock: 0n, isValid: false },
      challengeForNode: null,
      createChallenge: createChallenge as never,
      expectedRoot: new Uint8Array(32),
      expectedLeafCount: 0,
      cgIdForKc: 0n,
      submitProof: vi.fn() as never,
    });
    const prover = new RandomSamplingProver({ chain, store, identityId: IDENTITY_ID });
    const outcome = await prover.tick();
    // The chain reports no eligible CG, but the prover still tried —
    // that's the contract: `isValid: false` is non-terminal.
    expect(outcome).toEqual({ kind: 'no-challenge', reason: 'no-eligible-cg' });
    expect(createChallenge).toHaveBeenCalledTimes(1);
    await prover.close();
  });

  it('discards a stale existing challenge (different period start block) and creates a fresh one', async () => {
    // Existing challenge is from period 500, status reports current
    // period 1000. The prover must not try to submit against the
    // stale challenge — it'd revert with ChallengeNoLongerActive
    // and burn gas. Instead, force a rotation via createChallenge.
    const fixture: KCFixture = {
      cgId: 11n, kaId: 7n, ual: 'did:dkg:hardhat:31337/0xpub/7',
      rootEntities: ['urn:e:1'],
      publicTriples: [{ subject: 'urn:e:1', predicate: 'urn:p:k', object: '"a"' }],
    };
    const { root, leafCount } = await seedKC(store, fixture);

    const submitProof = vi.fn(async () => ({ hash: '0xfresh', blockNumber: 1, success: true }));
    const createChallenge = vi.fn(async () => ({
      challenge: makeChallenge({
        knowledgeAssetId: fixture.kaId,
        chunkId: 0n,
        activeProofPeriodStartBlock: 1000n, // current period
      }),
      contextGraphId: fixture.cgId,
      hash: '0x', blockNumber: 1, success: true,
    }));
    const chain = makeChain({
      status: { activeProofPeriodStartBlock: 1000n, isValid: true },
      challengeForNode: makeChallenge({
        knowledgeAssetId: fixture.kaId,
        activeProofPeriodStartBlock: 500n, // STALE — previous period
      }),
      createChallenge,
      expectedRoot: root,
      expectedLeafCount: leafCount,
      cgIdForKc: fixture.cgId,
      submitProof: submitProof as never,
    });
    const prover = new RandomSamplingProver({ chain, store, identityId: IDENTITY_ID });
    const outcome = await prover.tick();
    expect(outcome.kind).toBe('submitted');
    expect(createChallenge).toHaveBeenCalledTimes(1); // forced fresh
    expect(submitProof).toHaveBeenCalledTimes(1);
    await prover.close();
  });

  it('forces createChallenge when existing unsolved challenge is past its on-chain period boundary by wall-clock', async () => {
    // Reproduces the Base Sepolia testnet deadlock from 2026-05-01:
    // After an RS-contract Hub rotation, every staked node held an
    // unsolved challenge for proof period P. With no submit/create
    // tx landing post-rotation, the contract's
    // `activeProofPeriodStartBlock` cursor stayed frozen at P, so
    // `existing.activeProofPeriodStartBlock === status.activeProofPeriodStartBlock`
    // remained true forever and the prover happily reused the
    // unsolvable stale challenge on every tick (kc-not-synced loop)
    // — never calling createChallenge to advance the period.
    //
    // Fix: mirror the wall-clock stale check that already protected
    // the solved branch. If wallclock is past the cached period's
    // boundary, force a rotation regardless of solved/unsolved.
    //
    // Codex round 1: the rotated challenge from createChallenge must
    // sit in a DIFFERENT period than the frozen cached one — otherwise
    // the test only proves createChallenge was called, not that the
    // prover actually consumed the rotated challenge downstream.
    //
    // Codex round 2: the fixture must also stay consistent with real
    // contract invariants. With the cached cursor at FROZEN_PERIOD and
    // the wall-clock at CURRENT_BLOCK far past the period boundary:
    //   - getActiveProofPeriodStatus() would report isValid: false
    //     because block.number > FROZEN_PERIOD + duration (the prover
    //     deliberately ignores isValid — see tickImpl L185–191 — so
    //     this is the regime we model)
    //   - createChallenge()'s internal updateAndGetActiveProofPeriodStartBlock
    //     advances by `completePeriodsPassed * duration`, which lands
    //     ROTATED_PERIOD at exactly CURRENT_BLOCK (or earlier), never
    //     after it. So ROTATED_PERIOD = FROZEN + N*duration <= CURRENT_BLOCK.
    //
    // Concrete numbers:
    //   FROZEN_PERIOD = 1000n, DURATION = 50n, CURRENT_BLOCK = 9000n
    //   periodsPassed = (9000-1000)/50 = 160
    //   ROTATED_PERIOD = 1000 + 160*50 = 9000 (lands at CURRENT_BLOCK)
    const fixture: KCFixture = {
      cgId: 11n, kaId: 7n, ual: 'did:dkg:hardhat:31337/0xpub/7',
      rootEntities: ['urn:e:1'],
      publicTriples: [{ subject: 'urn:e:1', predicate: 'urn:p:k', object: '"a"' }],
    };
    const { root, leafCount } = await seedKC(store, fixture);

    const FROZEN_PERIOD = 1000n;
    const DURATION = 50n;
    const CURRENT_BLOCK = 9000;
    const ROTATED_PERIOD =
      FROZEN_PERIOD
      + BigInt(Math.floor((CURRENT_BLOCK - Number(FROZEN_PERIOD)) / Number(DURATION)))
        * DURATION;
    // Sanity-pin the on-chain math at fixture authoring time so future
    // edits to FROZEN_PERIOD/DURATION/CURRENT_BLOCK can't silently drift
    // ROTATED_PERIOD into a value the contract could not actually return.
    expect(ROTATED_PERIOD).toBe(9000n);
    const ROTATED_EPOCH = 18n;

    const submitProof = vi.fn(async () => ({ hash: '0xfresh', blockNumber: CURRENT_BLOCK, success: true }));
    const createChallenge = vi.fn(async () => ({
      challenge: makeChallenge({
        knowledgeAssetId: fixture.kaId,
        chunkId: 0n,
        epoch: ROTATED_EPOCH,
        activeProofPeriodStartBlock: ROTATED_PERIOD,
        proofingPeriodDurationInBlocks: DURATION,
      }),
      contextGraphId: fixture.cgId,
      hash: '0x', blockNumber: CURRENT_BLOCK, success: true,
    }));
    const chain = makeChain({
      // The cached challenge's period == the on-chain status cursor
      // (both frozen at FROZEN_PERIOD), so `existingIsCurrent` is true.
      // status.isValid is FALSE because real contract sets it to
      // `block.number < activeProofPeriodStartBlock + duration` — at
      // CURRENT_BLOCK well past the frozen boundary that's necessarily
      // false. The prover ignores isValid and relies on the wall-clock
      // check instead, which is exactly what this regression covers.
      status: {
        activeProofPeriodStartBlock: FROZEN_PERIOD,
        isValid: false,
        proofingPeriodDurationInBlocks: DURATION,
      },
      challengeForNode: makeChallenge({
        knowledgeAssetId: fixture.kaId,
        activeProofPeriodStartBlock: FROZEN_PERIOD,
        proofingPeriodDurationInBlocks: DURATION,
        solved: false,
      }),
      blockNumber: CURRENT_BLOCK,
      createChallenge,
      expectedRoot: root,
      expectedLeafCount: leafCount,
      cgIdForKc: fixture.cgId,
      submitProof: submitProof as never,
    });
    const wal = new InMemoryProverWal();
    const prover = new RandomSamplingProver({ chain, store, identityId: IDENTITY_ID, wal });
    const outcome = await prover.tick();
    expect(outcome.kind).toBe('submitted');
    expect(createChallenge).toHaveBeenCalledTimes(1);
    expect(submitProof).toHaveBeenCalledTimes(1);

    // Codex round 1 fix — verify the prover actually advanced to the
    // rotated period. WAL entries written after `periodKey.periodStartBlock
    // = challenge.activeProofPeriodStartBlock` (prover.ts) all carry the
    // new period; if the prover had instead reused the frozen cached
    // challenge they'd carry FROZEN_PERIOD's string and this would fail.
    const trail = await wal.readAll();
    const submitted = trail.find((e) => e.status === 'submitted');
    expect(submitted).toBeDefined();
    expect(submitted!.periodStartBlock).toBe(ROTATED_PERIOD.toString());
    expect(submitted!.epoch).toBe(ROTATED_EPOCH.toString());
    expect(trail.map((e) => e.status)).toEqual(['challenge', 'extracted', 'built', 'submitted']);
    await prover.close();
  });

  it('uses live duration from status for staleness when governance shortens proofingPeriodDurationInBlocks mid-flight', async () => {
    // Codex round 2 on PR #369: `updateAndGetActiveProofPeriodStartBlock`
    // rolls forward using `getActiveProofingPeriodDurationInBlocks()`
    // for the current epoch — NOT the duration baked into the cached
    // `NodeChallenge` at creation time. If governance shortens that
    // duration after a challenge is cached, the on-chain expiry boundary
    // is closer than the cached duration would suggest. The prover must
    // prefer the live `status.proofingPeriodDurationInBlocks` over the
    // cached one, otherwise rotation regresses to "fires only once the
    // cached (longer) duration would have expired" — exactly the kind
    // of latent deadlock this fix is meant to prevent.
    const fixture: KCFixture = {
      cgId: 11n, kaId: 7n, ual: 'did:dkg:hardhat:31337/0xpub/7',
      rootEntities: ['urn:e:1'],
      publicTriples: [{ subject: 'urn:e:1', predicate: 'urn:p:k', object: '"a"' }],
    };
    const { root, leafCount } = await seedKC(store, fixture);

    const FROZEN_PERIOD = 1000n;
    // Cached duration is the LONG one (10000 blocks) baked into the
    // challenge before the governance change. Wall-clock at block 5000
    // would NOT be stale by this duration (1000 + 10000 = 11000 > 5000),
    // so a regression that uses the cached duration would happily reuse
    // the cached challenge and never call createChallenge → deadlock.
    const CACHED_DURATION = 10000n;
    // Live duration is the SHORT one (50 blocks) installed by governance.
    // Wall-clock at 5000 IS stale by this duration (1000 + 50 = 1050 < 5000),
    // so the prover must force rotation.
    const LIVE_DURATION = 50n;
    const CURRENT_BLOCK = 5000;
    // After rotation, the chain advances by `completePeriodsPassed * LIVE_DURATION`.
    // periodsPassed = (5000 - 1000) / 50 = 80 → ROTATED = 1000 + 80*50 = 5000.
    const ROTATED_PERIOD = 5000n;

    const submitProof = vi.fn(async () => ({ hash: '0xfresh', blockNumber: CURRENT_BLOCK, success: true }));
    const createChallenge = vi.fn(async () => ({
      challenge: makeChallenge({
        knowledgeAssetId: fixture.kaId,
        chunkId: 0n,
        epoch: 19n,
        activeProofPeriodStartBlock: ROTATED_PERIOD,
        proofingPeriodDurationInBlocks: LIVE_DURATION,
      }),
      contextGraphId: fixture.cgId,
      hash: '0x', blockNumber: CURRENT_BLOCK, success: true,
    }));
    const chain = makeChain({
      status: {
        activeProofPeriodStartBlock: FROZEN_PERIOD,
        isValid: false,
        proofingPeriodDurationInBlocks: LIVE_DURATION,
      },
      challengeForNode: makeChallenge({
        knowledgeAssetId: fixture.kaId,
        activeProofPeriodStartBlock: FROZEN_PERIOD,
        proofingPeriodDurationInBlocks: CACHED_DURATION,
        solved: false,
      }),
      blockNumber: CURRENT_BLOCK,
      createChallenge,
      expectedRoot: root,
      expectedLeafCount: leafCount,
      cgIdForKc: fixture.cgId,
      submitProof: submitProof as never,
    });
    const prover = new RandomSamplingProver({ chain, store, identityId: IDENTITY_ID });
    const outcome = await prover.tick();
    expect(outcome.kind).toBe('submitted');
    expect(createChallenge).toHaveBeenCalledTimes(1);
    expect(submitProof).toHaveBeenCalledTimes(1);
    await prover.close();
  });

  it('returns no-challenge / no-eligible-cg when createChallenge throws', async () => {
    const chain = makeChain({
      status: { activeProofPeriodStartBlock: 1000n, isValid: true },
      challengeForNode: null,
      createChallenge: async () => { throw new NoEligibleContextGraphError(); },
      expectedRoot: new Uint8Array(32),
      expectedLeafCount: 0,
      cgIdForKc: 0n,
      submitProof: vi.fn() as never,
    });
    const prover = new RandomSamplingProver({ chain, store, identityId: IDENTITY_ID });
    const outcome = await prover.tick();
    expect(outcome).toEqual({ kind: 'no-challenge', reason: 'no-eligible-cg' });
    await prover.close();
  });

  it('returns no-challenge / no-eligible-kc when createChallenge throws', async () => {
    const chain = makeChain({
      status: { activeProofPeriodStartBlock: 1000n, isValid: true },
      challengeForNode: null,
      createChallenge: async () => { throw new NoEligibleKnowledgeCollectionError(); },
      expectedRoot: new Uint8Array(32),
      expectedLeafCount: 0,
      cgIdForKc: 0n,
      submitProof: vi.fn() as never,
    });
    const prover = new RandomSamplingProver({ chain, store, identityId: IDENTITY_ID });
    const outcome = await prover.tick();
    expect(outcome).toEqual({ kind: 'no-challenge', reason: 'no-eligible-kc' });
    await prover.close();
  });

  it('returns already-solved when getNodeChallenge.solved is true', async () => {
    const submitProof = vi.fn();
    const chain = makeChain({
      status: { activeProofPeriodStartBlock: 1000n, isValid: true },
      challengeForNode: makeChallenge({ solved: true }),
      createChallenge: async () => { throw new Error('should not run'); },
      expectedRoot: new Uint8Array(32),
      expectedLeafCount: 0,
      cgIdForKc: 0n,
      submitProof: submitProof as never,
    });
    const prover = new RandomSamplingProver({ chain, store, identityId: IDENTITY_ID });
    expect(await prover.tick()).toEqual({ kind: 'already-solved' });
    expect(submitProof).not.toHaveBeenCalled();
    await prover.close();
  });

  it('forces createChallenge from the SOLVED branch when wallclock is past live duration (Codex round 4)', async () => {
    // Codex round 4 on PR #369 — round 2 made the solved branch
    // consume `status.proofingPeriodDurationInBlocks` for staleness too,
    // but only the unsolved branch had a wall-clock regression test.
    // Without symmetric solved-branch coverage, a regression that
    // reverts `isCachedChallengeStale` to ignoring the live duration
    // would re-introduce the post-submit deadlock (poll-after-success
    // while period actually rotated → short-circuit on `already-solved`
    // → never advance) without failing this suite.
    //
    // Setup: cached challenge is SOLVED at FROZEN_PERIOD with a
    // CACHED_DURATION that would say "still in period" at CURRENT_BLOCK
    // (cached: 1000+10000 > 5000), but the live duration says "expired"
    // (live: 1000+50 < 5000). The prover must consult the live duration
    // and force createChallenge.
    const fixture: KCFixture = {
      cgId: 11n, kaId: 7n, ual: 'did:dkg:hardhat:31337/0xpub/7',
      rootEntities: ['urn:e:1'],
      publicTriples: [{ subject: 'urn:e:1', predicate: 'urn:p:k', object: '"a"' }],
    };
    const { root, leafCount } = await seedKC(store, fixture);

    const FROZEN_PERIOD = 1000n;
    const CACHED_DURATION = 10000n;
    const LIVE_DURATION = 50n;
    const CURRENT_BLOCK = 5000;
    const ROTATED_PERIOD = 5000n;

    const submitProof = vi.fn(async () => ({ hash: '0xnext', blockNumber: CURRENT_BLOCK, success: true }));
    const createChallenge = vi.fn(async () => ({
      challenge: makeChallenge({
        knowledgeAssetId: fixture.kaId,
        chunkId: 0n,
        epoch: 19n,
        activeProofPeriodStartBlock: ROTATED_PERIOD,
        proofingPeriodDurationInBlocks: LIVE_DURATION,
        solved: false,
      }),
      contextGraphId: fixture.cgId,
      hash: '0x', blockNumber: CURRENT_BLOCK, success: true,
    }));
    const chain = makeChain({
      status: {
        activeProofPeriodStartBlock: FROZEN_PERIOD,
        isValid: false,
        proofingPeriodDurationInBlocks: LIVE_DURATION,
      },
      challengeForNode: makeChallenge({
        knowledgeAssetId: fixture.kaId,
        activeProofPeriodStartBlock: FROZEN_PERIOD,
        proofingPeriodDurationInBlocks: CACHED_DURATION,
        solved: true,
      }),
      blockNumber: CURRENT_BLOCK,
      createChallenge,
      expectedRoot: root,
      expectedLeafCount: leafCount,
      cgIdForKc: fixture.cgId,
      submitProof: submitProof as never,
    });
    const prover = new RandomSamplingProver({ chain, store, identityId: IDENTITY_ID });
    const outcome = await prover.tick();
    // Did NOT short-circuit on `already-solved`; the live-duration
    // wall-clock check fired and the prover rotated to the new period.
    expect(outcome.kind).toBe('submitted');
    expect(createChallenge).toHaveBeenCalledTimes(1);
    expect(submitProof).toHaveBeenCalledTimes(1);
    await prover.close();
  });

  it('falls back to existing.proofingPeriodDurationInBlocks when legacy adapter omits status.proofingPeriodDurationInBlocks (Codex round 5)', async () => {
    // ProofPeriodStatus.proofingPeriodDurationInBlocks is intentionally
    // optional — older EVM adapters (and any third-party ChainAdapter
    // implementations) MAY omit it. The prover's `live ?? cached`
    // fallback guarantees the wall-clock staleness check still works
    // in that case. Without explicit coverage, a regression that
    // makes `isCachedChallengeStale` *require* the live field would
    // re-deadlock against legacy adapters with no test failure.
    //
    // Setup: live duration is omitted from status; cached challenge
    // duration is short enough to be wall-clock-stale at CURRENT_BLOCK.
    // The prover MUST consult the cached duration, see the staleness,
    // and force createChallenge instead of reusing the unsolved cache.
    const fixture: KCFixture = {
      cgId: 12n, kaId: 8n, ual: 'did:dkg:hardhat:31337/0xpub/8',
      rootEntities: ['urn:e:1'],
      publicTriples: [{ subject: 'urn:e:1', predicate: 'urn:p:k', object: '"a"' }],
    };
    const { root, leafCount } = await seedKC(store, fixture);

    const FROZEN_PERIOD = 1000n;
    const CACHED_DURATION = 50n;
    const CURRENT_BLOCK = 5000;
    const ROTATED_PERIOD = 5000n;

    const submitProof = vi.fn(async () => ({ hash: '0xnext', blockNumber: CURRENT_BLOCK, success: true }));
    const createChallenge = vi.fn(async () => ({
      challenge: makeChallenge({
        knowledgeAssetId: fixture.kaId,
        chunkId: 0n,
        epoch: 21n,
        activeProofPeriodStartBlock: ROTATED_PERIOD,
        proofingPeriodDurationInBlocks: CACHED_DURATION,
        solved: false,
      }),
      contextGraphId: fixture.cgId,
      hash: '0x', blockNumber: CURRENT_BLOCK, success: true,
    }));
    const chain = makeChain({
      status: {
        activeProofPeriodStartBlock: FROZEN_PERIOD,
        isValid: false,
        // proofingPeriodDurationInBlocks intentionally omitted —
        // simulating a legacy adapter that hasn't been updated yet.
      },
      challengeForNode: makeChallenge({
        knowledgeAssetId: fixture.kaId,
        activeProofPeriodStartBlock: FROZEN_PERIOD,
        proofingPeriodDurationInBlocks: CACHED_DURATION,
        solved: false,
      }),
      blockNumber: CURRENT_BLOCK,
      createChallenge,
      expectedRoot: root,
      expectedLeafCount: leafCount,
      cgIdForKc: fixture.cgId,
      submitProof: submitProof as never,
    });
    const prover = new RandomSamplingProver({ chain, store, identityId: IDENTITY_ID });
    const outcome = await prover.tick();
    expect(outcome.kind).toBe('submitted');
    expect(createChallenge).toHaveBeenCalledTimes(1);
    expect(submitProof).toHaveBeenCalledTimes(1);
    await prover.close();
  });

  it('returns cg-not-found when getKAContextGraphId returns 0', async () => {
    const chain = makeChain({
      status: { activeProofPeriodStartBlock: 1000n, isValid: true },
      challengeForNode: null,
      createChallenge: async () => ({
        challenge: makeChallenge(),
        contextGraphId: 0n,
        hash: '0x', blockNumber: 1, success: true,
      }),
      expectedRoot: new Uint8Array(32),
      expectedLeafCount: 0,
      cgIdForKc: 0n,
      submitProof: vi.fn() as never,
    });
    const prover = new RandomSamplingProver({ chain, store, identityId: IDENTITY_ID });
    const outcome = await prover.tick();
    expect(outcome).toEqual({ kind: 'cg-not-found', kaId: 7n });
    await prover.close();
  });

  it('returns kc-not-synced when local _meta has no entry for kaId', async () => {
    // No KC seeded in the store; meta + data graphs are empty.
    const chain = makeChain({
      status: { activeProofPeriodStartBlock: 1000n, isValid: true },
      challengeForNode: null,
      createChallenge: async () => ({
        challenge: makeChallenge({ knowledgeAssetId: 999n }),
        contextGraphId: 11n,
        hash: '0x', blockNumber: 1, success: true,
      }),
      expectedRoot: new Uint8Array(32),
      expectedLeafCount: 0,
      cgIdForKc: 11n,
      submitProof: vi.fn() as never,
    });
    const prover = new RandomSamplingProver({ chain, store, identityId: IDENTITY_ID });
    const outcome = await prover.tick();
    expect(outcome).toMatchObject({ kind: 'kc-not-synced', kaId: 999n, cgId: 11n });
    await prover.close();
  });

  it('repairs a missing challenged KA once and submits in the same tick', async () => {
    const fixture: KCFixture = {
      cgId: 11n,
      kaId: 999n,
      ual: 'did:dkg:hardhat:31337/0x0000000000000000000000000000000000000001/999',
      rootEntities: ['urn:e:repair'],
      publicTriples: [
        { subject: 'urn:e:repair', predicate: 'urn:p:k', object: '"recovered"' },
      ],
    };
    const leaves = fixture.publicTriples.map((triple) =>
      hashTripleV10(triple.subject, triple.predicate, triple.object));
    const { root, leafCount } = structuredKARootV10(leaves, []);
    const submitProof = vi.fn(async () => ({
      hash: '0xrepaired', blockNumber: 1001, success: true,
    }));
    const chain = makeChain({
      status: { activeProofPeriodStartBlock: 1000n, isValid: true },
      challengeForNode: null,
      createChallenge: async () => ({
        challenge: makeChallenge({ knowledgeAssetId: fixture.kaId }),
        contextGraphId: fixture.cgId,
        hash: '0x', blockNumber: 1, success: true,
      }),
      expectedRoot: root,
      expectedLeafCount: leafCount,
      cgIdForKc: fixture.cgId,
      submitProof,
    });
    const repairMissingKnowledgeAsset = vi.fn(() =>
      createRandomSamplingRepairOperation(async () => ({
        contents: fixture.publicTriples.map((triple) => tripleContentV10(
          triple.subject,
          triple.predicate,
          triple.object,
        )),
        privateRoots: [],
      })));
    const wal = new InMemoryProverWal();
    const prover = new RandomSamplingProver({
      chain,
      store,
      identityId: IDENTITY_ID,
      wal,
      repairMissingKnowledgeAsset,
    });

    const outcome = await prover.tick();

    expect(repairMissingKnowledgeAsset).toHaveBeenCalledOnce();
    expect(repairMissingKnowledgeAsset).toHaveBeenCalledWith({
      kaId: fixture.kaId,
      cgId: fixture.cgId,
      expectedRoot: root,
      expectedLeafCount: BigInt(leafCount),
    });
    expect(outcome).toMatchObject({
      kind: 'submitted',
      txHash: '0xrepaired',
      kaId: fixture.kaId,
      cgId: fixture.cgId,
    });
    expect((await wal.readAll()).map((entry) => entry.status)).toEqual([
      'challenge', 'extracted', 'built', 'submitted',
    ]);
    await prover.close();
  });

  it('aborts and drains a stalled repair before closing prover resources', async () => {
    const fixture = { cgId: 11n, kaId: 999n };
    const submitProof = vi.fn(async () => ({
      hash: '0xshould-not-submit', blockNumber: 1001, success: true,
    }));
    const chain = makeChain({
      status: { activeProofPeriodStartBlock: 1000n, isValid: true },
      challengeForNode: null,
      createChallenge: async () => ({
        challenge: makeChallenge({ knowledgeAssetId: fixture.kaId }),
        contextGraphId: fixture.cgId,
        hash: '0x', blockNumber: 1, success: true,
      }),
      expectedRoot: new Uint8Array(32),
      expectedLeafCount: 1,
      cgIdForKc: fixture.cgId,
      submitProof,
    });
    let repairStarted!: () => void;
    const started = new Promise<void>((resolve) => { repairStarted = resolve; });
    let repairSignal: AbortSignal | undefined;
    let repairSettled = false;
    const repairMissingKnowledgeAsset = vi.fn(() =>
      createRandomSamplingRepairOperation((signal) => {
        repairSignal = signal;
        repairStarted();
        return new Promise<never>((_resolve, reject) => {
          const rejectOnAbort = () => {
            repairSettled = true;
            reject(signal.reason);
          };
          if (signal.aborted) rejectOnAbort();
          else signal.addEventListener('abort', rejectOnAbort, { once: true });
        });
      }));
    const build = vi.fn();
    const closeBuilder = vi.fn(async () => {
      expect(repairSettled).toBe(true);
    });
    const onTick = vi.fn();
    const prover = new RandomSamplingProver({
      chain,
      store,
      identityId: IDENTITY_ID,
      repairMissingKnowledgeAsset,
      builder: { build, close: closeBuilder },
    });
    const loop = startProverLoop({ prover, intervalMs: 60_000, onTick });
    loop.start();
    await started;

    await loop.stop();

    expect(repairSignal?.aborted).toBe(true);
    expect(onTick).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'error',
      error: expect.objectContaining({ name: 'AbortError' }),
    }));
    expect(build).not.toHaveBeenCalled();
    expect(submitProof).not.toHaveBeenCalled();
    expect(closeBuilder).toHaveBeenCalledOnce();
  });

  it('keeps close pending until an abort-ignoring repair physically settles', async () => {
    const fixture = { cgId: 11n, kaId: 999n };
    const submitProof = vi.fn(async () => ({
      hash: '0xshould-not-submit', blockNumber: 1001, success: true,
    }));
    const chain = makeChain({
      status: { activeProofPeriodStartBlock: 1000n, isValid: true },
      challengeForNode: null,
      createChallenge: async () => ({
        challenge: makeChallenge({ knowledgeAssetId: fixture.kaId }),
        contextGraphId: fixture.cgId,
        hash: '0x', blockNumber: 1, success: true,
      }),
      expectedRoot: new Uint8Array(32),
      expectedLeafCount: 1,
      cgIdForKc: fixture.cgId,
      submitProof,
    });
    let repairStarted!: () => void;
    const started = new Promise<void>((resolve) => { repairStarted = resolve; });
    let settleRepair!: (material: RandomSamplingRepairMaterial) => void;
    let repairSignal: AbortSignal | undefined;
    const repairMissingKnowledgeAsset = vi.fn(() =>
      createRandomSamplingRepairOperation((signal) => {
        repairSignal = signal;
        repairStarted();
        return new Promise<RandomSamplingRepairMaterial>((resolve) => {
          settleRepair = resolve;
        });
      }));
    const build = vi.fn();
    const closeBuilder = vi.fn(async () => undefined);
    const onTick = vi.fn();
    const prover = new RandomSamplingProver({
      chain,
      store,
      identityId: IDENTITY_ID,
      repairMissingKnowledgeAsset,
      builder: { build, close: closeBuilder },
    });
    const loop = startProverLoop({ prover, intervalMs: 60_000, onTick });
    loop.start();
    await started;

    const stopping = loop.stop();
    await vi.waitFor(() => expect(repairSignal?.aborted).toBe(true));
    await expect(Promise.race([
      stopping.then(() => 'stopped'),
      new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 20)),
    ])).resolves.toBe('pending');
    expect(closeBuilder).not.toHaveBeenCalled();

    settleRepair({ contents: [], privateRoots: [] });
    await expect(stopping).resolves.toBeUndefined();
    expect(onTick).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'error',
      error: expect.objectContaining({ name: 'AbortError' }),
    }));
    expect(build).not.toHaveBeenCalled();
    expect(submitProof).not.toHaveBeenCalled();
    expect(closeBuilder).toHaveBeenCalledOnce();
  });

  it('proves an older pinned challenge ephemerally without downgrading live v2 state', async () => {
    const fixture: KCFixture = {
      cgId: 11n,
      kaId: 999n,
      ual: 'did:dkg:hardhat:31337/0x0000000000000000000000000000000000000001/999',
      rootEntities: ['urn:e:historical'],
      publicTriples: [
        { subject: 'urn:e:historical', predicate: 'urn:p:version', object: '"v2"' },
      ],
    };
    await seedKC(store, fixture);
    const historical = {
      subject: 'urn:e:historical',
      predicate: 'urn:p:version',
      object: '"v1"',
    };
    const historicalContents = [tripleContentV10(
      historical.subject,
      historical.predicate,
      historical.object,
    )];
    const { root, leafCount } = structuredKARootV10(
      [hashTripleV10(historical.subject, historical.predicate, historical.object)],
      [],
    );
    const submitProof = vi.fn(async () => ({
      hash: '0xhistorical', blockNumber: 1001, success: true,
    }));
    const chain = makeChain({
      status: { activeProofPeriodStartBlock: 1000n, isValid: true },
      challengeForNode: null,
      createChallenge: async () => ({
        challenge: makeChallenge({ knowledgeAssetId: fixture.kaId }),
        contextGraphId: fixture.cgId,
        hash: '0x', blockNumber: 1, success: true,
      }),
      expectedRoot: root,
      expectedLeafCount: leafCount,
      cgIdForKc: fixture.cgId,
      submitProof,
    });
    const repairMissingKnowledgeAsset = vi.fn(() =>
      createRandomSamplingRepairOperation(async () => ({
        contents: historicalContents,
        privateRoots: [],
      })));
    const prover = new RandomSamplingProver({
      chain,
      store,
      identityId: IDENTITY_ID,
      repairMissingKnowledgeAsset,
    });

    await expect(prover.tick()).resolves.toMatchObject({
      kind: 'submitted',
      txHash: '0xhistorical',
    });
    expect(repairMissingKnowledgeAsset).toHaveBeenCalledOnce();
    const liveGraph = contextGraphDataUri(`cg-${fixture.cgId}`, fixture.cgId.toString());
    await expect(store.query(`ASK { GRAPH <${liveGraph}> {
      <urn:e:historical> <urn:p:version> "v2" .
    } }`)).resolves.toEqual({ type: 'boolean', value: true });
    await expect(store.query(`ASK { GRAPH <${liveGraph}> {
      <urn:e:historical> <urn:p:version> "v1" .
    } }`)).resolves.toEqual({ type: 'boolean', value: false });
    await prover.close();
  });

  it('keeps a missing local asset unsynced when the explicit repair result rejects', async () => {
    const fixture: KCFixture = {
      cgId: 11n,
      kaId: 999n,
      ual: 'did:dkg:hardhat:31337/0x0000000000000000000000000000000000000001/999',
      rootEntities: ['urn:e:repair-progress'],
      publicTriples: [
        { subject: 'urn:e:repair-progress', predicate: 'urn:p:k', object: '"recovered"' },
      ],
    };
    const { root, leafCount } = structuredKARootV10(
      fixture.publicTriples.map((triple) =>
        hashTripleV10(triple.subject, triple.predicate, triple.object)),
      [],
    );
    const submitProof = vi.fn(async () => ({
      hash: '0xpartial-progress', blockNumber: 1001, success: true,
    }));
    const chain = makeChain({
      status: { activeProofPeriodStartBlock: 1000n, isValid: true },
      challengeForNode: null,
      createChallenge: async () => ({
        challenge: makeChallenge({ knowledgeAssetId: fixture.kaId }),
        contextGraphId: fixture.cgId,
        hash: '0x', blockNumber: 1, success: true,
      }),
      expectedRoot: root,
      expectedLeafCount: leafCount,
      cgIdForKc: fixture.cgId,
      submitProof,
    });
    const repairMissingKnowledgeAsset = vi.fn(() =>
      createRandomSamplingRepairOperation(async () => {
        throw new Error('terminal response timed out');
      }));
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const prover = new RandomSamplingProver({
      chain,
      store,
      identityId: IDENTITY_ID,
      repairMissingKnowledgeAsset,
      log,
    });

    await expect(prover.tick()).resolves.toMatchObject({
      kind: 'kc-not-synced',
      kaId: fixture.kaId,
      cgId: fixture.cgId,
    });
    expect(repairMissingKnowledgeAsset).toHaveBeenCalledOnce();
    expect(submitProof).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      'rs.tick.kc-repair-failed',
      expect.objectContaining({ err: 'terminal response timed out' }),
    );
    await prover.close();
  });

  it('repairs a partially materialized KA whose metadata exists without payload data', async () => {
    const fixture: KCFixture = {
      cgId: 11n,
      kaId: 999n,
      ual: 'did:dkg:hardhat:31337/0x0000000000000000000000000000000000000001/999',
      rootEntities: ['urn:e:partial'],
      publicTriples: [
        { subject: 'urn:e:partial', predicate: 'urn:p:k', object: '"completed"' },
      ],
    };
    await seedKCMetadata(store, fixture);
    const { root, leafCount } = structuredKARootV10(
      fixture.publicTriples.map((triple) =>
        hashTripleV10(triple.subject, triple.predicate, triple.object)),
      [],
    );
    const submitProof = vi.fn(async () => ({
      hash: '0xpartial-data', blockNumber: 1001, success: true,
    }));
    const chain = makeChain({
      status: { activeProofPeriodStartBlock: 1000n, isValid: true },
      challengeForNode: null,
      createChallenge: async () => ({
        challenge: makeChallenge({ knowledgeAssetId: fixture.kaId }),
        contextGraphId: fixture.cgId,
        hash: '0x', blockNumber: 1, success: true,
      }),
      expectedRoot: root,
      expectedLeafCount: leafCount,
      cgIdForKc: fixture.cgId,
      submitProof,
    });
    const repairMissingKnowledgeAsset = vi.fn(() =>
      createRandomSamplingRepairOperation(async () => ({
        contents: fixture.publicTriples.map((triple) => tripleContentV10(
          triple.subject,
          triple.predicate,
          triple.object,
        )),
        privateRoots: [],
      })));
    const prover = new RandomSamplingProver({
      chain,
      store,
      identityId: IDENTITY_ID,
      repairMissingKnowledgeAsset,
    });

    await expect(prover.tick()).resolves.toMatchObject({
      kind: 'submitted',
      txHash: '0xpartial-data',
    });
    expect(repairMissingKnowledgeAsset).toHaveBeenCalledOnce();
    await prover.close();
  });

  it('returns submit-stale when submitProof throws ChallengeNoLongerActiveError', async () => {
    const fixture: KCFixture = {
      cgId: 11n, kaId: 7n, ual: 'did:dkg:hardhat:31337/0xpub/7',
      rootEntities: ['urn:e:1'],
      publicTriples: [{ subject: 'urn:e:1', predicate: 'urn:p:k', object: '"a"' }],
    };
    const { root, leafCount } = await seedKC(store, fixture);

    const submitProof = vi.fn(async () => { throw new ChallengeNoLongerActiveError(); });
    const chain = makeChain({
      status: { activeProofPeriodStartBlock: 1000n, isValid: true },
      challengeForNode: null,
      createChallenge: async () => ({
        challenge: makeChallenge({ knowledgeAssetId: fixture.kaId, chunkId: 0n }),
        contextGraphId: fixture.cgId,
        hash: '0x', blockNumber: 1, success: true,
      }),
      expectedRoot: root,
      expectedLeafCount: leafCount,
      cgIdForKc: fixture.cgId,
      submitProof: submitProof as never,
    });
    const wal = new InMemoryProverWal();
    const prover = new RandomSamplingProver({ chain, store, identityId: IDENTITY_ID, wal });
    const outcome = await prover.tick();
    expect(outcome).toEqual({ kind: 'submit-stale' });
    expect(submitProof).toHaveBeenCalledTimes(1);
    const trail = (await wal.readAll()).map((e) => e.status);
    expect(trail).toEqual(['challenge', 'extracted', 'built', 'failed']);
    await prover.close();
  });
});

describe('RandomSamplingProver — concurrency', () => {
  it('single-flights: concurrent ticks resolve to the same outcome and run once', async () => {
    const store = new OxigraphStore();
    const fixture: KCFixture = {
      cgId: 1n, kaId: 1n, ual: 'did:dkg:hardhat:31337/0xpub/1',
      rootEntities: ['urn:s'],
      publicTriples: [{ subject: 'urn:s', predicate: 'urn:p:k', object: '"v"' }],
    };
    const { root, leafCount } = await seedKC(store, fixture);

    let createChallengeCalls = 0;
    const submitProof = vi.fn(async () => ({ hash: '0xfeed', blockNumber: 1, success: true }));
    const chain = makeChain({
      status: { activeProofPeriodStartBlock: 1000n, isValid: true },
      challengeForNode: null,
      createChallenge: async () => {
        createChallengeCalls += 1;
        return {
          challenge: makeChallenge({ knowledgeAssetId: fixture.kaId, chunkId: 0n }),
          contextGraphId: fixture.cgId,
          hash: '0x', blockNumber: 1, success: true,
        };
      },
      expectedRoot: root,
      expectedLeafCount: leafCount,
      cgIdForKc: fixture.cgId,
      submitProof: submitProof as never,
    });

    const prover = new RandomSamplingProver({ chain, store, identityId: IDENTITY_ID });
    const [a, b, c] = await Promise.all([prover.tick(), prover.tick(), prover.tick()]);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(createChallengeCalls).toBe(1);
    expect(submitProof).toHaveBeenCalledTimes(1);
    await prover.close();
  });
});
