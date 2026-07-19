import { mkdir, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import {
  computeControlObjectDigestHex,
  type AuthorCatalogScopeV1,
  type DecimalU64V1,
  type Digest32V1,
  type EvmAddressV1,
  type SignedControlEnvelopeV1,
  type TimestampMsV1,
  type UnsignedControlEnvelopeV1,
} from '@origintrail-official/dkg-core';
import {
  EIP1271_CANONICAL_ABI_RETURN_V1,
  verifyControlEnvelopeIssuerSignatureV1,
  type CurrentFinalizedEvmCallV1,
  type VerifiedControlEnvelopeIssuerSignatureV1,
} from '@origintrail-official/dkg-chain';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  RFC64_CONTROL_OBJECT_STORE_DIRECTORY_MODE,
  RFC64_CONTROL_OBJECT_STORE_ERROR_CODES_V1,
  RFC64_CONTROL_OBJECT_STORE_FILE_MODE,
  RFC64_CONTROL_OBJECT_STORE_MAX_SIGNATURE_VARIANTS_PER_OBJECT,
  RFC64_CONTROL_OBJECT_STORE_MAX_STAGE_OBJECTS,
  RFC64_CONTROL_OBJECT_STORE_POSIX_NAMESPACE_DURABILITY,
  RFC64_CONTROL_OBJECT_STORE_WINDOWS_NAMESPACE_DURABILITY,
  Rfc64ControlObjectStoreErrorV1,
  type StageVerifiedControlObjectV1,
} from '../src/rfc64/control-object-store-v1.js';
import { produceEmptyAuthorCatalogGenesisV1 } from '../src/rfc64/author-catalog-producer.js';
import { applyRfc64OwnerOnlyPermissionsSyncV1 } from '../src/rfc64/secure-filesystem-policy-v1.js';
import {
  createRfc64ControlObjectStoreTestOpenerV1,
  type Rfc64ControlObjectStoreDurabilityBoundaryV1,
} from './support/rfc64-control-object-store-test-support.js';
import {
  createTemporaryDataDirectoryFixture,
  deferred,
  ISSUER,
  pathsFor,
  signedFixture,
  wallet,
} from './support/rfc64-control-object-store-fixtures.js';

const SAFE = '0x3333333333333333333333333333333333333333' as EvmAddressV1;
const BLOCK_HASH = `0x${'44'.repeat(32)}` as Digest32V1;
const openRfc64ControlObjectStoreV1 = createRfc64ControlObjectStoreTestOpenerV1();
const temporaryDirectories = createTemporaryDataDirectoryFixture();
const { temporaryDataDirectory } = temporaryDirectories;

afterEach(async () => {
  await temporaryDirectories.cleanup();
});

const finalizedEip1271Call: CurrentFinalizedEvmCallV1 = async (request) => ({
  chainId: request.chainId,
  blockNumber: '123' as DecimalU64V1,
  blockHash: BLOCK_HASH,
  returnData: EIP1271_CANONICAL_ABI_RETURN_V1,
});

async function contractSignatureVariantsFixture(): Promise<
  readonly [StageVerifiedControlObjectV1, StageVerifiedControlObjectV1]
> {
  const variants = await contractSignatureVariantBatchFixture(2, 'variants');
  return [variants[0]!, variants[1]!];
}

async function contractSignatureVariantBatchFixture(
  count: number,
  sequence: string,
): Promise<readonly StageVerifiedControlObjectV1[]> {
  const unsigned = {
    issuer: SAFE,
    objectType: 'dkg-rfc64-control-store-contract-test-v1',
    payload: { sequence },
    signatureEvidence: {
      kind: 'eip1271-current-finalized',
      chainId: '20430',
      contractAddress: SAFE,
    },
    signatureSuite: 'eip1271-current-finalized-v1',
  } satisfies UnsignedControlEnvelopeV1;
  const objectDigest = computeControlObjectDigestHex(unsigned);
  const envelopes = Array.from({ length: count }, (_, index) => ({
    ...unsigned,
    objectDigest,
    signature: `0x${(index + 1).toString(16).padStart(4, '0')}`,
  } as SignedControlEnvelopeV1));
  const proofs = await Promise.all(envelopes.map((envelope) =>
    verifyControlEnvelopeIssuerSignatureV1(envelope, {
      callEvmAtCurrentFinalized: finalizedEip1271Call,
    })));
  return Object.freeze(envelopes.map((envelope, index) => Object.freeze({
    envelope,
    issuerSignature: proofs[index],
  })));
}

describe('RFC-64 durable control-object store v1', () => {
  it('rechecks NODE_ENV when the source-level test opener is invoked', async () => {
    const opener = createRfc64ControlObjectStoreTestOpenerV1();
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(opener(await temporaryDataDirectory())).rejects.toMatchObject({
        code: 'control-store-input',
      });
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it('durably splits unsigned object bytes from a detached signature and reverifies reads', async () => {
    const dataDir = await temporaryDataDirectory();
    const store = await openRfc64ControlObjectStoreV1(dataDir);
    const fixture = await signedFixture('1');
    const result = await store.stageVerifiedObjects([fixture]);

    expect(store).not.toHaveProperty('operations');
    expect(result).toEqual({
      durable: true,
      namespaceDurability: process.platform === 'win32'
        ? RFC64_CONTROL_OBJECT_STORE_WINDOWS_NAMESPACE_DURABILITY
        : RFC64_CONTROL_OBJECT_STORE_POSIX_NAMESPACE_DURABILITY,
      objects: [{
        objectDigest: fixture.envelope.objectDigest,
        signatureVariantDigest: pathsFor(dataDir, fixture.envelope).signatureDigest,
      }],
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.objects)).toBe(true);
    expect(store.namespaceDurability).toBe(result.namespaceDurability);

    const paths = pathsFor(dataDir, fixture.envelope);
    const unsigned = JSON.parse(await readFile(paths.object, 'utf8')) as Record<string, unknown>;
    const signature = JSON.parse(await readFile(paths.signature, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(unsigned).sort()).toEqual([
      'issuer',
      'objectType',
      'payload',
      'signatureEvidence',
      'signatureSuite',
    ]);
    expect(unsigned).not.toHaveProperty('objectDigest');
    expect(unsigned).not.toHaveProperty('signature');
    expect(signature).toEqual({
      objectDigest: fixture.envelope.objectDigest,
      signature: fixture.envelope.signature,
      signatureVariantDigest: paths.signatureDigest,
    });

    const verifyIssuerSignature = vi.fn(verifyControlEnvelopeIssuerSignatureV1);
    const loaded = await store.getVerifiedObject({
      objectDigest: fixture.envelope.objectDigest as Digest32V1,
      signatureVariantDigest: paths.signatureDigest,
      verifyIssuerSignature,
    });
    expect(verifyIssuerSignature).toHaveBeenCalledTimes(1);
    expect(loaded?.envelope).toEqual(fixture.envelope);
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded?.envelope)).toBe(true);

    if (process.platform !== 'win32') {
      expect((await stat(paths.root)).mode & 0o777)
        .toBe(RFC64_CONTROL_OBJECT_STORE_DIRECTORY_MODE);
      expect((await stat(paths.object)).mode & 0o777)
        .toBe(RFC64_CONTROL_OBJECT_STORE_FILE_MODE);
      expect((await stat(paths.signature)).mode & 0o777)
        .toBe(RFC64_CONTROL_OBJECT_STORE_FILE_MODE);
    }
  });

  it('stages an ordered author-catalog candidate without granting head-ref authority', async () => {
    const dataDir = await temporaryDataDirectory();
    const store = await openRfc64ControlObjectStoreV1(dataDir);
    const produced = await produceEmptyAuthorCatalogGenesisV1({
      scope: {
        networkId: 'otp:20430',
        contextGraphId: '0x1111111111111111111111111111111111111111/store-integration',
        governanceChainId: '20430',
        governanceContractAddress: '0x2222222222222222222222222222222222222222',
        ownershipTransitionDigest: null,
        subGraphName: null,
        authorAddress: ISSUER,
        era: '0',
        bucketCount: '1',
      } as AuthorCatalogScopeV1,
      catalogIssuerDelegationDigest: `0x${'66'.repeat(32)}` as Digest32V1,
      issuedAt: '1700000000000' as TimestampMsV1,
      signer: {
        issuer: ISSUER,
        signDigest: (digest) => wallet.signMessage(digest),
      },
    });
    const stageInput = await Promise.all(produced.stagedObjects.map(async (envelope) => ({
      envelope,
      issuerSignature: await verifyControlEnvelopeIssuerSignatureV1(envelope),
    })));

    const result = await store.stageVerifiedObjects(stageInput);
    expect(result.durable).toBe(true);
    expect(result.objects.map((item) => item.objectDigest)).toEqual(
      produced.stagedObjects.map((item) => item.objectDigest),
    );
    expect(store).not.toHaveProperty('currentHead');
    expect(store).not.toHaveProperty('advanceHead');
  });

  it('converges concurrent staging through durable no-replace keys', async () => {
    const dataDir = await temporaryDataDirectory();
    const boundaries: Rfc64ControlObjectStoreDurabilityBoundaryV1[] = [];
    const objectTempsReady = deferred();
    const signatureTempsReady = deferred();
    let objectTempsFsynced = 0;
    let signatureTempsFsynced = 0;
    const store = await createRfc64ControlObjectStoreTestOpenerV1({
      boundary: async (boundary) => {
        boundaries.push(boundary);
        // Make both callers reach each immutable-key collision before either
        // may publish. Without this rendezvous, a slower platform may validly
        // let the second call reconcile the winner before allocating a temp.
        if (boundary === 'object.temp-fsynced') {
          objectTempsFsynced += 1;
          if (objectTempsFsynced === 2) objectTempsReady.resolve();
          await objectTempsReady.promise;
        }
        if (boundary === 'signature.temp-fsynced') {
          signatureTempsFsynced += 1;
          if (signatureTempsFsynced === 2) signatureTempsReady.resolve();
          await signatureTempsReady.promise;
        }
      },
    })(dataDir);
    const fixture = await signedFixture('2');
    boundaries.length = 0;
    await Promise.all([
      store.stageVerifiedObjects([fixture]),
      store.stageVerifiedObjects([fixture]),
    ]);
    const expectedBoundaries: Rfc64ControlObjectStoreDurabilityBoundaryV1[] = [
      'directory.created',
      'directory.mode-secured',
      'directory.self-fsynced',
      'directory.parent-fsynced',
      'object.temp-written',
      'object.temp-mode-secured',
      'object.temp-fsynced',
      'object.temp-written',
      'object.temp-mode-secured',
      'object.temp-fsynced',
      'object.published-no-replace',
      'object.temp-unlinked',
      'object.parent-fsynced',
      'directory.created',
      'directory.mode-secured',
      'directory.self-fsynced',
      'directory.parent-fsynced',
      'object.existing-fsynced',
      'object.existing-parent-fsynced',
      'directory.created',
      'directory.mode-secured',
      'directory.self-fsynced',
      'directory.parent-fsynced',
      'signature.temp-written',
      'signature.temp-mode-secured',
      'signature.temp-fsynced',
      'signature.temp-written',
      'signature.temp-mode-secured',
      'signature.temp-fsynced',
      'signature.published-no-replace',
      'signature.temp-unlinked',
      'signature.parent-fsynced',
      'signature.existing-fsynced',
      'signature.existing-parent-fsynced',
    ];
    expect([...boundaries].sort()).toEqual([...expectedBoundaries].sort());
    boundaries.length = 0;
    await store.stageVerifiedObjects([fixture]);
    expect(boundaries).toEqual([
      'object.existing-fsynced',
      'object.existing-parent-fsynced',
      'signature.existing-fsynced',
      'signature.existing-parent-fsynced',
    ]);
  });

  it('coexists and reads exact signature variants for one immutable object', async () => {
    const dataDir = await temporaryDataDirectory();
    const boundaries: Rfc64ControlObjectStoreDurabilityBoundaryV1[] = [];
    const store = await createRfc64ControlObjectStoreTestOpenerV1({
      boundary: (boundary) => {
        boundaries.push(boundary);
      },
    })(dataDir);
    const [first, second] = await contractSignatureVariantsFixture();
    expect(first.envelope.objectDigest).toBe(second.envelope.objectDigest);

    const result = await store.stageVerifiedObjects([first, second]);
    expect(result.objects[0]?.objectDigest).toBe(result.objects[1]?.objectDigest);
    expect(result.objects[0]?.signatureVariantDigest)
      .not.toBe(result.objects[1]?.signatureVariantDigest);
    const firstPaths = pathsFor(dataDir, first.envelope);
    const secondPaths = pathsFor(dataDir, second.envelope);
    expect(firstPaths.object).toBe(secondPaths.object);
    expect(firstPaths.signature).not.toBe(secondPaths.signature);
    expect(boundaries.filter((boundary) => boundary === 'object.temp-written')).toHaveLength(1);
    expect(boundaries.filter((boundary) => boundary === 'signature.temp-written')).toHaveLength(2);
    await expect(readFile(firstPaths.signature)).resolves.not.toHaveLength(0);
    await expect(readFile(secondPaths.signature)).resolves.not.toHaveLength(0);

    const verifyIssuerSignature = (envelope: SignedControlEnvelopeV1) =>
      verifyControlEnvelopeIssuerSignatureV1(envelope, {
        callEvmAtCurrentFinalized: finalizedEip1271Call,
      });
    await expect(store.getVerifiedObject({
      objectDigest: first.envelope.objectDigest as Digest32V1,
      signatureVariantDigest: firstPaths.signatureDigest,
      verifyIssuerSignature,
    })).resolves.toMatchObject({ envelope: first.envelope });
    await expect(store.getVerifiedObject({
      objectDigest: second.envelope.objectDigest as Digest32V1,
      signatureVariantDigest: secondPaths.signatureDigest,
      verifyIssuerSignature,
    })).resolves.toMatchObject({ envelope: second.envelope });
    const deterministic = firstPaths.signatureDigest < secondPaths.signatureDigest
      ? first.envelope
      : second.envelope;
    await expect(store.getVerifiedObjectByDigest({
      objectDigest: first.envelope.objectDigest as Digest32V1,
      verifyIssuerSignature,
    })).resolves.toMatchObject({ envelope: deterministic });
  });

  it('atomically refuses a 65th valid signature variant without poisoning digest lookup', async () => {
    const dataDir = await temporaryDataDirectory();
    const store = await openRfc64ControlObjectStoreV1(dataDir);
    const variants = await contractSignatureVariantBatchFixture(
      RFC64_CONTROL_OBJECT_STORE_MAX_SIGNATURE_VARIANTS_PER_OBJECT + 1,
      'variant-ceiling',
    );
    const initial = variants.slice(
      0,
      RFC64_CONTROL_OBJECT_STORE_MAX_SIGNATURE_VARIANTS_PER_OBJECT - 1,
    );
    for (
      let offset = 0;
      offset < initial.length;
      offset += RFC64_CONTROL_OBJECT_STORE_MAX_STAGE_OBJECTS
    ) {
      await store.stageVerifiedObjects(initial.slice(
        offset,
        offset + RFC64_CONTROL_OBJECT_STORE_MAX_STAGE_OBJECTS,
      ));
    }

    const boundary = await Promise.allSettled([
      store.stageVerifiedObjects([
        variants[RFC64_CONTROL_OBJECT_STORE_MAX_SIGNATURE_VARIANTS_PER_OBJECT - 1],
      ]),
      store.stageVerifiedObjects([
        variants[RFC64_CONTROL_OBJECT_STORE_MAX_SIGNATURE_VARIANTS_PER_OBJECT],
      ]),
    ]);
    expect(boundary.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = boundary.filter((outcome) => outcome.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: expect.objectContaining({ code: 'control-store-input' }),
    });

    const verifyIssuerSignature = (envelope: SignedControlEnvelopeV1) =>
      verifyControlEnvelopeIssuerSignatureV1(envelope, {
        callEvmAtCurrentFinalized: finalizedEip1271Call,
      });
    await expect(store.getVerifiedObjectByDigest({
      objectDigest: variants[0].envelope.objectDigest as Digest32V1,
      verifyIssuerSignature,
    })).resolves.toMatchObject({
      envelope: expect.objectContaining({ objectDigest: variants[0].envelope.objectDigest }),
    });
  });

  it.runIf(process.platform !== 'win32')(
    'fails closed when a signature shard is replaced by an owner-only symlink',
    async () => {
      const dataDir = await temporaryDataDirectory();
      const store = await openRfc64ControlObjectStoreV1(dataDir);
      const fixture = await signedFixture('unsafe-signature-shard');
      await store.stageVerifiedObjects([fixture]);
      const paths = pathsFor(dataDir, fixture.envelope);
      const shardPath = dirname(dirname(paths.signature));
      const outsidePath = join(dataDir, 'outside-signature-shard');
      await mkdir(outsidePath, { mode: RFC64_CONTROL_OBJECT_STORE_DIRECTORY_MODE });
      applyRfc64OwnerOnlyPermissionsSyncV1(
        outsidePath,
        RFC64_CONTROL_OBJECT_STORE_DIRECTORY_MODE,
        { entryKind: 'directory' },
      );
      await rm(shardPath, { recursive: true });
      await symlink(outsidePath, shardPath, 'dir');

      await expect(store.getVerifiedObjectByDigest({
        objectDigest: fixture.envelope.objectDigest as Digest32V1,
        verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
      })).rejects.toMatchObject({ code: 'control-store-unsafe-path' });
    },
  );

  it.runIf(process.platform !== 'win32')(
    'rejects a nonregular entry even when its name has the durable temp shape',
    async () => {
      const dataDir = await temporaryDataDirectory();
      const store = await openRfc64ControlObjectStoreV1(dataDir);
      const fixture = await signedFixture('unsafe-temp-entry');
      await store.stageVerifiedObjects([fixture]);
      const paths = pathsFor(dataDir, fixture.envelope);
      const tempName = `.${basename(paths.signature)}.${'ab'.repeat(16)}.tmp`;
      await symlink(paths.signature, join(dirname(paths.signature), tempName));

      await expect(store.getVerifiedObjectByDigest({
        objectDigest: fixture.envelope.objectDigest as Digest32V1,
        verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
      })).rejects.toMatchObject({ code: 'control-store-unsafe-path' });
    },
  );

  it('allows independent digest keys to stage concurrently without a store-wide queue', async () => {
    const dataDir = await temporaryDataDirectory();
    const store = await openRfc64ControlObjectStoreV1(dataDir);
    const [first, second] = await Promise.all([signedFixture('2a'), signedFixture('2b')]);

    const [firstResult, secondResult] = await Promise.all([
      store.stageVerifiedObjects([first]),
      store.stageVerifiedObjects([second]),
    ]);

    expect(firstResult.objects[0].objectDigest).toBe(first.envelope.objectDigest);
    expect(secondResult.objects[0].objectDigest).toBe(second.envelope.objectDigest);
    await expect(Promise.all([
      readFile(pathsFor(dataDir, first.envelope).object),
      readFile(pathsFor(dataDir, second.envelope).object),
    ])).resolves.toHaveLength(2);
  });

  it('requires an unforgeable signature proof bound to the exact envelope before I/O', async () => {
    const dataDir = await temporaryDataDirectory();
    const store = await openRfc64ControlObjectStoreV1(dataDir);
    const first = await signedFixture('3');
    const second = await signedFixture('4');
    const firstPaths = pathsFor(dataDir, first.envelope);

    expect(() => store.stageVerifiedObjects([{
      envelope: first.envelope,
      issuerSignature: Object.freeze({}) as VerifiedControlEnvelopeIssuerSignatureV1,
    }])).toThrow(expect.objectContaining({ code: 'control-store-verification' }));
    expect(() => store.stageVerifiedObjects([{
      envelope: first.envelope,
      issuerSignature: second.issuerSignature,
    }])).toThrow(expect.objectContaining({ code: 'control-store-verification' }));
    await expect(stat(firstPaths.object)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('snapshots inputs before any durability callback can mutate caller-owned objects', async () => {
    const dataDir = await temporaryDataDirectory();
    const fixture = await signedFixture('5');
    const originalEnvelope = structuredClone(fixture.envelope);
    let mutated = false;
    const store = await createRfc64ControlObjectStoreTestOpenerV1({
      boundary: (boundary) => {
        if (boundary !== 'object.temp-written' || mutated) return;
        mutated = true;
        (fixture.envelope.payload as { sequence: string }).sequence = 'mutated';
      },
    })(dataDir);

    await store.stageVerifiedObjects([fixture]);
    const paths = pathsFor(dataDir, originalEnvelope);
    const loaded = await store.getVerifiedObject({
      objectDigest: originalEnvelope.objectDigest as Digest32V1,
      signatureVariantDigest: paths.signatureDigest,
      verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
    });
    expect(loaded?.envelope).toEqual(originalEnvelope);
  });

  it('fails closed on canonical object or signature corruption and never overwrites it', async () => {
    const dataDir = await temporaryDataDirectory();
    const store = await openRfc64ControlObjectStoreV1(dataDir);
    const fixture = await signedFixture('6');
    await store.stageVerifiedObjects([fixture]);
    const paths = pathsFor(dataDir, fixture.envelope);

    await writeFile(paths.object, '{}', { mode: RFC64_CONTROL_OBJECT_STORE_FILE_MODE });
    await expect(store.getVerifiedObject({
      objectDigest: fixture.envelope.objectDigest as Digest32V1,
      signatureVariantDigest: paths.signatureDigest,
      verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
    })).rejects.toMatchObject({ code: 'control-store-corrupt' });
    await expect(store.stageVerifiedObjects([fixture]))
      .rejects.toMatchObject({ code: 'control-store-corrupt' });
    expect(await readFile(paths.object, 'utf8')).toBe('{}');

    await unlink(paths.object);
    await store.stageVerifiedObjects([fixture]);
    await writeFile(paths.signature, '{}', { mode: RFC64_CONTROL_OBJECT_STORE_FILE_MODE });
    await expect(store.getVerifiedObject({
      objectDigest: fixture.envelope.objectDigest as Digest32V1,
      signatureVariantDigest: paths.signatureDigest,
      verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
    })).rejects.toMatchObject({ code: 'control-store-corrupt' });
    await expect(store.stageVerifiedObjects([fixture]))
      .rejects.toMatchObject({ code: 'control-store-corrupt' });
    expect(await readFile(paths.signature, 'utf8')).toBe('{}');
  });

  it('rejects canonical unsigned object bytes stored under another object digest key', async () => {
    const dataDir = await temporaryDataDirectory();
    const store = await openRfc64ControlObjectStoreV1(dataDir);
    const [first, second] = await Promise.all([signedFixture('6a'), signedFixture('6b')]);
    await store.stageVerifiedObjects([first, second]);
    const firstPaths = pathsFor(dataDir, first.envelope);
    const secondPaths = pathsFor(dataDir, second.envelope);
    await writeFile(firstPaths.object, await readFile(secondPaths.object), {
      mode: RFC64_CONTROL_OBJECT_STORE_FILE_MODE,
    });
    const verifyIssuerSignature = vi.fn(verifyControlEnvelopeIssuerSignatureV1);

    await expect(store.getVerifiedObject({
      objectDigest: first.envelope.objectDigest as Digest32V1,
      signatureVariantDigest: firstPaths.signatureDigest,
      verifyIssuerSignature,
    })).rejects.toMatchObject({ code: 'control-store-corrupt' });
    expect(verifyIssuerSignature).not.toHaveBeenCalled();
  });

  it('rejects a canonical signature variant stored under a different exact key', async () => {
    const dataDir = await temporaryDataDirectory();
    const store = await openRfc64ControlObjectStoreV1(dataDir);
    const fixture = await signedFixture('6c');
    await store.stageVerifiedObjects([fixture]);
    const paths = pathsFor(dataDir, fixture.envelope);
    const wrongVariant = `0x${'34'.repeat(32)}` as Digest32V1;
    const wrongPath = join(dirname(paths.signature), `${wrongVariant.slice(2)}.jcs`);
    await writeFile(wrongPath, await readFile(paths.signature), {
      mode: RFC64_CONTROL_OBJECT_STORE_FILE_MODE,
    });
    applyRfc64OwnerOnlyPermissionsSyncV1(
      wrongPath,
      RFC64_CONTROL_OBJECT_STORE_FILE_MODE,
      { entryKind: 'file' },
    );
    const verifyIssuerSignature = vi.fn(verifyControlEnvelopeIssuerSignatureV1);

    await expect(store.getVerifiedObject({
      objectDigest: fixture.envelope.objectDigest as Digest32V1,
      signatureVariantDigest: wrongVariant,
      verifyIssuerSignature,
    })).rejects.toMatchObject({ code: 'control-store-corrupt' });
    expect(verifyIssuerSignature).not.toHaveBeenCalled();
  });

  it('lets an issuer verifier re-enter the same store without deadlocking', async () => {
    const dataDir = await temporaryDataDirectory();
    const store = await openRfc64ControlObjectStoreV1(dataDir);
    const fixture = await signedFixture('6c');
    await store.stageVerifiedObjects([fixture]);
    const paths = pathsFor(dataDir, fixture.envelope);
    const missing = `0x${'12'.repeat(32)}` as Digest32V1;
    const missingVariant = `0x${'56'.repeat(32)}` as Digest32V1;
    const verifyIssuerSignature = vi.fn(async (envelope: SignedControlEnvelopeV1) => {
      await expect(store.getVerifiedObject({
        objectDigest: missing,
        signatureVariantDigest: missingVariant,
        verifyIssuerSignature: async () => {
          throw new Error('cache-miss verifier must not run');
        },
      })).resolves.toBeNull();
      return verifyControlEnvelopeIssuerSignatureV1(envelope);
    });

    await expect(store.getVerifiedObject({
      objectDigest: fixture.envelope.objectDigest as Digest32V1,
      signatureVariantDigest: paths.signatureDigest,
      verifyIssuerSignature,
    })).resolves.toMatchObject({ envelope: fixture.envelope });
    expect(verifyIssuerSignature).toHaveBeenCalledOnce();
  });

  it('rejects a read-side issuer proof bound to a different verified envelope', async () => {
    const dataDir = await temporaryDataDirectory();
    const store = await openRfc64ControlObjectStoreV1(dataDir);
    const [first, second] = await Promise.all([signedFixture('6d'), signedFixture('6e')]);
    await store.stageVerifiedObjects([first]);
    const paths = pathsFor(dataDir, first.envelope);

    await expect(store.getVerifiedObject({
      objectDigest: first.envelope.objectDigest as Digest32V1,
      signatureVariantDigest: paths.signatureDigest,
      verifyIssuerSignature: async () => second.issuerSignature,
    })).rejects.toMatchObject({ code: 'control-store-verification' });
  });

  it('does not let a slow verifier block an unrelated immutable stage', async () => {
    const dataDir = await temporaryDataDirectory();
    const store = await openRfc64ControlObjectStoreV1(dataDir);
    const [first, second] = await Promise.all([signedFixture('6f'), signedFixture('6g')]);
    await store.stageVerifiedObjects([first]);
    const firstPaths = pathsFor(dataDir, first.envelope);
    const entered = deferred();
    const release = deferred();
    const slowRead = store.getVerifiedObject({
      objectDigest: first.envelope.objectDigest as Digest32V1,
      signatureVariantDigest: firstPaths.signatureDigest,
      verifyIssuerSignature: async (envelope) => {
        entered.resolve();
        await release.promise;
        return verifyControlEnvelopeIssuerSignatureV1(envelope);
      },
    });
    await entered.promise;

    await expect(store.stageVerifiedObjects([second])).resolves.toMatchObject({ durable: true });
    release.resolve();
    await expect(slowRead).resolves.toMatchObject({ envelope: first.envelope });
  });

  it('returns null for an exact cache miss without calling the verifier', async () => {
    const dataDir = await temporaryDataDirectory();
    const store = await openRfc64ControlObjectStoreV1(dataDir);
    const verifyIssuerSignature = vi.fn(verifyControlEnvelopeIssuerSignatureV1);
    const missing = `0x${'12'.repeat(32)}` as Digest32V1;
    const missingVariant = `0x${'34'.repeat(32)}` as Digest32V1;
    await expect(store.getVerifiedObject({
      objectDigest: missing,
      signatureVariantDigest: missingVariant,
      verifyIssuerSignature,
    })).resolves.toBeNull();
    expect(verifyIssuerSignature).not.toHaveBeenCalled();
  });

  it('bounds dense batches and fences all operations after close', async () => {
    const dataDir = await temporaryDataDirectory();
    const store = await openRfc64ControlObjectStoreV1(dataDir);
    const fixture = await signedFixture('9');
    const oversized = Array.from(
      { length: RFC64_CONTROL_OBJECT_STORE_MAX_STAGE_OBJECTS + 1 },
      () => fixture,
    );
    const holey = new Array<StageVerifiedControlObjectV1>(1);
    expect(() => store.stageVerifiedObjects([]))
      .toThrow(expect.objectContaining({ code: 'control-store-input' }));
    expect(() => store.stageVerifiedObjects(oversized))
      .toThrow(expect.objectContaining({ code: 'control-store-input' }));
    expect(() => store.stageVerifiedObjects(holey))
      .toThrow(expect.objectContaining({ code: 'control-store-input' }));

    await store.close();
    expect(store.closed).toBe(true);
    expect(() => store.stageVerifiedObjects([fixture]))
      .toThrow(expect.objectContaining({ code: 'control-store-closed' }));
    expect(() => store.getVerifiedObject({
      objectDigest: fixture.envelope.objectDigest as Digest32V1,
      signatureVariantDigest: pathsFor(dataDir, fixture.envelope).signatureDigest,
      verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
    })).toThrow(expect.objectContaining({ code: 'control-store-closed' }));
  });

  it('uses a closed typed error registry', () => {
    expect(() => new Rfc64ControlObjectStoreErrorV1(
      'not-registered' as never,
      'bad',
    )).toThrow(TypeError);
    expect(new Set(RFC64_CONTROL_OBJECT_STORE_ERROR_CODES_V1).size)
      .toBe(RFC64_CONTROL_OBJECT_STORE_ERROR_CODES_V1.length);
  });
});
