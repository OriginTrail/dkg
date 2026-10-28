import { normalizePublicGraphSnapshot, sealPublicGraphSnapshot } from '@origintrail-official/dkg-chain';
import { sealSnapshotOf, makeSnapshotAssets } from './public-snapshot-assets.js';
import { afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { preparePublicSnapshotCheckpoint } from '../../src/public-snapshot-checkpoint.js';
import { nativeCheckpointProperties } from '../../src/snapshot-native-properties.js';

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
export const digest = (text: string) => createHash('sha256').update(text).digest('hex');

/** Byte-sized lifecycle fixture. No JVM, live store, credentials or retained dataset. */
export async function nativeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'native-checkpoint-unit-')); directories.push(root);
  const directory = join(root, 'prepared'); await mkdir(join(directory, 'load'), { recursive: true });
  const jar = join(root, 'fixture.jar'); await writeFile(jar, 'runtime');
  const load = { '000000.verified.nq.gz': 'data', '000000.verified.meta.nq': 'meta', 'trust.nq': 'trust' };
  for (const [name, bytes] of Object.entries(load)) await writeFile(join(directory, 'load', name), bytes);
  const sealed = sealPublicGraphSnapshot({ ...sealSnapshotOf('graph', makeSnapshotAssets('graph', 1)),
    chainId: 'base:84532', deploymentId: 'fixture', onChainId: '14' });
  const snapshot = normalizePublicGraphSnapshot(sealed, sealed);
  const observation = { mode: 'rpc-only', sourceCore: null, snapshot };
  const prepared = { directory, manifest: { state: 'verified-unpublished', deadline: Date.now() + 30_000,
    observation, freshObservation: observation, plainBytes: 100, encodedBytes: 10, trustSha256: digest('trust'),
    assets: [{ index: 0, ual: 'urn:asset', publicQuads: 1, dataSha256: digest('data'), metadataSha256: digest('meta') }],
  } } as unknown as Awaited<ReturnType<typeof preparePublicSnapshotCheckpoint>>;
  const runtime = { java: process.execPath, jar, jarSha256: digest('runtime') };
  return { root, prepared, runtime, signal: new AbortController().signal };
}

export async function handoffFixture() {
  const f = await nativeFixture();
  const folder = join(f.prepared.directory, 'native'); await mkdir(folder);
  const journal = join(folder, 'store.jnl'); await writeFile(journal, 'journal');
  await writeFile(join(folder, 'load.properties'), nativeCheckpointProperties(journal));
  const options = { ...f,
    config: { dataDir: join(f.root, 'edge'), chainAdapter: { chainId: 'base:84532', deploymentId: 'fixture' } },
    native: { state: 'verified-unpublished', fullReadback: true, inventoryDigest: f.prepared.manifest.observation.snapshot.inventoryDigest,
      runtimeSha256: f.runtime.jarSha256, journal, journalSha256: digest('journal') },
    sync: { mode: 'rpc-only', contextGraphId: 'graph', onChainId: '14', trustedCorePeerIds: ['fixture'] },
  } as unknown as Parameters<typeof import('../../src/snapshot-fresh-edge.js').createFreshPublicCheckpointEdge>[0];
  return { ...f, options, folder: join(options.config.dataDir, 'checkpoint-store') };
}
