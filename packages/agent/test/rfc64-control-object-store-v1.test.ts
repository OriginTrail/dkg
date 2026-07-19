import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  computeControlObjectDigestHex,
  computeControlSignatureVariantDigestHex,
  type AuthorCatalogScopeV1,
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
import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  RFC64_CONTROL_OBJECT_STORE_DIRECTORY_MODE,
  RFC64_CONTROL_OBJECT_STORE_ERROR_CODES_V1,
  RFC64_CONTROL_OBJECT_STORE_FILE_MODE,
  RFC64_CONTROL_OBJECT_STORE_MAX_STAGE_OBJECTS,
  RFC64_CONTROL_OBJECT_STORE_POSIX_NAMESPACE_DURABILITY,
  RFC64_CONTROL_OBJECT_STORE_RELATIVE_PATH,
  RFC64_CONTROL_OBJECT_STORE_WINDOWS_NAMESPACE_DURABILITY,
  Rfc64ControlObjectStoreErrorV1,
  type StageVerifiedControlObjectV1,
} from '../src/rfc64/control-object-store-v1.js';
import { createRfc64DurableFileStoreV1 } from '../src/rfc64/durable-file-store-v1.js';
import { produceEmptyAuthorCatalogGenesisV1 } from '../src/rfc64/author-catalog-producer.js';
import { applyRfc64OwnerOnlyPermissionsSyncV1 } from '../src/rfc64/secure-filesystem-policy-v1.js';
import {
  createRfc64ControlObjectStoreTestOpenerV1,
  type Rfc64ControlObjectStoreDurabilityBoundaryV1,
} from './support/rfc64-control-object-store-test-support.js';

const PRIVATE_KEY = `0x${'42'.repeat(32)}`;
const SAFE = '0x3333333333333333333333333333333333333333' as EvmAddressV1;
const BLOCK_HASH = `0x${'44'.repeat(32)}`;
const wallet = new ethers.Wallet(PRIVATE_KEY);
const ISSUER = wallet.address.toLowerCase() as EvmAddressV1;
const openRfc64ControlObjectStoreV1 = createRfc64ControlObjectStoreTestOpenerV1();

const temporaryDirectories: string[] = [];

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: () => resolvePromise?.() };
}

async function temporaryDataDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dkg-rfc64-control-store-'));
  temporaryDirectories.push(path);
  return path;
}

function grantWindowsEveryoneRead(
  path: string,
  entryKind: 'file' | 'directory',
): void {
  const permission = entryKind === 'directory'
    ? '*S-1-1-0:(OI)(CI)(RX)'
    : '*S-1-1-0:(R)';
  const result = spawnSync(
    'icacls.exe',
    [path, '/grant', permission],
    { encoding: 'utf8', windowsHide: true },
  );
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `failed to grant the Windows ACL test permission: ${
        result.error?.message ?? (result.stderr.trim() || `icacls exited ${result.status}`)
      }`,
      result.error === undefined ? {} : { cause: result.error },
    );
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => {
    await rm(path, { recursive: true, force: true });
  }));
});

async function signedFixture(
  sequence: string,
): Promise<StageVerifiedControlObjectV1> {
  const unsigned = {
    issuer: ISSUER,
    objectType: 'dkg-rfc64-control-store-test-v1',
    payload: { sequence },
    signatureEvidence: { kind: 'none' },
    signatureSuite: 'eip191-personal-sign-digest-v1',
  } satisfies UnsignedControlEnvelopeV1;
  const objectDigest = computeControlObjectDigestHex(unsigned);
  const signature = await wallet.signMessage(ethers.getBytes(objectDigest));
  const envelope = {
    ...unsigned,
    objectDigest,
    signature,
  } as SignedControlEnvelopeV1;
  return {
    envelope,
    issuerSignature: await verifyControlEnvelopeIssuerSignatureV1(envelope),
  };
}

const finalizedEip1271Call: CurrentFinalizedEvmCallV1 = async (request) => ({
  chainId: request.chainId,
  blockNumber: '123',
  blockHash: BLOCK_HASH,
  returnData: EIP1271_CANONICAL_ABI_RETURN_V1,
});

async function contractSignatureVariantsFixture(): Promise<
  readonly [StageVerifiedControlObjectV1, StageVerifiedControlObjectV1]
> {
  const unsigned = {
    issuer: SAFE,
    objectType: 'dkg-rfc64-control-store-contract-test-v1',
    payload: { sequence: 'variants' },
    signatureEvidence: {
      kind: 'eip1271-current-finalized',
      chainId: '20430',
      contractAddress: SAFE,
    },
    signatureSuite: 'eip1271-current-finalized-v1',
  } satisfies UnsignedControlEnvelopeV1;
  const objectDigest = computeControlObjectDigestHex(unsigned);
  const firstEnvelope = {
    ...unsigned,
    objectDigest,
    signature: '0x12',
  } as SignedControlEnvelopeV1;
  const secondEnvelope = {
    ...unsigned,
    objectDigest,
    signature: '0x1234',
  } as SignedControlEnvelopeV1;
  const [firstProof, secondProof] = await Promise.all([
    verifyControlEnvelopeIssuerSignatureV1(firstEnvelope, {
      callEvmAtCurrentFinalized: finalizedEip1271Call,
    }),
    verifyControlEnvelopeIssuerSignatureV1(secondEnvelope, {
      callEvmAtCurrentFinalized: finalizedEip1271Call,
    }),
  ]);
  return [{ envelope: firstEnvelope, issuerSignature: firstProof }, {
    envelope: secondEnvelope,
    issuerSignature: secondProof,
  }];
}

function pathsFor(
  dataDir: string,
  envelope: SignedControlEnvelopeV1,
): { root: string; object: string; signature: string; signatureDigest: Digest32V1 } {
  const root = join(dataDir, RFC64_CONTROL_OBJECT_STORE_RELATIVE_PATH);
  const objectHex = envelope.objectDigest.slice(2);
  const signatureDigest = computeControlSignatureVariantDigestHex(
    envelope.objectDigest,
    envelope.signature,
  ) as Digest32V1;
  return {
    root,
    object: join(root, 'objects', objectHex.slice(0, 2), `${objectHex}.jcs`),
    signature: join(
      root,
      'signatures',
      objectHex.slice(0, 2),
      objectHex,
      `${signatureDigest.slice(2)}.jcs`,
    ),
    signatureDigest,
  };
}

describe('RFC-64 durable control-object store v1', () => {
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

  it('is idempotent and serializes concurrent staging for exact digest keys', async () => {
    const dataDir = await temporaryDataDirectory();
    const boundaries: Rfc64ControlObjectStoreDurabilityBoundaryV1[] = [];
    const store = await createRfc64ControlObjectStoreTestOpenerV1({
      boundary: (boundary) => boundaries.push(boundary),
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
      'signature.published-no-replace',
      'signature.temp-unlinked',
      'signature.parent-fsynced',
      'signature.existing-fsynced',
      'signature.existing-parent-fsynced',
    ];
    expect([...boundaries].sort()).toEqual([...expectedBoundaries].sort());
    expect(boundaries.indexOf('object.temp-written'))
      .toBeLessThan(boundaries.indexOf('object.published-no-replace'));
    expect(boundaries.indexOf('object.published-no-replace'))
      .toBeLessThan(boundaries.indexOf('object.existing-fsynced'));
    expect(boundaries.indexOf('signature.temp-written'))
      .toBeLessThan(boundaries.indexOf('signature.published-no-replace'));
    expect(boundaries.indexOf('signature.published-no-replace'))
      .toBeLessThan(boundaries.indexOf('signature.existing-fsynced'));
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
    const store = await openRfc64ControlObjectStoreV1(dataDir);
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
  });

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

  it('drains an admitted durable write before close can release ownership', async () => {
    const dataDir = await temporaryDataDirectory();
    const entered = deferred();
    const release = deferred();
    let paused = false;
    const store = await createRfc64ControlObjectStoreTestOpenerV1({
      boundary: async (boundary) => {
        if (boundary === 'object.temp-written' && !paused) {
          paused = true;
          entered.resolve();
          await release.promise;
        }
      },
    })(dataDir);
    const fixture = await signedFixture('close-drain');
    const stage = store.stageVerifiedObjects([fixture]);
    await entered.promise;

    let closeSettled = false;
    const close = store.close().then(() => { closeSettled = true; });
    expect(store.closed).toBe(true);
    await Promise.resolve();
    expect(closeSettled).toBe(false);

    release.resolve();
    await expect(stage).resolves.toMatchObject({ durable: true });
    await expect(close).resolves.toBeUndefined();
    expect(closeSettled).toBe(true);
    await expect(store.close()).resolves.toBeUndefined();
  });

  it('drains an admitted verified read before close can release ownership', async () => {
    const dataDir = await temporaryDataDirectory();
    const store = await openRfc64ControlObjectStoreV1(dataDir);
    const fixture = await signedFixture('close-read-drain');
    await store.stageVerifiedObjects([fixture]);
    const entered = deferred();
    const release = deferred();
    const read = store.getVerifiedObject({
      objectDigest: fixture.envelope.objectDigest as Digest32V1,
      signatureVariantDigest: pathsFor(dataDir, fixture.envelope).signatureDigest,
      verifyIssuerSignature: async (envelope) => {
        entered.resolve();
        await release.promise;
        return verifyControlEnvelopeIssuerSignatureV1(envelope);
      },
    });
    await entered.promise;

    let closeSettled = false;
    const close = store.close().then(() => { closeSettled = true; });
    expect(store.closed).toBe(true);
    await Promise.resolve();
    expect(closeSettled).toBe(false);

    release.resolve();
    await expect(read).resolves.toMatchObject({ envelope: fixture.envelope });
    await expect(close).resolves.toBeUndefined();
    expect(closeSettled).toBe(true);
  });

  it('cleans an unpublished temp after a pre-visibility fault and converges on retry', async () => {
    const dataDir = await temporaryDataDirectory();
    const fixture = await signedFixture('7');
    let injected = false;
    const store = await createRfc64ControlObjectStoreTestOpenerV1({
      boundary: (boundary) => {
        if (boundary === 'object.temp-fsynced' && !injected) {
          injected = true;
          throw new Error('injected pre-publish fault');
        }
      },
    })(dataDir);
    const paths = pathsFor(dataDir, fixture.envelope);

    await expect(store.stageVerifiedObjects([fixture]))
      .rejects.toMatchObject({ code: 'control-store-durability' });
    await expect(stat(paths.object)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(store.stageVerifiedObjects([fixture])).resolves.toMatchObject({ durable: true });
  });

  it('treats a post-publish fault as an unreachable orphan and safely completes on retry', async () => {
    const dataDir = await temporaryDataDirectory();
    const fixture = await signedFixture('8');
    let injected = false;
    const boundaries: Rfc64ControlObjectStoreDurabilityBoundaryV1[] = [];
    const store = await createRfc64ControlObjectStoreTestOpenerV1({
      boundary: (boundary) => {
        boundaries.push(boundary);
        if (boundary === 'object.published-no-replace' && !injected) {
          injected = true;
          throw new Error('injected post-publish fault');
        }
      },
    })(dataDir);
    const paths = pathsFor(dataDir, fixture.envelope);

    await expect(store.stageVerifiedObjects([fixture]))
      .rejects.toMatchObject({ code: 'control-store-durability' });
    expect(await readFile(paths.object, 'utf8')).toContain('dkg-rfc64-control-store-test-v1');
    await expect(stat(paths.signature)).rejects.toMatchObject({ code: 'ENOENT' });
    const verifyIssuerSignature = vi.fn(verifyControlEnvelopeIssuerSignatureV1);
    await expect(store.getVerifiedObject({
      objectDigest: fixture.envelope.objectDigest as Digest32V1,
      signatureVariantDigest: paths.signatureDigest,
      verifyIssuerSignature,
    })).resolves.toBeNull();
    expect(verifyIssuerSignature).not.toHaveBeenCalled();
    boundaries.length = 0;
    await expect(store.stageVerifiedObjects([fixture])).resolves.toMatchObject({ durable: true });
    expect(boundaries).toContain('object.existing-fsynced');
    expect(boundaries).toContain('object.existing-parent-fsynced');
  });

  it('rejects symlinked store topology instead of following it', async () => {
    const dataDir = await temporaryDataDirectory();
    const outside = await temporaryDataDirectory();
    const first = await openRfc64ControlObjectStoreV1(dataDir);
    await first.close();
    const objects = join(dataDir, RFC64_CONTROL_OBJECT_STORE_RELATIVE_PATH, 'objects');
    await rm(objects, { recursive: true, force: true });
    await symlink(outside, objects, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(openRfc64ControlObjectStoreV1(dataDir))
      .rejects.toMatchObject({ code: 'control-store-unsafe-path' });
  });

  it.runIf(process.platform !== 'win32')(
    'rejects symlinked digest files before reading or verifying outside bytes',
    async () => {
      for (const target of ['object', 'signature'] as const) {
        const dataDir = await temporaryDataDirectory();
        const outside = await temporaryDataDirectory();
        const store = await openRfc64ControlObjectStoreV1(dataDir);
        const fixture = await signedFixture(`symlink-${target}`);
        await store.stageVerifiedObjects([fixture]);
        const paths = pathsFor(dataDir, fixture.envelope);
        const targetPath = paths[target];
        const outsideFile = join(outside, `${target}.jcs`);
        await writeFile(outsideFile, '{"outside":true}');
        await unlink(targetPath);
        await symlink(outsideFile, targetPath, 'file');
        const verifyIssuerSignature = vi.fn(verifyControlEnvelopeIssuerSignatureV1);

        await expect(store.getVerifiedObject({
          objectDigest: fixture.envelope.objectDigest as Digest32V1,
          signatureVariantDigest: paths.signatureDigest,
          verifyIssuerSignature,
        })).rejects.toMatchObject({ code: 'control-store-unsafe-path' });
        expect(verifyIssuerSignature).not.toHaveBeenCalled();
      }
    },
  );

  it.runIf(process.platform !== 'win32')(
    'rejects permissive existing files and directories instead of trusting or tightening them',
    async () => {
      const dataDir = await temporaryDataDirectory();
      const store = await openRfc64ControlObjectStoreV1(dataDir);
      const fixture = await signedFixture('8b');
      await store.stageVerifiedObjects([fixture]);
      const paths = pathsFor(dataDir, fixture.envelope);

      await chmod(paths.object, 0o644);
      await expect(store.getVerifiedObject({
        objectDigest: fixture.envelope.objectDigest as Digest32V1,
        signatureVariantDigest: paths.signatureDigest,
        verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
      })).rejects.toMatchObject({ code: 'control-store-unsafe-path' });

      await chmod(paths.object, RFC64_CONTROL_OBJECT_STORE_FILE_MODE);
      await chmod(dirname(dirname(paths.object)), 0o755);
      await store.close();
      await expect(openRfc64ControlObjectStoreV1(dataDir))
        .rejects.toMatchObject({ code: 'control-store-unsafe-path' });
    },
  );

  it.runIf(process.platform === 'win32')(
    'rejects permissive existing Windows file and directory ACLs',
    async () => {
      const directoryDataDir = await temporaryDataDirectory();
      const directoryStore = await openRfc64ControlObjectStoreV1(directoryDataDir);
      const objectsDirectory = join(
        directoryDataDir,
        RFC64_CONTROL_OBJECT_STORE_RELATIVE_PATH,
        'objects',
      );
      await directoryStore.close();
      grantWindowsEveryoneRead(objectsDirectory, 'directory');
      await expect(openRfc64ControlObjectStoreV1(directoryDataDir))
        .rejects.toMatchObject({ code: 'control-store-unsafe-path' });

      const fileDataDir = await temporaryDataDirectory();
      const fileStore = await openRfc64ControlObjectStoreV1(fileDataDir);
      const fixture = await signedFixture('8c');
      await fileStore.stageVerifiedObjects([fixture]);
      const paths = pathsFor(fileDataDir, fixture.envelope);
      grantWindowsEveryoneRead(paths.object, 'file');
      await expect(fileStore.getVerifiedObject({
        objectDigest: fixture.envelope.objectDigest as Digest32V1,
        signatureVariantDigest: paths.signatureDigest,
        verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
      })).rejects.toMatchObject({ code: 'control-store-unsafe-path' });
    },
  );

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

  it('rejects an escaping durable-file relative key inside the write operation', async () => {
    const containmentRoot = await temporaryDataDirectory();
    const durableFiles = createRfc64DurableFileStoreV1(
      containmentRoot,
      Object.freeze({ boundary: () => {} }),
    );
    await expect(durableFiles.putExactBytes({
      relativePath: join('..', 'escaped.jcs'),
      bytes: new TextEncoder().encode('{}'),
      maxBytes: 16,
      label: 'test control object',
      kind: 'object',
    })).rejects.toMatchObject({ code: 'unsafe-path' });
  });

  it('publishes immutable keys without clobbering a racing independent writer', async () => {
    const containmentRoot = await temporaryDataDirectory();
    applyRfc64OwnerOnlyPermissionsSyncV1(
      containmentRoot,
      RFC64_CONTROL_OBJECT_STORE_DIRECTORY_MODE,
      { entryKind: 'directory' },
    );
    const relativePath = join('race', 'immutable.jcs');
    const firstBytes = new TextEncoder().encode('{"writer":"first"}');
    const secondBytes = new TextEncoder().encode('{"writer":"second"}');
    const durableFiles = createRfc64DurableFileStoreV1(
      containmentRoot,
      Object.freeze({ boundary: () => {} }),
    );
    const write = (bytes: Uint8Array) => durableFiles.putExactBytes({
      relativePath,
      bytes,
      maxBytes: 1024,
      label: 'racing immutable fixture',
      kind: 'object' as const,
    });

    const outcomes = await Promise.allSettled([
      write(firstBytes),
      write(secondBytes),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: { code: 'corrupt' },
    });
    const stored = await readFile(join(containmentRoot, relativePath));
    expect([firstBytes, secondBytes].some((bytes) => Buffer.from(bytes).equals(stored))).toBe(true);
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
