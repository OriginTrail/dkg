import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  encodeOpaqueKaBundleV1,
  type Digest32V1,
} from '@origintrail-official/dkg-core';
import { verifyControlEnvelopeIssuerSignatureV1 } from '@origintrail-official/dkg-chain';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  RFC64_KA_BUNDLE_STORE_DIRECTORY_MODE,
  RFC64_KA_BUNDLE_STORE_FILE_MODE,
  RFC64_KA_BUNDLE_STORE_MAX_BYTES_V1,
  RFC64_KA_BUNDLE_STORE_RELATIVE_PATH,
} from '../src/rfc64/ka-bundle-store-v1.js';
import {
  openRfc64PersistenceV1,
  type Rfc64PersistenceV1,
} from '../src/rfc64/persistence-v1.js';
import {
  RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_RESPONSE_MAX_BYTES_V1,
} from '../src/rfc64/public-catalog-native-transport-v1.js';
import {
  createTemporaryDataDirectoryFixture,
  pathsFor,
  signedFixture,
} from './support/rfc64-control-object-store-fixtures.js';

const UTF8 = new TextEncoder();
const MISSING_DIGEST = `0x${'ff'.repeat(32)}` as Digest32V1;
const temporaryDirectories = createTemporaryDataDirectoryFixture();
const { temporaryDataDirectory } = temporaryDirectories;
const persistences: Rfc64PersistenceV1[] = [];

afterEach(async () => {
  await Promise.allSettled(persistences.splice(0).map((persistence) => persistence.close()));
  await temporaryDirectories.cleanup();
});

async function openPersistence(dataDir: string): Promise<Rfc64PersistenceV1> {
  const persistence = await openRfc64PersistenceV1(dataDir, {
    yieldAfterPurgeBatch: async () => {},
  });
  persistences.push(persistence);
  return persistence;
}

function bundlePath(dataDir: string, blobDigest: Digest32V1): string {
  const hex = blobDigest.slice(2);
  return join(
    dataDir,
    RFC64_KA_BUNDLE_STORE_RELATIVE_PATH,
    'bundles',
    hex.slice(0, 2),
    `${hex}.bundle`,
  );
}

describe('RFC-64 persistent native catalog providers v1', () => {
  it('reopens exact verified control objects and content-addressed opaque bundles', async () => {
    const dataDir = await temporaryDataDirectory();
    const fixture = await signedFixture('persistent-provider-reopen');
    const bundle = encodeOpaqueKaBundleV1(
      UTF8.encode('<https://example.org/s> <https://example.org/p> "v" .\n'),
      UTF8.encode('canonical-author-seal'),
    );
    const first = await openPersistence(dataDir);

    await first.controlObjects.stageVerifiedObjects([fixture]);
    const put = await first.kaBundles.putKaBundle({
      blobDigest: bundle.blobDigest,
      bundleBytes: bundle.bundleBytes,
    });
    expect(put).toEqual({
      durable: true,
      namespaceDurability: first.kaBundles.namespaceDurability,
      blobDigest: bundle.blobDigest,
      byteLength: bundle.bundleBytes.byteLength,
    });
    expect(Object.isFrozen(put)).toBe(true);

    const verifyFirst = vi.fn(verifyControlEnvelopeIssuerSignatureV1);
    await expect(first.controlObjects.getVerifiedObjectByDigest({
      objectDigest: fixture.envelope.objectDigest as Digest32V1,
      verifyIssuerSignature: verifyFirst,
    })).resolves.toMatchObject({ envelope: fixture.envelope });
    expect(verifyFirst).toHaveBeenCalledTimes(1);
    await expect(first.kaBundles.readKaBundleByDigest(bundle.blobDigest))
      .resolves.toEqual(bundle.bundleBytes);

    if (process.platform !== 'win32') {
      expect((await stat(join(dataDir, RFC64_KA_BUNDLE_STORE_RELATIVE_PATH))).mode & 0o777)
        .toBe(RFC64_KA_BUNDLE_STORE_DIRECTORY_MODE);
      expect((await stat(bundlePath(dataDir, bundle.blobDigest))).mode & 0o777)
        .toBe(RFC64_KA_BUNDLE_STORE_FILE_MODE);
    }

    await first.close();
    const reopened = await openPersistence(dataDir);
    const verifyReopened = vi.fn(verifyControlEnvelopeIssuerSignatureV1);
    const loaded = await reopened.controlObjects.getVerifiedObjectByDigest({
      objectDigest: fixture.envelope.objectDigest as Digest32V1,
      verifyIssuerSignature: verifyReopened,
    });
    expect(loaded?.envelope).toEqual(fixture.envelope);
    expect(verifyReopened).toHaveBeenCalledTimes(1);
    await expect(reopened.kaBundles.readKaBundleByDigest(bundle.blobDigest))
      .resolves.toEqual(bundle.bundleBytes);
  });

  it('returns no provider value for an unknown digest without invoking verification', async () => {
    const persistence = await openPersistence(await temporaryDataDirectory());
    const verifier = vi.fn(verifyControlEnvelopeIssuerSignatureV1);

    await expect(persistence.controlObjects.getVerifiedObjectByDigest({
      objectDigest: MISSING_DIGEST,
      verifyIssuerSignature: verifier,
    })).resolves.toBeNull();
    expect(verifier).not.toHaveBeenCalled();
    await expect(persistence.kaBundles.readKaBundleByDigest(MISSING_DIGEST))
      .resolves.toBeNull();
  });

  it('rejects mismatched and over-ceiling bundle writes before publication', async () => {
    const dataDir = await temporaryDataDirectory();
    const persistence = await openPersistence(dataDir);
    const bundle = encodeOpaqueKaBundleV1(UTF8.encode('projection'), UTF8.encode('seal'));

    expect(RFC64_KA_BUNDLE_STORE_MAX_BYTES_V1 + 1)
      .toBe(RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_RESPONSE_MAX_BYTES_V1);
    expect(() => persistence.kaBundles.putKaBundle({
      blobDigest: MISSING_DIGEST,
      bundleBytes: bundle.bundleBytes,
    })).toThrow(expect.objectContaining({ code: 'ka-bundle-store-verification' }));
    await expect(persistence.kaBundles.readKaBundleByDigest(MISSING_DIGEST))
      .resolves.toBeNull();

    expect(() => persistence.kaBundles.putKaBundle({
      blobDigest: MISSING_DIGEST,
      bundleBytes: new Uint8Array(RFC64_KA_BUNDLE_STORE_MAX_BYTES_V1 + 1),
    })).toThrow(expect.objectContaining({ code: 'ka-bundle-store-input' }));
    await expect(stat(bundlePath(dataDir, MISSING_DIGEST)))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed on corrupted durable object variants and bundle bytes after reopen', async () => {
    const dataDir = await temporaryDataDirectory();
    const fixture = await signedFixture('persistent-provider-corrupt');
    const firstBundle = encodeOpaqueKaBundleV1(UTF8.encode('first'), UTF8.encode('seal-a'));
    const replacement = encodeOpaqueKaBundleV1(UTF8.encode('second'), UTF8.encode('seal-b'));
    const first = await openPersistence(dataDir);
    await first.controlObjects.stageVerifiedObjects([fixture]);
    await first.kaBundles.putKaBundle({
      blobDigest: firstBundle.blobDigest,
      bundleBytes: firstBundle.bundleBytes,
    });
    await first.close();

    await writeFile(pathsFor(dataDir, fixture.envelope).signature, '{}');
    await writeFile(bundlePath(dataDir, firstBundle.blobDigest), replacement.bundleBytes);

    const reopened = await openPersistence(dataDir);
    const verifier = vi.fn(verifyControlEnvelopeIssuerSignatureV1);
    await expect(reopened.controlObjects.getVerifiedObjectByDigest({
      objectDigest: fixture.envelope.objectDigest as Digest32V1,
      verifyIssuerSignature: verifier,
    })).rejects.toMatchObject({ code: 'control-store-corrupt' });
    expect(verifier).not.toHaveBeenCalled();
    await expect(reopened.kaBundles.readKaBundleByDigest(firstBundle.blobDigest))
      .rejects.toMatchObject({ code: 'ka-bundle-store-corrupt' });
  });
});
