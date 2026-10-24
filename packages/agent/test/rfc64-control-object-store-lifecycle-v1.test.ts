import { spawnSync } from 'node:child_process';
import { chmod, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { type Digest32V1 } from '@origintrail-official/dkg-core';
import { verifyControlEnvelopeIssuerSignatureV1 } from '@origintrail-official/dkg-chain';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  RFC64_CONTROL_OBJECT_STORE_FILE_MODE,
  RFC64_CONTROL_OBJECT_STORE_RELATIVE_PATH,
} from '../src/rfc64/control-object-store-v1.js';
import {
  createRfc64ControlObjectStoreTestOpenerV1,
  type Rfc64ControlObjectStoreDurabilityBoundaryV1,
} from './support/rfc64-control-object-store-test-support.js';
import {
  createTemporaryDataDirectoryFixture,
  deferred,
  pathsFor,
  signedFixture,
} from './support/rfc64-control-object-store-fixtures.js';

const openRfc64ControlObjectStoreV1 = createRfc64ControlObjectStoreTestOpenerV1();
const temporaryDirectories = createTemporaryDataDirectoryFixture();
const { temporaryDataDirectory } = temporaryDirectories;

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
  await temporaryDirectories.cleanup();
});

describe('RFC-64 durable control-object store lifecycle v1', () => {
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

  it('drains every sibling write in a failed batch before close resolves', async () => {
    const dataDir = await temporaryDataDirectory();
    const entered = deferred();
    const release = deferred();
    let pauseEnabled = false;
    let paused = false;
    const store = await createRfc64ControlObjectStoreTestOpenerV1({
      boundary: async (boundary) => {
        if (pauseEnabled && boundary === 'object.temp-written' && !paused) {
          paused = true;
          entered.resolve();
          await release.promise;
        }
      },
    })(dataDir);
    const corrupt = await signedFixture('failed-batch-corrupt');
    const slow = await signedFixture('failed-batch-slow');
    await store.stageVerifiedObjects([corrupt]);
    await writeFile(pathsFor(dataDir, corrupt.envelope).object, '{}');
    pauseEnabled = true;

    let stageSettled = false;
    const stage = store.stageVerifiedObjects([corrupt, slow]);
    void stage.finally(() => { stageSettled = true; }).catch(() => undefined);
    await entered.promise;
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(stageSettled).toBe(false);

    let closeSettled = false;
    const close = store.close().then(() => { closeSettled = true; });
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(closeSettled).toBe(false);

    release.resolve();
    await expect(stage).rejects.toMatchObject({ code: 'control-store-corrupt' });
    await expect(close).resolves.toBeUndefined();
    expect(closeSettled).toBe(true);
    await expect(readFile(pathsFor(dataDir, slow.envelope).object)).resolves.not.toHaveLength(0);
    await expect(readFile(pathsFor(dataDir, slow.envelope).signature)).resolves.not.toHaveLength(0);
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

  it('rejects a permissive control-store root before publishing a new immutable key', async () => {
    const dataDir = await temporaryDataDirectory();
    const store = await openRfc64ControlObjectStoreV1(dataDir);
    const fixture = await signedFixture('permissive-root-after-open');
    const paths = pathsFor(dataDir, fixture.envelope);
    if (process.platform === 'win32') {
      grantWindowsEveryoneRead(paths.root, 'directory');
    } else {
      await chmod(paths.root, 0o777);
    }

    await expect(store.stageVerifiedObjects([fixture]))
      .rejects.toMatchObject({ code: 'control-store-unsafe-path' });
    await expect(stat(paths.object)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(paths.signature)).rejects.toMatchObject({ code: 'ENOENT' });
    await store.close();
  });

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
});
