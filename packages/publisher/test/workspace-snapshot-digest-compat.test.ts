import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Quad } from '@origintrail-official/dkg-storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WORKSPACE_DIGEST_ORDERING_ENV } from '../src/workspace-public-quads-digest.js';
import { FileWorkspacePublicSnapshotStore } from '../src/workspace-snapshot-store.js';
import { readSnapshotSource } from '../src/workspace-snapshot-source.js';
import {
  DIVERGENT_QUADS,
  divergentDigests,
  useAmbientCollation,
} from '../../../scripts/testing/digest-locale.js';
import { snapshotPath } from './_helpers/workspace-snapshot-store.js';

vi.mock('../src/workspace-snapshot-source.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/workspace-snapshot-source.js')>();
  return { ...actual, readSnapshotSource: vi.fn(actual.readSnapshotSource) };
});

/**
 * A snapshot file is named by its digest, and a node keeps validating files it
 * persisted before an upgrade. These tests use a real store on real files and
 * digests computed by an independent oracle, so they hold on a base commit
 * that has no notion of digest forms: there a code-unit digest is rejected.
 */
const tempDirs: string[] = [];
const options = { gc: { enabled: false } };

async function newStore() {
  const directory = await mkdtemp(join(tmpdir(), 'dkg-snapshot-digest-compat-'));
  tempDirs.push(directory);
  return { directory, store: new FileWorkspacePublicSnapshotStore(directory, undefined, options) };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.mocked(readSnapshotSource).mockClear();
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('snapshot validation across digest forms', () => {
  const { codeUnit, enUS, daDK } = divergentDigests();
  const count = DIVERGENT_QUADS.length;

  it('still validates and reads a snapshot persisted under its legacy digest after the gate flips', async () => {
    const { directory, store } = await newStore();
    await store.putSnapshot({ digest: enUS, quads: [...DIVERGENT_QUADS] });
    const persistedBytes = await readFile(snapshotPath(directory, enUS), 'utf8');

    vi.stubEnv(WORKSPACE_DIGEST_ORDERING_ENV, 'code-unit');
    const upgraded = new FileWorkspacePublicSnapshotStore(directory, undefined, options);
    await expect(upgraded.validateSnapshot(enUS, enUS, count)).resolves.toBe(true);
    await expect(upgraded.getSnapshot(enUS)).resolves.toEqual(DIVERGENT_QUADS);
    // Nothing was renamed, rewritten or orphaned.
    expect(await readFile(snapshotPath(directory, enUS), 'utf8')).toBe(persistedBytes);
  });

  it('validates a snapshot named by its code-unit digest on a node still writing legacy digests', async () => {
    const { store } = await newStore();
    await store.putSnapshot({ digest: codeUnit, quads: [...DIVERGENT_QUADS] });
    await expect(store.validateSnapshot(codeUnit, codeUnit, count)).resolves.toBe(true);
    await expect(store.getSnapshot(codeUnit)).resolves.toEqual(DIVERGENT_QUADS);
  });

  it('validates a snapshot named by its code-unit digest on a node that writes them', async () => {
    vi.stubEnv(WORKSPACE_DIGEST_ORDERING_ENV, 'code-unit');
    const { store } = await newStore();
    await store.putSnapshot({ digest: codeUnit, quads: [...DIVERGENT_QUADS] });
    await expect(store.validateSnapshot(codeUnit, codeUnit, count)).resolves.toBe(true);
  });

  it('accepts the digest the sender advertised whichever form it is, from one read of the file', async () => {
    const { store } = await newStore();
    await store.putSnapshot({ digest: enUS, quads: [...DIVERGENT_QUADS] });
    vi.mocked(readSnapshotSource).mockClear();
    // The same immutable file answered for either form of its content digest.
    await expect(store.validateSnapshot(enUS, enUS, count)).resolves.toBe(true);
    await expect(store.validateSnapshot(enUS, codeUnit, count)).resolves.toBe(true);
    await expect(store.validateSnapshot(enUS, `sha256:${'0'.repeat(64)}`, count)).resolves.toBe(false);
    expect(vi.mocked(readSnapshotSource)).toHaveBeenCalledTimes(1);
  });

  it('rejects tampered bytes and a wrong count under every form', async () => {
    const tamperedStore = (await newStore()).store;
    const tampered: Quad[] = [...DIVERGENT_QUADS.slice(1), { ...DIVERGENT_QUADS[0]!, object: '"tampered"' }];
    // Stored under the ref of the honest content but holding other bytes.
    await tamperedStore.putSnapshot({ digest: codeUnit, quads: tampered });
    for (const expected of [codeUnit, enUS]) {
      await expect(tamperedStore.validateSnapshot(codeUnit, expected, count)).resolves.toBe(false);
    }
    const honestStore = (await newStore()).store;
    await honestStore.putSnapshot({ digest: codeUnit, quads: [...DIVERGENT_QUADS] });
    await expect(honestStore.validateSnapshot(codeUnit, codeUnit, count + 1)).resolves.toBe(false);
    await expect(honestStore.validateSnapshot(codeUnit, enUS, count - 1)).resolves.toBe(false);
  });

  it('on a differently configured host accepts its own legacy digest, the code-unit digest and the en-US majority digest', async () => {
    useAmbientCollation('da-DK');
    const { store } = await newStore();
    await store.putSnapshot({ digest: daDK, quads: [...DIVERGENT_QUADS] });
    for (const expected of [daDK, codeUnit, enUS]) {
      await expect(store.validateSnapshot(daDK, expected, count)).resolves.toBe(true);
    }
  });

  it('is what lets a da-DK verifier accept a snapshot an en-US node persisted', async () => {
    const { store } = await newStore();
    await store.putSnapshot({ digest: enUS, quads: [...DIVERGENT_QUADS] });
    useAmbientCollation('da-DK');
    await expect(store.validateSnapshot(enUS, enUS, count)).resolves.toBe(true);
  });
});
