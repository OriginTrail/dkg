import {
  assertCanonicalGraphScopedAuthorSealV1,
  buildAuthorAttestationTypedData,
  type AuthorCatalogScopeV1,
  type CanonicalGraphScopedAuthorSealV1,
  type CatalogSealDeploymentProfileV1,
  type ContextGraphIdV1,
  type Digest32V1,
  type EvmAddressV1,
  type NetworkIdV1,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { produceEmptyAuthorCatalogGenesisV1 } from '../src/rfc64/author-catalog-producer.js';
import { rfc64SignerTakingTurnsV1 } from '../src/rfc64/control-envelope-signer-v1.js';
import { produceDirectAuthorCatalogIssuerDelegationV1 } from '../src/rfc64/public-catalog-issuer-delegation-v1.js';
import {
  Rfc64PublicCatalogSuccessorProducerV1,
  type ProduceAndStagePublicOpenExactSetSuccessorInputV1,
} from '../src/rfc64/public-catalog-successor-producer-v1.js';
import {
  rfc64PublicCatalogSuccessorHeadNamesBindingV1,
  snapshotRfc64PublicCatalogSuccessorRowBindingV1,
} from '../src/rfc64/public-catalog-successor-row-binding-v1.js';

// Every checkpoint is a real macrotask here, so each place where the producer
// can give up the main thread is observable and a test can act inside it.
const timeSlice = vi.hoisted(() => ({
  turns: 0,
  /** False: the checkpoint never leaves the current turn. */
  yields: true,
  onTurn: undefined as ((turn: number) => void) | undefined,
}));
vi.mock('../src/main-thread-time-slice.js', () => ({
  createMainThreadTimeSlice: () => async (): Promise<void> => {
    if (!timeSlice.yields) return;
    timeSlice.turns += 1;
    const turn = timeSlice.turns;
    await new Promise<void>((resolve) => setImmediate(resolve));
    timeSlice.onTurn?.(turn);
  },
}));

const AUTHOR_WALLET = new ethers.Wallet(`0x${'66'.repeat(32)}`);
const AUTHOR = AUTHOR_WALLET.address.toLowerCase() as EvmAddressV1;
const NETWORK_ID = 'otp:20430' as NetworkIdV1;
const CONTEXT_GRAPH_ID =
  '0x1111111111111111111111111111111111111111/successor-turns' as ContextGraphIdV1;
const OTHER_CONTEXT_GRAPH_ID =
  '0x1111111111111111111111111111111111111111/successor-turns-other' as ContextGraphIdV1;
const GOVERNANCE = '0x2222222222222222222222222222222222222222' as EvmAddressV1;
const KAV10 = '0x4444444444444444444444444444444444444444' as EvmAddressV1;
const ASSERTION_ROOT =
  '0x8d7a7be6029c98db1a7300bf47008c90084d5de4a3b97a68c043c0ea4773609f' as Digest32V1;
const PROJECTION = new TextEncoder().encode(
  '<https://example.org/alice> <https://schema.org/age> "42"^^<http://www.w3.org/2001/XMLSchema#integer> .\n'
  + '<https://example.org/alice> <https://schema.org/name> "Alice" .\n',
);
const DEPLOYMENT = Object.freeze({
  networkId: NETWORK_ID,
  assertedAtChainId: '20430',
  assertedAtKav10Address: KAV10,
}) as CatalogSealDeploymentProfileV1;
const ROWS = 3;
/** One per row in each of the three per-row loops. */
const ROW_TURNS = 3 * ROWS;

type Input = ProduceAndStagePublicOpenExactSetSuccessorInputV1;
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

describe('RFC-64 exact-set successor producer: turns of the main thread', () => {
  beforeEach(() => {
    timeSlice.turns = 0;
    timeSlice.yields = true;
    timeSlice.onTurn = undefined;
  });

  it('verifies every row before the first signature and stages only after the last turn', async () => {
    const { input, events, signDigest } = await threeRowProduction();

    const result = await harness(events).produceAndStageExactSet(input);

    expect(result.assets).toHaveLength(ROWS);
    const firstSignature = events.indexOf('sign');
    const firstStage = events.indexOf('stage-bundle');
    // Row preparation and the pre-signature checks are two full passes, and
    // the signature takes a turn of its own.
    expect(events.slice(0, firstSignature).filter((event) => event === 'turn'))
      .toHaveLength(2 * ROWS + 1);
    expect(events.slice(0, firstSignature)).not.toContain('stage-bundle');
    // Bucket, directory node and head, then one more pass over the rows.
    expect(signDigest).toHaveBeenCalledTimes(3);
    expect(events.slice(firstSignature, firstStage).filter((event) => event === 'turn').length)
      .toBeGreaterThanOrEqual(2 + ROWS);
    // Nothing gives up the main thread once staging has begun.
    expect(events.slice(firstStage)).not.toContain('turn');
    expect(events.slice(firstStage)).not.toContain('sign');
    expect(events.at(-1)).toBe('stage-objects');
    expect(timeSlice.turns).toBeGreaterThanOrEqual(ROW_TURNS + 3);
  });

  it('signs the same head whether or not it gives up the main thread', async () => {
    const first = await threeRowProduction();
    timeSlice.yields = false;
    const inOneTurn = await harness(first.events).produceAndStageExactSet(first.input);
    expect(timeSlice.turns).toBe(0);

    const second = await threeRowProduction();
    timeSlice.yields = true;
    const inTurns = await harness(second.events).produceAndStageExactSet(second.input);

    expect(timeSlice.turns).toBeGreaterThanOrEqual(ROW_TURNS + 3);
    expect(inTurns.publication.head).toEqual(inOneTurn.publication.head);
    expect(inTurns.publication.bucket).toEqual(inOneTurn.publication.bucket);
    expect(inTurns.publication.stagedObjects).toEqual(inOneTurn.publication.stagedObjects);
    expect(inTurns.assets.map(({ bundleDigest }) => bundleDigest))
      .toEqual(inOneTurn.assets.map(({ bundleDigest }) => bundleDigest));
  });

  it('reads the caller\'s input once, before its first turn', async () => {
    const reference = await threeRowProduction();
    const expected = await harness(reference.events).produceAndStageExactSet(reference.input);

    const { input, events } = await threeRowProduction();
    const mutable = input as Mutable<Input>;
    const deployment = { ...DEPLOYMENT } as Mutable<CatalogSealDeploymentProfileV1>;
    mutable.deployment = deployment;
    const stranger = ethers.Wallet.createRandom();
    const pending = harness(events).produceAndStageExactSet(input);
    // The call has returned its promise: everything below happens before the
    // producer's first turn ends.
    (mutable.assets as unknown[]).length = 0;
    mutable.previousHead = undefined as never;
    mutable.previousDirectoryPath = [];
    mutable.previousBucket = null;
    mutable.issuedAt = '1' as never;
    mutable.catalogSigner = {
      issuer: stranger.address.toLowerCase() as EvmAddressV1,
      signDigest: (digest) => stranger.signMessage(digest),
    };
    mutable.catalogIssuerAuthorization = undefined as never;
    deployment.assertedAtKav10Address = GOVERNANCE;

    const result = await pending;
    expect(result.publication.head).toEqual(expected.publication.head);
    expect(result.assets.map(({ row }) => row)).toEqual(expected.assets.map(({ row }) => row));
  });

  it('does not sign over a predecessor head that names another lane than its rows were bound to', async () => {
    const other = await producerHistory(OTHER_CONTEXT_GRAPH_ID);
    const { genesis, authorization } = await producerHistory();
    const head = structuredClone(genesis.head) as Mutable<typeof genesis.head>;
    const directoryPath = structuredClone(genesis.directoryPath) as Mutable<
      typeof genesis.directoryPath[number]
    >[];
    const signDigest = vi.fn(async (digest: Uint8Array) => AUTHOR_WALLET.signMessage(digest));
    const events: string[] = [];
    // Both heads are validly signed by the same author, so only the lane
    // comparison stands between the first rows and a signature for the other.
    timeSlice.onTurn = (turn) => {
      if (turn !== 1) return;
      Object.assign(head, structuredClone(other.genesis.head));
      Object.assign(directoryPath[0]!, structuredClone(other.genesis.directoryPath[0]));
    };

    await expect(harness(events).produceAndStageExactSet({
      previousHead: head,
      previousDirectoryPath: directoryPath,
      previousBucket: null,
      assets: [await asset(1)],
      deployment: DEPLOYMENT,
      issuedAt: '1773900001000' as never,
      catalogSigner: { issuer: AUTHOR, signDigest },
      catalogIssuerAuthorization: authorization,
    })).rejects.toMatchObject({
      code: 'catalog-successor-producer-history',
      cause: expect.objectContaining({
        message: 'previous head changed while the exact set was being verified',
      }),
    });
    expect(signDigest).not.toHaveBeenCalled();
    expect(events).not.toContain('stage-bundle');
    expect(events).not.toContain('stage-objects');
  });

  it('classifies a predecessor head it cannot bind rows to as an input failure', async () => {
    const { authorization } = await producerHistory();
    const events: string[] = [];

    await expect(harness(events).produceAndStageExactSet({
      previousHead: {} as never,
      previousDirectoryPath: [],
      previousBucket: null,
      assets: [await asset(1)],
      deployment: DEPLOYMENT,
      issuedAt: '1773900001000' as never,
      catalogSigner: signer(vi.fn()),
      catalogIssuerAuthorization: authorization,
    })).rejects.toMatchObject({ code: 'catalog-successor-producer-input' });
    expect(timeSlice.turns).toBe(0);
    expect(events).toEqual([]);
  });

  describe('cancellation', () => {
    it('does nothing when the signal is already aborted', async () => {
      const { input, events, signDigest } = await threeRowProduction();
      const reason = new Error('shutting down');

      await expect(harness(events).produceAndStageExactSet({
        ...input,
        signal: AbortSignal.abort(reason),
      })).rejects.toBe(reason);
      expect(timeSlice.turns).toBe(1);
      expect(signDigest).not.toHaveBeenCalled();
      expect(events).not.toContain('stage-bundle');
    });

    it('stops between two rows of the pre-signature checks without signing', async () => {
      const { input, events, signDigest } = await threeRowProduction();
      const controller = new AbortController();
      const reason = new Error('superseded');
      // The second row of the second pass.
      timeSlice.onTurn = (turn) => {
        if (turn === ROWS + 2) controller.abort(reason);
      };

      await expect(harness(events).produceAndStageExactSet({
        ...input,
        signal: controller.signal,
      })).rejects.toBe(reason);
      expect(timeSlice.turns).toBe(ROWS + 2);
      expect(signDigest).not.toHaveBeenCalled();
      expect(events).not.toContain('stage-bundle');
    });

    it('stops after the signatures, before anything is staged', async () => {
      const { input, events, signDigest } = await threeRowProduction();
      const controller = new AbortController();
      const reason = new Error('superseded');
      timeSlice.onTurn = () => {
        if (signDigest.mock.calls.length === 3) controller.abort(reason);
      };

      await expect(harness(events).produceAndStageExactSet({
        ...input,
        signal: controller.signal,
      })).rejects.toBe(reason);
      expect(signDigest).toHaveBeenCalledTimes(3);
      expect(events).not.toContain('stage-bundle');
      expect(events).not.toContain('stage-objects');
    });

    it('reports a reason that is not an Error under its own message', async () => {
      const { input, events } = await threeRowProduction();
      const controller = new AbortController();
      timeSlice.onTurn = () => controller.abort('stop');

      await expect(harness(events).produceAndStageExactSet({
        ...input,
        signal: controller.signal,
      })).rejects.toThrow('RFC-64 catalog successor production aborted');
      expect(events).not.toContain('stage-bundle');
    });

    it('completes a production whose signal is aborted once staging has begun', async () => {
      const { input, events } = await threeRowProduction();
      const controller = new AbortController();
      const producer = harness(events, () => controller.abort(new Error('too late')));

      const result = await producer.produceAndStageExactSet({
        ...input,
        signal: controller.signal,
      });

      expect(controller.signal.aborted).toBe(true);
      expect(result.assets).toHaveLength(ROWS);
      expect(events.at(-1)).toBe('stage-objects');
    });
  });
});

describe('RFC-64 signer taking turns', () => {
  it('awaits the turn before each signature and keeps the issuer', async () => {
    const order: string[] = [];
    const signDigest = vi.fn(async () => {
      order.push('sign');
      return '0xsignature';
    });
    const taking = rfc64SignerTakingTurnsV1({ issuer: AUTHOR, signDigest }, async () => {
      order.push('turn');
    });
    const digest = new Uint8Array([1, 2, 3]);

    await expect(taking.signDigest(digest)).resolves.toBe('0xsignature');
    await taking.signDigest(digest);

    expect(taking.issuer).toBe(AUTHOR);
    expect(Object.isFrozen(taking)).toBe(true);
    expect(order).toEqual(['turn', 'sign', 'turn', 'sign']);
    expect(signDigest).toHaveBeenCalledWith(digest);
  });

  it('reads the callback once, so a later replacement is not the one that signs', async () => {
    const original = vi.fn(async () => '0xoriginal');
    const signerObject = { issuer: AUTHOR, signDigest: original };
    const taking = rfc64SignerTakingTurnsV1(signerObject, async () => undefined);
    signerObject.signDigest = vi.fn(async () => '0xreplaced');

    await expect(taking.signDigest(new Uint8Array(32))).resolves.toBe('0xoriginal');
  });

  it('passes a failing callback through unchanged', async () => {
    const failure = new Error('wallet locked');
    const taking = rfc64SignerTakingTurnsV1({
      issuer: AUTHOR,
      signDigest: async () => {
        throw failure;
      },
    }, async () => undefined);

    await expect(taking.signDigest(new Uint8Array(32))).rejects.toBe(failure);
  });

  it('leaves a signer without a callback for its consumer to reject', () => {
    const malformed = { issuer: AUTHOR } as never;

    expect(rfc64SignerTakingTurnsV1(malformed, async () => undefined)).toBe(malformed);
  });
});

describe('RFC-64 exact-set successor row binding', () => {
  it('is a detached, frozen copy of the lane and the deployment', async () => {
    const { genesis } = await producerHistory();
    const head = structuredClone(genesis.head) as Mutable<typeof genesis.head>;
    const deployment = { ...DEPLOYMENT } as Mutable<CatalogSealDeploymentProfileV1>;

    const binding = snapshotRfc64PublicCatalogSuccessorRowBindingV1(head, deployment);
    (head.payload as Mutable<typeof head.payload>).contextGraphId = OTHER_CONTEXT_GRAPH_ID;
    deployment.assertedAtKav10Address = GOVERNANCE;

    expect(binding.scope).toEqual({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      governanceChainId: '20430',
      governanceContractAddress: GOVERNANCE,
      ownershipTransitionDigest: null,
      subGraphName: null,
      authorAddress: AUTHOR,
      era: '0',
      bucketCount: '1',
    });
    expect(binding.deployment).toEqual(DEPLOYMENT);
    expect(Object.isFrozen(binding)).toBe(true);
    expect(Object.isFrozen(binding.scope)).toBe(true);
    expect(Object.isFrozen(binding.deployment)).toBe(true);
  });

  it('recognises the head it was taken from and no head of another lane', async () => {
    const { genesis } = await producerHistory();
    const other = await producerHistory(OTHER_CONTEXT_GRAPH_ID);
    const subGraph = await producerHistory(CONTEXT_GRAPH_ID, 'service-lane' as never);
    const binding = snapshotRfc64PublicCatalogSuccessorRowBindingV1(genesis.head, DEPLOYMENT);

    expect(rfc64PublicCatalogSuccessorHeadNamesBindingV1(genesis.head, binding)).toBe(true);
    expect(rfc64PublicCatalogSuccessorHeadNamesBindingV1(other.genesis.head, binding)).toBe(false);
    expect(rfc64PublicCatalogSuccessorHeadNamesBindingV1(subGraph.genesis.head, binding))
      .toBe(false);
  });
});

/** A producer over recording stores; `onFirstStage` runs inside the first bundle write. */
function harness(events: string[], onFirstStage?: () => void) {
  let staged = 0;
  return new Rfc64PublicCatalogSuccessorProducerV1({
    controlObjects: {
      stageVerifiedObjects: async () => {
        events.push('stage-objects');
        return Object.freeze({
          durable: true as const,
          namespaceDurability: 'test-exact-durable' as never,
          objects: Object.freeze([]),
        });
      },
    } as never,
    stageKaBundle: async (input) => {
      events.push('stage-bundle');
      staged += 1;
      if (staged === 1) onFirstStage?.();
      return Object.freeze({
        durable: true as const,
        blobDigest: input.blobDigest,
        byteLength: input.bundleBytes.byteLength,
      });
    },
  });
}

/**
 * A three-row exact set over a real two-row predecessor, with the turns and
 * signatures of that last production recorded in `events`.
 */
async function threeRowProduction() {
  timeSlice.onTurn = undefined;
  const { genesis, authorization } = await producerHistory();
  const assets = [await asset(1), await asset(2), await asset(3)];
  let previous: Pick<typeof genesis, 'head' | 'directoryPath' | 'bucket'> = genesis;
  for (let rows = 1; rows < ROWS; rows += 1) {
    const produced = await harness([]).produceAndStageExactSet({
      previousHead: previous.head,
      previousDirectoryPath: previous.directoryPath,
      previousBucket: previous.bucket,
      assets: assets.slice(0, rows),
      deployment: DEPLOYMENT,
      issuedAt: String(1773900000000 + rows) as never,
      catalogSigner: signer(vi.fn(async (digest: Uint8Array) => AUTHOR_WALLET.signMessage(digest))),
      catalogIssuerAuthorization: authorization,
    });
    previous = produced.publication;
  }
  const events: string[] = [];
  const signDigest = vi.fn(async (digest: Uint8Array) => {
    events.push('sign');
    return AUTHOR_WALLET.signMessage(digest);
  });
  timeSlice.turns = 0;
  const input: Input = {
    previousHead: previous.head,
    previousDirectoryPath: previous.directoryPath,
    previousBucket: previous.bucket,
    assets,
    deployment: DEPLOYMENT,
    issuedAt: '1773900009000' as never,
    catalogSigner: signer(signDigest),
    catalogIssuerAuthorization: authorization,
  };
  // Tests that install their own onTurn replace this recorder on purpose.
  timeSlice.onTurn = () => {
    events.push('turn');
  };
  return { input, events, signDigest };
}

function signer(signDigest: (digest: Uint8Array) => Promise<string>) {
  return { issuer: AUTHOR, signDigest };
}

async function producerHistory(
  contextGraphId: ContextGraphIdV1 = CONTEXT_GRAPH_ID,
  subGraphName: AuthorCatalogScopeV1['subGraphName'] = null,
) {
  const scope = {
    networkId: NETWORK_ID,
    contextGraphId,
    governanceChainId: '20430',
    governanceContractAddress: GOVERNANCE,
    ownershipTransitionDigest: null,
    subGraphName,
    authorAddress: AUTHOR,
    era: '0',
    bucketCount: '1',
  } as AuthorCatalogScopeV1;
  const catalogSigner = signer((digest) => AUTHOR_WALLET.signMessage(digest));
  const { authorization } = await produceDirectAuthorCatalogIssuerDelegationV1({
    scope,
    signer: catalogSigner,
    effectiveAt: '1773899999000' as never,
    expiresAt: '1774000000000' as never,
    catalogHeadIssuedAt: '1773900000000' as never,
  });
  const genesis = await produceEmptyAuthorCatalogGenesisV1({
    scope,
    catalogIssuerDelegationDigest: authorization.catalogIssuerDelegation.objectDigest,
    issuedAt: '1773900000000' as never,
    signer: catalogSigner,
  });
  return { genesis, authorization };
}

async function asset(kaNumber: number) {
  return {
    assertionCoordinate: `turns-object-${kaNumber}` as never,
    projectionBytes: PROJECTION,
    seal: await authorSeal(BigInt(kaNumber)),
  };
}

async function authorSeal(kaNumber: bigint): Promise<CanonicalGraphScopedAuthorSealV1> {
  const kaId = ((BigInt(AUTHOR) << 96n) | kaNumber).toString();
  const typedData = buildAuthorAttestationTypedData({
    chainId: BigInt(DEPLOYMENT.assertedAtChainId),
    kav10Address: DEPLOYMENT.assertedAtKav10Address,
    merkleRoot: ethers.getBytes(ASSERTION_ROOT),
    authorAddress: AUTHOR,
    reservedKaId: BigInt(kaId),
  });
  const signature = ethers.Signature.from(await AUTHOR_WALLET.signTypedData(
    typedData.domain,
    typedData.types,
    typedData.message,
  ));
  const seal = {
    assertionMerkleRoot: ASSERTION_ROOT,
    authorAddress: AUTHOR,
    authorAttestationR: signature.r,
    authorAttestationVS: signature.yParityAndS,
    authorSchemeVersion: '1',
    assertedAtChainId: DEPLOYMENT.assertedAtChainId,
    assertedAtKav10Address: KAV10,
    reservedKaId: kaId,
    assertionFinalizedAt: '2026-07-19T12:34:56.789Z',
    contentScopeVersion: '2',
    kaUal: `did:dkg:${NETWORK_ID}/${AUTHOR}/${kaNumber}`,
    assertionVersion: '1',
    publicTripleCount: '2',
    privateTripleCount: '0',
    privateMerkleRoot: null,
  } as unknown as CanonicalGraphScopedAuthorSealV1;
  assertCanonicalGraphScopedAuthorSealV1(seal);
  return seal;
}
