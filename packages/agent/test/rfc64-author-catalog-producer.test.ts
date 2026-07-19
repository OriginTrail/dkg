import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';

import {
  AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
  AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1,
  KA_TRANSFER_CHUNK_SIZE_V1,
  KA_TRANSFER_CODEC_V1,
  KA_TRANSFER_PROJECTION_V1,
  MAX_DECIMAL_U64,
  ZERO_DIGEST32_V1,
  assertAuthorCatalogRowV1,
  assertSignedAuthorCatalogDirectoryNodeEnvelopeV1,
  assertSignedAuthorCatalogHeadEnvelopeV1,
  canonicalizeAuthorCatalogDirectoryNodePayloadBytesV1,
  catalogKeyToBucketIdV1,
  computeAuthorCatalogDirectoryNodeObjectDigestV1,
  computeAuthorCatalogHeadObjectDigestV1,
  computeAuthorCatalogScopeDigestV1,
  readVerifiedAuthorCatalogBucketDescriptorV1,
  verifyAuthorCatalogDirectoryPathV1,
  type AuthorCatalogBucketDescriptorV1,
  type AuthorCatalogChildDescriptorV1,
  type AuthorCatalogDirectoryNodeV1,
  type AuthorCatalogHeadV1,
  type AuthorCatalogRowV1,
  type AuthorCatalogScopeV1,
  type CountV1,
  type DecimalU64V1,
  type Digest32V1,
  type EvmAddressV1,
  type SignedAuthorCatalogDirectoryNodeEnvelopeV1,
  type SignedAuthorCatalogHeadEnvelopeV1,
  type SignedControlEnvelopeV1,
  type TimestampMsV1,
  type UnsignedControlEnvelopeV1,
} from '@origintrail-official/dkg-core';
import { verifyControlEnvelopeIssuerSignatureV1 } from '@origintrail-official/dkg-chain';

import {
  Rfc64AuthorCatalogProductionErrorV1,
  produceEmptyAuthorCatalogGenesisV1,
  produceSparseAuthorCatalogSuccessorV1,
  type Rfc64AuthorCatalogEip191SignerV1,
} from '../src/rfc64/author-catalog-producer.js';

const CATALOG_PRIVATE_KEY = `0x${'22'.repeat(32)}`;
const OTHER_PRIVATE_KEY = `0x${'33'.repeat(32)}`;
const AUTHOR = '0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a' as EvmAddressV1;
const CONTEXT_GRAPH_ID =
  '0x1111111111111111111111111111111111111111/catalog-production';
const GOVERNANCE_CONTRACT =
  '0x2222222222222222222222222222222222222222' as EvmAddressV1;
const DELEGATION_DIGEST = `0x${'66'.repeat(32)}` as Digest32V1;
const SEAL_DIGEST = `0x${'44'.repeat(32)}` as Digest32V1;

const catalogWallet = new ethers.Wallet(CATALOG_PRIVATE_KEY);
const otherWallet = new ethers.Wallet(OTHER_PRIVATE_KEY);

describe('RFC-64 author catalog producer', () => {
  it('produces a signed immutable empty genesis with canonical staging order', async () => {
    const produced = await produceEmptyAuthorCatalogGenesisV1({
      scope: scope('1'),
      catalogIssuerDelegationDigest: DELEGATION_DIGEST,
      issuedAt: '1700000000000' as TimestampMsV1,
      signer: signer(catalogWallet),
    });

    expect(produced.bucket).toBeNull();
    expect(produced.head.payload).toMatchObject({
      era: '0',
      version: '0',
      previousHeadDigest: null,
      bucketCount: '1',
      totalRows: '0',
      directoryHeight: '0',
    });
    expect(produced.directoryPath).toHaveLength(1);
    expect(produced.stagedObjects.map((object) => object.objectType)).toEqual([
      AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
      AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1,
    ]);
    const proof = verifyAuthorCatalogDirectoryPathV1(
      produced.head,
      produced.directoryPath,
      '0' as DecimalU64V1,
    );
    expect(readVerifiedAuthorCatalogBucketDescriptorV1(proof, produced.head)).toEqual({
      bucketDigest: ZERO_DIGEST32_V1,
      bucketId: '0',
      byteLength: '0',
      rowCount: '0',
    });
    expect(Object.isFrozen(produced)).toBe(true);
    expect(Object.isFrozen(produced.head.payload)).toBe(true);
    expect(Object.isFrozen(produced.directoryPath[0].payload.entries)).toBe(true);
    await expectAllSignatures(produced.stagedObjects);
  });

  it('adds one row by replacing one bucket, path, and constant-size head', async () => {
    const genesis = await emptyGenesis();
    const row = makeRow(1n, 'first');
    const produced = await produceSparseAuthorCatalogSuccessorV1({
      previousHead: genesis.head,
      previousDirectoryPath: genesis.directoryPath,
      previousBucket: null,
      selectedBucketId: '0' as DecimalU64V1,
      nextRows: [row],
      issuedAt: '1700000000001' as TimestampMsV1,
      signer: signer(catalogWallet),
    });

    expect(produced.bucket?.payload.rows).toEqual([row]);
    expect(produced.head.payload.version).toBe('1');
    expect(produced.head.payload.previousHeadDigest).toBe(genesis.head.objectDigest);
    expect(produced.head.payload.totalRows).toBe('1');
    expect(produced.stagedObjects.map((object) => object.objectType)).toEqual([
      'AuthorCatalogBucketV1',
      'AuthorCatalogDirectoryNodeV1',
      'AuthorCatalogHeadV1',
    ]);
    const proof = verifyAuthorCatalogDirectoryPathV1(
      produced.head,
      produced.directoryPath,
      '0' as DecimalU64V1,
    );
    expect(readVerifiedAuthorCatalogBucketDescriptorV1(proof, produced.head))
      .toMatchObject({ bucketDigest: produced.bucket?.objectDigest, rowCount: '1' });
    await expectAllSignatures(produced.stagedObjects);
  });

  it('rebuilds only one leaf-to-root path in a two-level 512-bucket catalog', async () => {
    const selectedBucketId = '300' as DecimalU64V1;
    const previous = await twoLevelEmptyCatalog(selectedBucketId);
    const unchangedSibling = previous.path[0].payload.entries[0];
    const row = rowForBucket(selectedBucketId, '512' as CountV1, 1n, 'bucket-300');

    const produced = await produceSparseAuthorCatalogSuccessorV1({
      previousHead: previous.head,
      previousDirectoryPath: previous.path,
      previousBucket: null,
      selectedBucketId,
      nextRows: [row],
      issuedAt: '1700000000100' as TimestampMsV1,
      signer: signer(catalogWallet),
    });

    expect(produced.directoryPath).toHaveLength(2);
    expect(produced.stagedObjects.map((object) => object.objectType)).toEqual([
      'AuthorCatalogBucketV1',
      'AuthorCatalogDirectoryNodeV1',
      'AuthorCatalogDirectoryNodeV1',
      'AuthorCatalogHeadV1',
    ]);
    expect(produced.directoryPath[0].payload.entries[0]).toEqual(unchangedSibling);
    expect(produced.directoryPath[0].payload.entries[1]).toMatchObject({ rowCount: '1' });
    expect(produced.head.payload.totalRows).toBe('1');
    expect(produced.head.payload.version).toBe('8');
    await expectAllSignatures(produced.stagedObjects);
  });

  it('keeps a sparse update bounded at the maximum eight-node directory height', async () => {
    const bucketCount = (1n << 63n).toString() as CountV1;
    const row = makeRow(77n, 'maximum-height');
    const selectedBucketId = catalogKeyToBucketIdV1(row.kaId, bucketCount);
    const previous = await maximumHeightEmptyCatalog(selectedBucketId);

    const produced = await produceSparseAuthorCatalogSuccessorV1({
      previousHead: previous.head,
      previousDirectoryPath: previous.path,
      previousBucket: null,
      selectedBucketId,
      nextRows: [row],
      issuedAt: '1700000000200' as TimestampMsV1,
      signer: signer(catalogWallet),
    });

    expect(produced.directoryPath).toHaveLength(8);
    expect(produced.stagedObjects).toHaveLength(10);
    expect(produced.stagedObjects[0].objectType).toBe('AuthorCatalogBucketV1');
    expect(produced.stagedObjects.at(-1)?.objectType).toBe('AuthorCatalogHeadV1');
    expect(produced.head.payload).toMatchObject({
      bucketCount,
      directoryHeight: '7',
      totalRows: '1',
      version: '1',
    });
    await expectAllSignatures(produced.stagedObjects);
  });

  it('removes the last selected row through a canonical empty descriptor', async () => {
    const selectedBucketId = '300' as DecimalU64V1;
    const previous = await twoLevelEmptyCatalog(selectedBucketId);
    const row = rowForBucket(selectedBucketId, '512' as CountV1, 1n, 'bucket-300');
    const populated = await produceSparseAuthorCatalogSuccessorV1({
      previousHead: previous.head,
      previousDirectoryPath: previous.path,
      previousBucket: null,
      selectedBucketId,
      nextRows: [row],
      issuedAt: '1700000000100' as TimestampMsV1,
      signer: signer(catalogWallet),
    });

    const removed = await produceSparseAuthorCatalogSuccessorV1({
      previousHead: populated.head,
      previousDirectoryPath: populated.directoryPath,
      previousBucket: populated.bucket,
      selectedBucketId,
      nextRows: [],
      issuedAt: '1700000000101' as TimestampMsV1,
      signer: signer(catalogWallet),
    });

    expect(removed.bucket).toBeNull();
    expect(removed.head.payload.totalRows).toBe('0');
    expect(removed.head.payload.version).toBe('9');
    expect(removed.stagedObjects.map((object) => object.objectType)).toEqual([
      'AuthorCatalogDirectoryNodeV1',
      'AuthorCatalogDirectoryNodeV1',
      'AuthorCatalogHeadV1',
    ]);
    const proof = verifyAuthorCatalogDirectoryPathV1(
      removed.head,
      removed.directoryPath,
      selectedBucketId,
    );
    expect(readVerifiedAuthorCatalogBucketDescriptorV1(proof, removed.head))
      .toMatchObject({ bucketDigest: ZERO_DIGEST32_V1, rowCount: '0', byteLength: '0' });
  });

  it('snapshots rows and the previous path before invoking the signer', async () => {
    const genesis = await emptyGenesis();
    const originalRow = makeRow(1n, 'stable');
    const rows = [originalRow];
    const path = Array.from(genesis.directoryPath);
    let calls = 0;
    const mutatingSigner: Rfc64AuthorCatalogEip191SignerV1 = {
      issuer: catalogWallet.address.toLowerCase() as EvmAddressV1,
      signDigest: async (digest) => {
        calls += 1;
        if (calls === 1) {
          rows[0] = makeRow(2n, 'switched');
          path.length = 0;
        }
        return catalogWallet.signMessage(digest);
      },
    };

    const produced = await produceSparseAuthorCatalogSuccessorV1({
      previousHead: genesis.head,
      previousDirectoryPath: path,
      previousBucket: null,
      selectedBucketId: '0' as DecimalU64V1,
      nextRows: rows,
      issuedAt: '1700000000001' as TimestampMsV1,
      signer: mutatingSigner,
    });

    expect(produced.bucket?.payload.rows).toEqual([originalRow]);
    expect(produced.directoryPath).toHaveLength(1);
  });

  it('reads adversarial path and row array lengths exactly once', async () => {
    const genesis = await emptyGenesis();
    const row = makeRow(1n, 'stable');
    let pathLengthReads = 0;
    let rowLengthReads = 0;
    const path = new Proxy(Array.from(genesis.directoryPath), {
      get(target, property, receiver) {
        if (property === 'length') {
          pathLengthReads += 1;
          return pathLengthReads === 1 ? 1 : 0;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const rows = new Proxy([row], {
      get(target, property, receiver) {
        if (property === 'length') {
          rowLengthReads += 1;
          return rowLengthReads === 1 ? 1 : 0;
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const produced = await produceSparseAuthorCatalogSuccessorV1({
      previousHead: genesis.head,
      previousDirectoryPath: path,
      previousBucket: null,
      selectedBucketId: '0' as DecimalU64V1,
      nextRows: rows,
      issuedAt: '1700000000001' as TimestampMsV1,
      signer: signer(catalogWallet),
    });

    expect(produced.bucket?.payload.rows).toEqual([row]);
    expect(pathLengthReads).toBe(1);
    expect(rowLengthReads).toBe(1);
  });

  it('rejects no-op successors and rows assigned to a different bucket', async () => {
    const genesis = await emptyGenesis();
    const row = makeRow(1n, 'first');
    const populated = await produceSparseAuthorCatalogSuccessorV1({
      previousHead: genesis.head,
      previousDirectoryPath: genesis.directoryPath,
      previousBucket: null,
      selectedBucketId: '0' as DecimalU64V1,
      nextRows: [row],
      issuedAt: '1700000000001' as TimestampMsV1,
      signer: signer(catalogWallet),
    });

    let noOpSignCalls = 0;
    await expect(produceSparseAuthorCatalogSuccessorV1({
      previousHead: populated.head,
      previousDirectoryPath: populated.directoryPath,
      previousBucket: populated.bucket,
      selectedBucketId: '0' as DecimalU64V1,
      nextRows: [row],
      issuedAt: '1700000000002' as TimestampMsV1,
      signer: {
        issuer: catalogWallet.address.toLowerCase() as EvmAddressV1,
        signDigest: (digest) => {
          noOpSignCalls += 1;
          return catalogWallet.signMessage(digest);
        },
      },
    })).rejects.toMatchObject({ code: 'catalog-production-noop' });
    expect(noOpSignCalls).toBe(0);

    const previous = await twoLevelEmptyCatalog('300' as DecimalU64V1);
    const wrongRow = rowForBucket('301' as DecimalU64V1, '512' as CountV1, 1n, 'wrong');
    await expect(produceSparseAuthorCatalogSuccessorV1({
      previousHead: previous.head,
      previousDirectoryPath: previous.path,
      previousBucket: null,
      selectedBucketId: '300' as DecimalU64V1,
      nextRows: [wrongRow],
      issuedAt: '1700000000100' as TimestampMsV1,
      signer: signer(catalogWallet),
    })).rejects.toMatchObject({ code: 'catalog-production-input' });
  });

  it('requires the exact prior bucket and permits only one KA delta per head', async () => {
    const genesis = await emptyGenesis();
    const row1 = makeRow(1n, 'first');
    const row2 = makeRow(2n, 'second');

    await expect(produceSparseAuthorCatalogSuccessorV1({
      previousHead: genesis.head,
      previousDirectoryPath: genesis.directoryPath,
      previousBucket: null,
      selectedBucketId: '0' as DecimalU64V1,
      nextRows: [row1, row2],
      issuedAt: '1700000000001' as TimestampMsV1,
      signer: signer(catalogWallet),
    })).rejects.toMatchObject({ code: 'catalog-production-delta' });

    const oneRow = await produceSparseAuthorCatalogSuccessorV1({
      previousHead: genesis.head,
      previousDirectoryPath: genesis.directoryPath,
      previousBucket: null,
      selectedBucketId: '0' as DecimalU64V1,
      nextRows: [row1],
      issuedAt: '1700000000001' as TimestampMsV1,
      signer: signer(catalogWallet),
    });
    await expect(produceSparseAuthorCatalogSuccessorV1({
      previousHead: oneRow.head,
      previousDirectoryPath: oneRow.directoryPath,
      previousBucket: null,
      selectedBucketId: '0' as DecimalU64V1,
      nextRows: [row1, row2],
      issuedAt: '1700000000002' as TimestampMsV1,
      signer: signer(catalogWallet),
    })).rejects.toMatchObject({ code: 'catalog-production-path' });

    const twoRows = await produceSparseAuthorCatalogSuccessorV1({
      previousHead: oneRow.head,
      previousDirectoryPath: oneRow.directoryPath,
      previousBucket: oneRow.bucket,
      selectedBucketId: '0' as DecimalU64V1,
      nextRows: [row1, row2],
      issuedAt: '1700000000002' as TimestampMsV1,
      signer: signer(catalogWallet),
    });
    await expect(produceSparseAuthorCatalogSuccessorV1({
      previousHead: twoRows.head,
      previousDirectoryPath: twoRows.directoryPath,
      previousBucket: twoRows.bucket,
      selectedBucketId: '0' as DecimalU64V1,
      nextRows: [],
      issuedAt: '1700000000003' as TimestampMsV1,
      signer: signer(catalogWallet),
    })).rejects.toMatchObject({ code: 'catalog-production-delta' });
  });

  it('requires a one-step assertion version and stable coordinate for row replacement', async () => {
    const genesis = await emptyGenesis();
    const rowV1 = makeRow(1n, 'stable', '1', 0);
    const oneRow = await produceSparseAuthorCatalogSuccessorV1({
      previousHead: genesis.head,
      previousDirectoryPath: genesis.directoryPath,
      previousBucket: null,
      selectedBucketId: '0' as DecimalU64V1,
      nextRows: [rowV1],
      issuedAt: '1700000000001' as TimestampMsV1,
      signer: signer(catalogWallet),
    });
    const rowV2 = makeRow(1n, 'stable', '2', 1);
    const updated = await produceSparseAuthorCatalogSuccessorV1({
      previousHead: oneRow.head,
      previousDirectoryPath: oneRow.directoryPath,
      previousBucket: oneRow.bucket,
      selectedBucketId: '0' as DecimalU64V1,
      nextRows: [rowV2],
      issuedAt: '1700000000002' as TimestampMsV1,
      signer: signer(catalogWallet),
    });
    expect(updated.bucket?.payload.rows).toEqual([rowV2]);
    expect(updated.head.payload.totalRows).toBe('1');

    await expect(produceSparseAuthorCatalogSuccessorV1({
      previousHead: updated.head,
      previousDirectoryPath: updated.directoryPath,
      previousBucket: updated.bucket,
      selectedBucketId: '0' as DecimalU64V1,
      nextRows: [makeRow(1n, 'changed-coordinate', '3', 2)],
      issuedAt: '1700000000003' as TimestampMsV1,
      signer: signer(catalogWallet),
    })).rejects.toMatchObject({ code: 'catalog-production-delta' });

    await expect(produceSparseAuthorCatalogSuccessorV1({
      previousHead: updated.head,
      previousDirectoryPath: updated.directoryPath,
      previousBucket: updated.bucket,
      selectedBucketId: '0' as DecimalU64V1,
      nextRows: [makeRow(1n, 'stable', '4', 2)],
      issuedAt: '1700000000003' as TimestampMsV1,
      signer: signer(catalogWallet),
    })).rejects.toMatchObject({ code: 'catalog-production-delta' });
  });

  it('fails closed on an invalid predecessor or a signer for another issuer', async () => {
    const genesis = await emptyGenesis();
    const row = makeRow(1n, 'first');
    const forgedHead = {
      ...genesis.head,
      signature: await otherWallet.signMessage(ethers.getBytes(genesis.head.objectDigest)),
    } as SignedAuthorCatalogHeadEnvelopeV1;

    await expect(produceSparseAuthorCatalogSuccessorV1({
      previousHead: forgedHead,
      previousDirectoryPath: genesis.directoryPath,
      previousBucket: null,
      selectedBucketId: '0' as DecimalU64V1,
      nextRows: [row],
      issuedAt: '1700000000001' as TimestampMsV1,
      signer: signer(catalogWallet),
    })).rejects.toMatchObject({ code: 'catalog-production-history' });

    await expect(produceSparseAuthorCatalogSuccessorV1({
      previousHead: genesis.head,
      previousDirectoryPath: genesis.directoryPath,
      previousBucket: null,
      selectedBucketId: '0' as DecimalU64V1,
      nextRows: [row],
      issuedAt: '1700000000001' as TimestampMsV1,
      signer: {
        issuer: catalogWallet.address.toLowerCase() as EvmAddressV1,
        signDigest: (digest) => otherWallet.signMessage(digest),
      },
    })).rejects.toMatchObject({ code: 'catalog-production-signer' });
  });

  it('rejects ordinary history overflow before producing a successor head', async () => {
    const previous = await twoLevelEmptyCatalog(
      '300' as DecimalU64V1,
      MAX_DECIMAL_U64.toString() as DecimalU64V1,
    );
    const row = rowForBucket('300' as DecimalU64V1, '512' as CountV1, 1n, 'overflow');
    await expect(produceSparseAuthorCatalogSuccessorV1({
      previousHead: previous.head,
      previousDirectoryPath: previous.path,
      previousBucket: null,
      selectedBucketId: '300' as DecimalU64V1,
      nextRows: [row],
      issuedAt: '1700000000100' as TimestampMsV1,
      signer: signer(catalogWallet),
    })).rejects.toMatchObject({ code: 'catalog-production-history' });
  });

  it('uses a closed typed error registry', () => {
    const error = new Rfc64AuthorCatalogProductionErrorV1(
      'catalog-production-input',
      'fixture',
    );
    expect(error).toMatchObject({
      name: 'Rfc64AuthorCatalogProductionErrorV1',
      code: 'catalog-production-input',
    });
    expect(() => new Rfc64AuthorCatalogProductionErrorV1(
      'not-a-production-code' as never,
      'fixture',
    )).toThrow(TypeError);
  });
});

async function emptyGenesis() {
  return produceEmptyAuthorCatalogGenesisV1({
    scope: scope('1'),
    catalogIssuerDelegationDigest: DELEGATION_DIGEST,
    issuedAt: '1700000000000' as TimestampMsV1,
    signer: signer(catalogWallet),
  });
}

function signer(wallet: ethers.Wallet): Rfc64AuthorCatalogEip191SignerV1 {
  return {
    issuer: wallet.address.toLowerCase() as EvmAddressV1,
    signDigest: (digest) => wallet.signMessage(digest),
  };
}

function scope(bucketCount: string): AuthorCatalogScopeV1 {
  return {
    networkId: 'otp:20430',
    contextGraphId: CONTEXT_GRAPH_ID,
    governanceChainId: '20430',
    governanceContractAddress: GOVERNANCE_CONTRACT,
    ownershipTransitionDigest: null,
    subGraphName: null,
    authorAddress: AUTHOR,
    era: '0',
    bucketCount,
  } as AuthorCatalogScopeV1;
}

function makeRow(
  number: bigint,
  assertionCoordinate: string,
  assertionVersion = '1',
  variant = 0,
): AuthorCatalogRowV1 {
  const projectionDigest = digest(Number(number % 1000n) + 1000 + variant * 10_000);
  const row = {
    kaId: ((BigInt(AUTHOR) << 96n) | number).toString(),
    assertionCoordinate,
    assertionVersion,
    projectionId: KA_TRANSFER_PROJECTION_V1,
    projectionDigest,
    sealDigest: SEAL_DIGEST,
    transfer: {
      codec: KA_TRANSFER_CODEC_V1,
      projectionId: KA_TRANSFER_PROJECTION_V1,
      projectionDigest,
      byteLength: '16',
      chunkSize: KA_TRANSFER_CHUNK_SIZE_V1,
      chunkCount: '1',
      blobDigest: digest(Number(number % 1000n) + 2000 + variant * 10_000),
      chunkTreeRoot: digest(Number(number % 1000n) + 3000 + variant * 10_000),
    },
  } as unknown as AuthorCatalogRowV1;
  assertAuthorCatalogRowV1(row);
  return row;
}

function rowForBucket(
  bucketId: DecimalU64V1,
  bucketCount: CountV1,
  start: bigint,
  coordinate: string,
): AuthorCatalogRowV1 {
  for (let number = start; number < start + 1_000_000n; number += 1n) {
    const row = makeRow(number, coordinate);
    if (catalogKeyToBucketIdV1(row.kaId, bucketCount) === bucketId) return row;
  }
  throw new Error(`unable to find a row for bucket ${bucketId}`);
}

async function twoLevelEmptyCatalog(
  selectedBucketId: DecimalU64V1,
  version: DecimalU64V1 = '7' as DecimalU64V1,
): Promise<{
  readonly head: SignedAuthorCatalogHeadEnvelopeV1;
  readonly path: readonly SignedAuthorCatalogDirectoryNodeEnvelopeV1[];
}> {
  const catalogScope = scope('512');
  const scopeDigest = computeAuthorCatalogScopeDigestV1(catalogScope);
  const leafFirst = 256n;
  const leafPayload: AuthorCatalogDirectoryNodeV1 = {
    catalogScopeDigest: scopeDigest,
    entries: emptyDescriptors(256, leafFirst),
    era: '0' as DecimalU64V1,
    firstBucketId: leafFirst.toString() as DecimalU64V1,
    level: '0' as DecimalU64V1,
  };
  const leaf = await signedDirectory(leafPayload, '512' as CountV1);
  const leafBytes = canonicalizeAuthorCatalogDirectoryNodePayloadBytesV1(
    leaf.payload,
    '512' as CountV1,
  ).byteLength;
  const rootPayload: AuthorCatalogDirectoryNodeV1 = {
    catalogScopeDigest: scopeDigest,
    entries: [
      {
        firstBucketId: '0' as DecimalU64V1,
        bucketSpan: '256' as CountV1,
        rowCount: '0' as CountV1,
        byteLength: '1' as CountV1,
        childDigest: digest(99),
      },
      {
        firstBucketId: '256' as DecimalU64V1,
        bucketSpan: '256' as CountV1,
        rowCount: '0' as CountV1,
        byteLength: leafBytes.toString() as CountV1,
        childDigest: leaf.objectDigest as Digest32V1,
      },
    ] satisfies readonly AuthorCatalogChildDescriptorV1[],
    era: '0' as DecimalU64V1,
    firstBucketId: '0' as DecimalU64V1,
    level: '1' as DecimalU64V1,
  };
  const root = await signedDirectory(rootPayload, '512' as CountV1);
  const headPayload = {
    networkId: catalogScope.networkId,
    contextGraphId: catalogScope.contextGraphId,
    governanceChainId: catalogScope.governanceChainId,
    governanceContractAddress: catalogScope.governanceContractAddress,
    ownershipTransitionDigest: catalogScope.ownershipTransitionDigest,
    subGraphName: catalogScope.subGraphName,
    authorAddress: catalogScope.authorAddress,
    catalogIssuerDelegationDigest: DELEGATION_DIGEST,
    era: catalogScope.era,
    version,
    previousHeadDigest: digest(98),
    bucketCount: catalogScope.bucketCount,
    totalRows: '0' as CountV1,
    directoryHeight: '1' as DecimalU64V1,
    directoryRootDigest: root.objectDigest as Digest32V1,
    issuedAt: '1700000000000' as TimestampMsV1,
  } satisfies AuthorCatalogHeadV1;
  const head = await signedHead(headPayload);
  verifyAuthorCatalogDirectoryPathV1(head, [root, leaf], selectedBucketId);
  return { head, path: [root, leaf] };
}

async function maximumHeightEmptyCatalog(
  selectedBucketId: DecimalU64V1,
): Promise<{
  readonly head: SignedAuthorCatalogHeadEnvelopeV1;
  readonly path: readonly SignedAuthorCatalogDirectoryNodeEnvelopeV1[];
}> {
  const bucketCount = 1n << 63n;
  const bucketCountWire = bucketCount.toString() as CountV1;
  const catalogScope = scope(bucketCountWire);
  const scopeDigest = computeAuthorCatalogScopeDigestV1(catalogScope);
  const selected = BigInt(selectedBucketId);
  const leafFirst = (selected / 256n) * 256n;
  const leafCoverage = minimum(256n, bucketCount - leafFirst);
  let child = await signedDirectory({
    catalogScopeDigest: scopeDigest,
    entries: emptyDescriptors(Number(leafCoverage), leafFirst),
    era: '0' as DecimalU64V1,
    firstBucketId: leafFirst.toString() as DecimalU64V1,
    level: '0' as DecimalU64V1,
  }, bucketCountWire);
  const leafToRoot = [child];

  for (let level = 1n; level <= 7n; level += 1n) {
    const entryWidth = 256n ** level;
    const nodeWidth = entryWidth * 256n;
    const firstBucketId = (selected / nodeWidth) * nodeWidth;
    const coverage = minimum(nodeWidth, bucketCount - firstBucketId);
    const entryCount = Number((coverage + entryWidth - 1n) / entryWidth);
    const selectedIndex = Number(
      (BigInt(child.payload.firstBucketId) - firstBucketId) / entryWidth,
    );
    const childBytes = canonicalizeAuthorCatalogDirectoryNodePayloadBytesV1(
      child.payload,
      bucketCountWire,
    ).byteLength;
    const entries = new Array<AuthorCatalogChildDescriptorV1>(entryCount);
    for (let index = 0; index < entryCount; index += 1) {
      const entryFirst = firstBucketId + BigInt(index) * entryWidth;
      entries[index] = {
        firstBucketId: entryFirst.toString() as DecimalU64V1,
        bucketSpan: minimum(entryWidth, bucketCount - entryFirst).toString() as CountV1,
        rowCount: '0' as CountV1,
        byteLength: (index === selectedIndex ? childBytes.toString() : '1') as CountV1,
        childDigest: index === selectedIndex
          ? child.objectDigest as Digest32V1
          : digest(Number(level) * 1000 + index + 10_000),
      };
    }
    child = await signedDirectory({
      catalogScopeDigest: scopeDigest,
      entries,
      era: '0' as DecimalU64V1,
      firstBucketId: firstBucketId.toString() as DecimalU64V1,
      level: level.toString() as DecimalU64V1,
    }, bucketCountWire);
    leafToRoot.push(child);
  }
  const path = leafToRoot.reverse();
  const head = await signedHead({
    networkId: catalogScope.networkId,
    contextGraphId: catalogScope.contextGraphId,
    governanceChainId: catalogScope.governanceChainId,
    governanceContractAddress: catalogScope.governanceContractAddress,
    ownershipTransitionDigest: catalogScope.ownershipTransitionDigest,
    subGraphName: catalogScope.subGraphName,
    authorAddress: catalogScope.authorAddress,
    catalogIssuerDelegationDigest: DELEGATION_DIGEST,
    era: catalogScope.era,
    version: '0' as DecimalU64V1,
    previousHeadDigest: null,
    bucketCount: bucketCountWire,
    totalRows: '0' as CountV1,
    directoryHeight: '7' as DecimalU64V1,
    directoryRootDigest: path[0].objectDigest as Digest32V1,
    issuedAt: '1700000000000' as TimestampMsV1,
  });
  verifyAuthorCatalogDirectoryPathV1(head, path, selectedBucketId);
  return { head, path };
}

async function signedDirectory(
  payload: AuthorCatalogDirectoryNodeV1,
  bucketCount: CountV1,
): Promise<SignedAuthorCatalogDirectoryNodeEnvelopeV1> {
  const unsigned = {
    issuer: catalogWallet.address.toLowerCase(),
    objectType: AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
    payload,
    signatureEvidence: { kind: 'none' },
    signatureSuite: 'eip191-personal-sign-digest-v1',
  } as UnsignedControlEnvelopeV1;
  const objectDigest = computeAuthorCatalogDirectoryNodeObjectDigestV1(unsigned, bucketCount);
  const signed = {
    ...unsigned,
    objectDigest,
    signature: await catalogWallet.signMessage(ethers.getBytes(objectDigest)),
  } as SignedControlEnvelopeV1;
  assertSignedAuthorCatalogDirectoryNodeEnvelopeV1(signed, bucketCount);
  return signed as SignedAuthorCatalogDirectoryNodeEnvelopeV1;
}

async function signedHead(payload: AuthorCatalogHeadV1): Promise<SignedAuthorCatalogHeadEnvelopeV1> {
  const unsigned = {
    issuer: catalogWallet.address.toLowerCase(),
    objectType: AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1,
    payload,
    signatureEvidence: { kind: 'none' },
    signatureSuite: 'eip191-personal-sign-digest-v1',
  } as UnsignedControlEnvelopeV1;
  const objectDigest = computeAuthorCatalogHeadObjectDigestV1(unsigned);
  const signed = {
    ...unsigned,
    objectDigest,
    signature: await catalogWallet.signMessage(ethers.getBytes(objectDigest)),
  } as SignedControlEnvelopeV1;
  assertSignedAuthorCatalogHeadEnvelopeV1(signed);
  return signed as SignedAuthorCatalogHeadEnvelopeV1;
}

function emptyDescriptors(
  count: number,
  firstBucketId: bigint,
): AuthorCatalogBucketDescriptorV1[] {
  return Array.from({ length: count }, (_, index) => ({
    bucketDigest: ZERO_DIGEST32_V1,
    bucketId: (firstBucketId + BigInt(index)).toString() as DecimalU64V1,
    byteLength: '0' as CountV1,
    rowCount: '0' as CountV1,
  }));
}

async function expectAllSignatures(objects: readonly SignedControlEnvelopeV1[]): Promise<void> {
  for (const object of objects) {
    await expect(verifyControlEnvelopeIssuerSignatureV1(object)).resolves.toBeDefined();
  }
}

function digest(value: number): Digest32V1 {
  return `0x${value.toString(16).padStart(64, '0')}` as Digest32V1;
}

function minimum(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}
