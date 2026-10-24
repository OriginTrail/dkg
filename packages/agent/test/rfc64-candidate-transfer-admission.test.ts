import {
  mkdtempSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AUTHOR_CATALOG_BUCKET_OBJECT_TYPE_V1,
  AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
  AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1,
  assertAuthorCatalogRowV1,
  assertCanonicalGraphScopedAuthorSealV1,
  assertSignedAuthorCatalogBucketEnvelopeV1,
  assertSignedAuthorCatalogDirectoryNodeEnvelopeV1,
  assertSignedAuthorCatalogHeadEnvelopeV1,
  assertVerifiedCgSharedProjectionForTransferV1,
  assertVerifiedTransferredCatalogBundleForInputsV1,
  canonicalizeAuthorCatalogBucketPayloadBytesV1,
  canonicalizeCanonicalGraphScopedAuthorSealBytesV1,
  computeAuthorCatalogBucketObjectDigestV1,
  computeAuthorCatalogDirectoryNodeObjectDigestV1,
  computeAuthorCatalogHeadObjectDigestV1,
  computeAuthorCatalogScopeDigestV1,
  computeCanonicalGraphScopedAuthorSealDigestV1,
  computeKaChunkTreeRootV1,
  deriveAuthorCatalogScopeFromHeadV1,
  encodeOpaqueKaBundleV1,
  readVerifiedCatalogSealBindingV1,
  readVerifiedCgSharedProjectionMetadataV1,
  readVerifiedTransferredCatalogBundleMetadataV1,
  verifyAuthorCatalogDirectoryPathV1,
  type AuthorCatalogBucketDescriptorV1,
  type AuthorCatalogBucketV1,
  type AuthorCatalogDirectoryNodeV1,
  type AuthorCatalogHeadV1,
  type AuthorCatalogRowV1,
  type ByteLengthV1,
  type CanonicalGraphScopedAuthorSealV1,
  type CatalogSealDeploymentProfileV1,
  type CgSharedProjectionVerificationLimitsV1,
  type CountV1,
  type DecimalU64V1,
  type Digest32V1,
  type SignedAuthorCatalogBucketEnvelopeV1,
  type SignedAuthorCatalogDirectoryNodeEnvelopeV1,
  type SignedAuthorCatalogHeadEnvelopeV1,
  type SignedControlEnvelopeV1,
  type UnsignedControlEnvelopeV1,
  type VerifiedAuthorCatalogDirectoryPathV1,
} from '@origintrail-official/dkg-core';

import {
  openInventoryV1,
  type CandidateBucketRowV1,
  type CandidateSessionV1,
  type Rfc64InventoryV1Foundation,
  type VerifiedCandidateBucketLoadV1,
  type VerifiedCandidateCatalogRowV1,
} from '../src/rfc64/inventory-v1/index.js';

const AUTHOR = '0x3333333333333333333333333333333333333333';
const ISSUER = '0x5555555555555555555555555555555555555555';
const GOVERNANCE = '0x6666666666666666666666666666666666666666';
const KAV10 = '0x4444444444444444444444444444444444444444';
const SIGNATURE = `0x${'77'.repeat(65)}`;
const ZERO_DIGEST = `0x${'00'.repeat(32)}` as Digest32V1;
const KA_ID = ((BigInt(AUTHOR) << 96n) | 7n).toString();
const UAL = `did:dkg:otp:20430/${AUTHOR}/7`;
const UTF8 = new TextEncoder();
const PROJECTION =
  '<https://example.org/alice> <https://schema.org/age> "42"^^<http://www.w3.org/2001/XMLSchema#integer> .\n'
  + '<https://example.org/alice> <https://schema.org/name> "Alice" .\n';
const ASSERTION_ROOT =
  '0x8d7a7be6029c98db1a7300bf47008c90084d5de4a3b97a68c043c0ea4773609f';
const PROFILE = Object.freeze({
  networkId: 'otp:20430',
  assertedAtChainId: '20430',
  assertedAtKav10Address: KAV10,
}) as CatalogSealDeploymentProfileV1;

const temporaryDirectories: string[] = [];
const foundations: Rfc64InventoryV1Foundation[] = [];

afterEach(() => {
  for (const foundation of foundations.splice(0)) foundation.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('RFC-64 live candidate transfer admission boundary', () => {
  it('replaces one live present row with exact transfer and cg-shared capabilities', async () => {
    const fixture = await presentFixture();

    const result = fixture.inventory.verifyCandidateCatalogPrecommitV1(
      fixture.candidate.verifiedRow,
      fixture.head,
      fixture.bundleBytes,
      PROFILE,
    );

    expect(Object.isFrozen(result)).toBe(true);
    expect(Reflect.ownKeys(result)).toEqual(['transferredBundle', 'sharedProjection']);
    expect(() => assertVerifiedTransferredCatalogBundleForInputsV1(
      result.transferredBundle,
      fixture.head,
      fixture.row,
      PROFILE,
    )).not.toThrow();
    expect(() => assertVerifiedCgSharedProjectionForTransferV1(
      result.sharedProjection,
      result.transferredBundle,
      fixture.head,
      fixture.row,
      PROFILE,
    )).not.toThrow();

    const transfer = readVerifiedTransferredCatalogBundleMetadataV1(
      result.transferredBundle,
      fixture.head,
      fixture.row,
      PROFILE,
    );
    const seal = readVerifiedCatalogSealBindingV1(transfer.catalogSealBinding);
    expect(seal).toMatchObject({
      authorAddress: AUTHOR,
      kaId: KA_ID,
      assertionCoordinate: 'name λ',
      assertionVersion: '2',
      seal: { kaUal: UAL, assertionMerkleRoot: ASSERTION_ROOT },
    });

    const projection = readVerifiedCgSharedProjectionMetadataV1(
      result.sharedProjection,
      result.transferredBundle,
      fixture.head,
      fixture.row,
      PROFILE,
    );
    expect(projection).toMatchObject({
      projectionDigest: fixture.row.projectionDigest,
      projectionByteLength: String(UTF8.encode(PROJECTION).byteLength),
      assertionMerkleRoot: ASSERTION_ROOT,
      publicTripleCount: '2',
      privateTripleCount: '0',
      privateMerkleRoot: null,
      kaUal: UAL,
    });

    // Successful replacement does not implicitly close the caller-owned page traversal.
    expect(fixture.inventory.readVerifiedCandidateCatalogRow(
      fixture.candidate.verifiedRow,
    ).disposition).toBe('present');
  });

  it('rejects plain views, structural lookalikes, and capabilities from another inventory', async () => {
    const fixture = await presentFixture();
    const other = await readyInventory();
    const snapshot = fixture.inventory.readVerifiedCandidateCatalogRow(
      fixture.candidate.verifiedRow,
    );
    const lookalikes = [
      snapshot,
      fixture.candidate.row,
      Object.freeze(Object.create(null)),
      JSON.parse(JSON.stringify(fixture.candidate.verifiedRow)),
    ];

    for (const lookalike of lookalikes) {
      expectCandidateFailure(
        () => fixture.inventory.verifyCandidateCatalogPrecommitV1(
          lookalike as VerifiedCandidateCatalogRowV1,
          fixture.head,
          fixture.bundleBytes,
          PROFILE,
        ),
        'candidate-invalid-row-proof',
      );
    }
    expectCandidateFailure(
      () => other.verifyCandidateCatalogPrecommitV1(
        fixture.candidate.verifiedRow,
        fixture.head,
        fixture.bundleBytes,
        PROFILE,
      ),
      'candidate-invalid-row-proof',
    );

    // Tampering with the serializable page wrapper cannot change the privately retained proof.
    const tampered = {
      ...fixture.candidate,
      disposition: 'removed',
      row: { ...fixture.row, assertionCoordinate: 'attacker' },
    } as unknown as CandidateBucketRowV1;
    expect(() => fixture.inventory.verifyCandidateCatalogPrecommitV1(
      tampered.verifiedRow,
      fixture.head,
      fixture.bundleBytes,
      PROFILE,
    )).not.toThrow();
  });

  it('rejects removed rows before inspecting untrusted bundle or deployment input', async () => {
    const inventory = await readyInventory();
    const session = inventory.createCandidateSession();
    const transfer = transferFixture();
    const oldLoad = makeNonEmptyLoad(session, makeHead('1', '1'), [transfer.row]);
    const newLoad = makeEmptyLoad(session, makeHead('0', '2'));
    const oldStored = inventory.putVerifiedCandidateBucket(oldLoad);
    const newStored = inventory.putVerifiedCandidateBucket(newLoad);
    const traversal = inventory.beginCandidateBucketDiff(oldStored.loadKey, newStored.loadKey);
    const removed = inventory.pageCandidateBucketRemoved(traversal, null, 1).rows[0];
    expect(removed.disposition).toBe('removed');

    let deploymentRead = false;
    const hostileDeployment = Object.create(null) as CatalogSealDeploymentProfileV1;
    Object.defineProperty(hostileDeployment, 'networkId', {
      get() {
        deploymentRead = true;
        throw new Error('deployment must not be inspected for a removed row');
      },
    });

    expectCandidateFailure(
      () => inventory.verifyCandidateCatalogPrecommitV1(
        removed.verifiedRow,
        oldLoad.head,
        new Uint8Array([0xff]),
        hostileDeployment,
      ),
      'candidate-row-not-present',
    );
    expect(deploymentRead).toBe(false);
  });

  it('rejects stale row capabilities and a different canonical head in the same scope', async () => {
    const explicitlyClosed = await presentFixture();
    explicitlyClosed.inventory.closeCandidateTraversal(explicitlyClosed.traversal);
    expectCandidateFailure(
      () => explicitlyClosed.inventory.verifyCandidateCatalogPrecommitV1(
        explicitlyClosed.candidate.verifiedRow,
        explicitlyClosed.head,
        explicitlyClosed.bundleBytes,
        PROFILE,
      ),
      'candidate-stale-row-proof',
    );

    const exhausted = await presentFixture();
    expect(exhausted.inventory.pageCandidateBucketRows(
      exhausted.traversal,
      exhausted.pageResumeAfter,
      1,
    )).toEqual({ rows: [], resumeAfter: null });
    expectCandidateFailure(
      () => exhausted.inventory.verifyCandidateCatalogPrecommitV1(
        exhausted.candidate.verifiedRow,
        exhausted.head,
        exhausted.bundleBytes,
        PROFILE,
      ),
      'candidate-stale-row-proof',
    );

    const wrongHead = await presentFixture();
    const sameScopeDifferentHead = makeHead('1', '99');
    expect(deriveAuthorCatalogScopeFromHeadV1(sameScopeDifferentHead.payload)).toEqual(
      deriveAuthorCatalogScopeFromHeadV1(wrongHead.head.payload),
    );
    expect(sameScopeDifferentHead.objectDigest).not.toBe(wrongHead.head.objectDigest);
    expectCandidateFailure(
      () => wrongHead.inventory.verifyCandidateCatalogPrecommitV1(
        wrongHead.candidate.verifiedRow,
        sameScopeDifferentHead,
        wrongHead.bundleBytes,
        PROFILE,
      ),
      'candidate-head-binding',
    );
  });

  it('cannot rebind a candidate through a switching signed-head Proxy', async () => {
    const fixture = await presentFixture();
    const reboundHead = makeHead('1', '99');
    expect(deriveAuthorCatalogScopeFromHeadV1(reboundHead.payload)).toEqual(
      deriveAuthorCatalogScopeFromHeadV1(fixture.head.payload),
    );
    expect(reboundHead.objectDigest).not.toBe(fixture.head.objectDigest);

    // The old boundary consumed three digest reads while validating the head,
    // then one candidate-binding read. It could therefore see the candidate head
    // through that fourth read and expose another same-scope head to core verifiers.
    let objectDigestReads = 0;
    const switchingHead = new Proxy(fixture.head, {
      get(_target, property) {
        const source = objectDigestReads >= 4 ? reboundHead : fixture.head;
        const value = Reflect.get(source, property);
        if (property === 'objectDigest') objectDigestReads += 1;
        return value;
      },
    }) as SignedAuthorCatalogHeadEnvelopeV1;

    expectCandidateFailure(
      () => fixture.inventory.verifyCandidateCatalogPrecommitV1(
        fixture.candidate.verifiedRow,
        switchingHead,
        fixture.bundleBytes,
        PROFILE,
      ),
      'candidate-head-binding',
    );
    expect(objectDigestReads).toBeGreaterThan(4);
  });

  it('snapshots each caller-controlled deployment scalar exactly once', async () => {
    const fixture = await presentFixture();
    const scalarReads = new Map<PropertyKey, number>();
    const deployment = new Proxy(PROFILE, {
      get(target, property, receiver) {
        if (
          property === 'networkId'
          || property === 'assertedAtChainId'
          || property === 'assertedAtKav10Address'
        ) {
          const reads = (scalarReads.get(property) ?? 0) + 1;
          scalarReads.set(property, reads);
          if (reads > 1) throw new Error(`${String(property)} was reread`);
        }
        return Reflect.get(target, property, receiver);
      },
    }) as CatalogSealDeploymentProfileV1;

    expect(() => fixture.inventory.verifyCandidateCatalogPrecommitV1(
      fixture.candidate.verifiedRow,
      fixture.head,
      fixture.bundleBytes,
      deployment,
    )).not.toThrow();
    expect(Object.fromEntries(scalarReads)).toEqual({
      networkId: 1,
      assertedAtChainId: 1,
      assertedAtKav10Address: 1,
    });
  });

  it('fails closed if re-entrant input access invalidates the row during verification', async () => {
    const fixture = await presentFixture();
    let closed = false;
    const reentrantLimits = Object.defineProperties({}, {
      maxProjectionBytes: {
        enumerable: true,
        get() {
          if (!closed) {
            closed = true;
            fixture.inventory.closeCandidateTraversal(fixture.traversal);
          }
          return 64 * 1024 * 1024;
        },
      },
      maxPublicTriples: {
        enumerable: true,
        get: () => 262_144,
      },
      maxLineBytes: {
        enumerable: true,
        get: () => 64 * 1024 * 1024,
      },
    }) as CgSharedProjectionVerificationLimitsV1;

    expectCandidateFailure(
      () => fixture.inventory.verifyCandidateCatalogPrecommitV1(
        fixture.candidate.verifiedRow,
        fixture.head,
        fixture.bundleBytes,
        PROFILE,
        reentrantLimits,
      ),
      'candidate-binding-changed',
    );
    expect(closed).toBe(true);
  });
});

interface TransferFixture {
  readonly row: AuthorCatalogRowV1;
  readonly bundleBytes: Uint8Array;
}

interface PresentFixture extends TransferFixture {
  readonly inventory: Rfc64InventoryV1Foundation;
  readonly head: SignedAuthorCatalogHeadEnvelopeV1;
  readonly traversal: ReturnType<Rfc64InventoryV1Foundation['beginCandidateBucketRows']>;
  readonly candidate: CandidateBucketRowV1;
  readonly pageResumeAfter: CandidateBucketRowV1['row']['kaId'];
}

async function presentFixture(): Promise<PresentFixture> {
  const inventory = await readyInventory();
  const session = inventory.createCandidateSession();
  const transfer = transferFixture();
  const load = makeNonEmptyLoad(session, makeHead('1', '1'), [transfer.row]);
  const stored = inventory.putVerifiedCandidateBucket(load);
  const traversal = inventory.beginCandidateBucketRows(stored.loadKey);
  const page = inventory.pageCandidateBucketRows(traversal, null, 1);
  const candidate = page.rows[0];
  if (candidate === undefined || page.resumeAfter === null) {
    throw new Error('present transfer fixture did not produce one candidate row');
  }
  return {
    ...transfer,
    inventory,
    head: load.head,
    traversal,
    candidate,
    pageResumeAfter: page.resumeAfter,
  };
}

function transferFixture(): TransferFixture {
  const seal = validSeal({
    assertionMerkleRoot: ASSERTION_ROOT,
    authorAddress: AUTHOR,
    authorAttestationR: `0x${'11'.repeat(32)}`,
    authorAttestationVS: `0x${'22'.repeat(32)}`,
    authorSchemeVersion: '1',
    assertedAtChainId: '20430',
    assertedAtKav10Address: KAV10,
    reservedKaId: KA_ID,
    assertionFinalizedAt: '2026-07-19T12:34:56.789Z',
    contentScopeVersion: '2',
    kaUal: UAL,
    assertionVersion: '2',
    publicTripleCount: '2',
    privateTripleCount: '0',
    privateMerkleRoot: null,
  });
  const sealBytes = canonicalizeCanonicalGraphScopedAuthorSealBytesV1(seal);
  const encoded = encodeOpaqueKaBundleV1(UTF8.encode(PROJECTION), sealBytes);
  const byteLength = BigInt(encoded.bundleBytes.byteLength);
  const row = validRow({
    kaId: KA_ID,
    assertionCoordinate: 'name λ',
    assertionVersion: '2',
    projectionId: 'cg-shared-v1',
    projectionDigest: encoded.projectionDigest,
    sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(seal),
    transfer: {
      codec: 'dkg-ka-bundle-v1',
      projectionId: 'cg-shared-v1',
      projectionDigest: encoded.projectionDigest,
      byteLength: byteLength.toString(),
      chunkSize: '262144',
      chunkCount: (((byteLength - 1n) / 262_144n) + 1n).toString(),
      blobDigest: encoded.blobDigest,
      chunkTreeRoot: computeKaChunkTreeRootV1(encoded.bundleBytes),
    },
  });
  return { row, bundleBytes: encoded.bundleBytes };
}

async function readyInventory(): Promise<Rfc64InventoryV1Foundation> {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'dkg-rfc64-transfer-')));
  temporaryDirectories.push(directory);
  const inventory = await openInventoryV1(directory);
  foundations.push(inventory);
  expect(inventory.purgeNextStartupStaleCandidateBatch()).toEqual({
    deletedLoads: 0,
    done: true,
  });
  return inventory;
}

function makeHead(
  totalRows: CountV1 | string,
  version: DecimalU64V1 | string,
): SignedAuthorCatalogHeadEnvelopeV1 {
  const payload = {
    networkId: 'otp:20430',
    contextGraphId: 'a/b',
    governanceChainId: '20430',
    governanceContractAddress: GOVERNANCE,
    ownershipTransitionDigest: null,
    subGraphName: null,
    authorAddress: AUTHOR,
    catalogIssuerDelegationDigest: `0x${'66'.repeat(32)}`,
    era: '0',
    version,
    previousHeadDigest: null,
    bucketCount: '1',
    totalRows,
    directoryHeight: '0',
    directoryRootDigest: `0x${String(version).padStart(2, '0').slice(-2).repeat(32)}`,
    issuedAt: String(1_700_000_000_000n + BigInt(version)),
  } as AuthorCatalogHeadV1;
  return signHead(payload);
}

function signHead(payload: AuthorCatalogHeadV1): SignedAuthorCatalogHeadEnvelopeV1 {
  const unsigned = {
    issuer: ISSUER,
    objectType: AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1,
    payload,
    signatureEvidence: { kind: 'none' },
    signatureSuite: 'eip191-personal-sign-digest-v1',
  } as unknown as UnsignedControlEnvelopeV1;
  const signed = {
    ...unsigned,
    objectDigest: computeAuthorCatalogHeadObjectDigestV1(unsigned),
    signature: SIGNATURE,
  } as SignedControlEnvelopeV1;
  assertSignedAuthorCatalogHeadEnvelopeV1(signed);
  return signed as SignedAuthorCatalogHeadEnvelopeV1;
}

function makeNonEmptyLoad(
  session: CandidateSessionV1,
  headTemplate: SignedAuthorCatalogHeadEnvelopeV1,
  rows: readonly AuthorCatalogRowV1[],
): VerifiedCandidateBucketLoadV1 {
  const scope = deriveAuthorCatalogScopeFromHeadV1(headTemplate.payload);
  const payload = {
    catalogScopeDigest: computeAuthorCatalogScopeDigestV1(scope),
    era: scope.era,
    bucketCount: scope.bucketCount,
    bucketId: '0',
    rows,
  } as AuthorCatalogBucketV1;
  const unsignedBucket = {
    issuer: ISSUER,
    objectType: AUTHOR_CATALOG_BUCKET_OBJECT_TYPE_V1,
    payload,
    signatureEvidence: { kind: 'none' },
    signatureSuite: 'eip191-personal-sign-digest-v1',
  } as unknown as UnsignedControlEnvelopeV1;
  const signedBucket = {
    ...unsignedBucket,
    objectDigest: computeAuthorCatalogBucketObjectDigestV1(unsignedBucket),
    signature: SIGNATURE,
  } as SignedControlEnvelopeV1;
  assertSignedAuthorCatalogBucketEnvelopeV1(signedBucket);
  const descriptor = {
    bucketId: '0',
    rowCount: String(rows.length),
    byteLength: String(canonicalizeAuthorCatalogBucketPayloadBytesV1(payload).byteLength),
    bucketDigest: signedBucket.objectDigest,
  } as AuthorCatalogBucketDescriptorV1;
  const bound = bindHeadToDescriptor(headTemplate, descriptor);
  return {
    session,
    head: bound.head,
    directoryPath: bound.directoryPath,
    bucket: signedBucket as SignedAuthorCatalogBucketEnvelopeV1,
  };
}

function makeEmptyLoad(
  session: CandidateSessionV1,
  headTemplate: SignedAuthorCatalogHeadEnvelopeV1,
): VerifiedCandidateBucketLoadV1 {
  const bound = bindHeadToDescriptor(headTemplate, {
    bucketId: '0' as DecimalU64V1,
    rowCount: '0' as CountV1,
    byteLength: '0' as ByteLengthV1,
    bucketDigest: ZERO_DIGEST,
  });
  return {
    session,
    head: bound.head,
    directoryPath: bound.directoryPath,
    bucket: null,
  };
}

function bindHeadToDescriptor(
  headTemplate: SignedAuthorCatalogHeadEnvelopeV1,
  descriptor: AuthorCatalogBucketDescriptorV1,
): {
  readonly head: SignedAuthorCatalogHeadEnvelopeV1;
  readonly directoryPath: VerifiedAuthorCatalogDirectoryPathV1;
} {
  const scope = deriveAuthorCatalogScopeFromHeadV1(headTemplate.payload);
  const directoryPayload = {
    catalogScopeDigest: computeAuthorCatalogScopeDigestV1(scope),
    entries: [descriptor],
    era: scope.era,
    firstBucketId: '0' as DecimalU64V1,
    level: '0' as DecimalU64V1,
  } as unknown as AuthorCatalogDirectoryNodeV1;
  const unsignedDirectory = {
    issuer: ISSUER,
    objectType: AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
    payload: directoryPayload,
    signatureEvidence: { kind: 'none' },
    signatureSuite: 'eip191-personal-sign-digest-v1',
  } as unknown as UnsignedControlEnvelopeV1;
  const signedDirectory = {
    ...unsignedDirectory,
    objectDigest: computeAuthorCatalogDirectoryNodeObjectDigestV1(
      unsignedDirectory,
      '1' as DecimalU64V1,
    ),
    signature: SIGNATURE,
  } as SignedControlEnvelopeV1;
  assertSignedAuthorCatalogDirectoryNodeEnvelopeV1(
    signedDirectory,
    '1' as DecimalU64V1,
  );
  const directory = signedDirectory as SignedAuthorCatalogDirectoryNodeEnvelopeV1;
  const head = signHead({
    ...(headTemplate.payload as AuthorCatalogHeadV1),
    directoryRootDigest: directory.objectDigest as Digest32V1,
  });
  return {
    head,
    directoryPath: verifyAuthorCatalogDirectoryPathV1(
      head,
      [directory],
      '0' as DecimalU64V1,
    ),
  };
}

function validRow(value: unknown): AuthorCatalogRowV1 {
  assertAuthorCatalogRowV1(value);
  return value;
}

function validSeal(value: unknown): CanonicalGraphScopedAuthorSealV1 {
  assertCanonicalGraphScopedAuthorSealV1(value);
  return value;
}

function expectCandidateFailure(operation: () => unknown, code: string): void {
  try {
    operation();
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`expected ${code}`);
}
