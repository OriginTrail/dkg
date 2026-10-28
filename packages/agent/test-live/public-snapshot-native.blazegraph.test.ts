import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkpointFixture } from '../test/helpers/public-checkpoint-fixture.js';
import { cg } from '../test/helpers/bulk-graph-fixture.js';
import { buildNativeSnapshotCheckpoint } from '../src/snapshot-native-build.js';
import { openSnapshotNativeStore } from '../src/snapshot-native-store.js';
import { auditSnapshotCheckpoint } from '../src/snapshot-checkpoint-audit.js';
import { assertPublicSnapshotQueryTrust } from '../src/public-snapshot-evidence.js';

// This lane must provide a SHA-pinned runtime. Missing configuration is a failure, never a skip.
const runtime = { java: process.env.DKG_PUBLIC_CHECKPOINT_JAVA ?? '', jar: process.env.DKG_PUBLIC_CHECKPOINT_JAR ?? '',
  jarSha256: process.env.DKG_PUBLIC_CHECKPOINT_JAR_SHA256 ?? '' };

it.each(['rpc-only', 'core-cache'] as const)('loads and audits verified %s artifacts through the real native journal', async mode => {
  const f = await checkpointFixture({ payloadBytes: [14, 4000, 14], transformPayload: plain => plain.trimEnd()
    + `\t<urn:unverified>\t<urn:p>\t"injected"\t<did:dkg:context-graph:${cg}/_meta> .\n` }, mode);
  const prepared = await f.run();
  const folder = join(prepared.directory, 'native');
  const signal = AbortSignal.timeout(prepared.manifest.deadline - Date.now());
  try {
    const built = await buildNativeSnapshotCheckpoint(prepared, { ...runtime, signal,
      assertInventoryCurrent: async () => { expect((await f.readFresh()).snapshot.inventoryDigest).toBe(prepared.manifest.observation.snapshot.inventoryDigest); } });
    expect(built).toMatchObject({ assets: 3, fullReadback: true, current: false, activeStoreChanged: false });
    const store = await openSnapshotNativeStore({ ...runtime, folder, properties: join(folder, 'audit.properties'),
      log: join(folder, 'test-readback.log'), signal });
    try {
      // Reopen the actual DataLoader journal and exercise roots, versions, counts and bounded smokes.
      expect(await auditSnapshotCheckpoint(store, prepared.manifest, signal)).toEqual({ assets: 3, fullReadback: true,
        publicQuads: prepared.manifest.assets.reduce((n, a) => n + a.publicQuads, 0) });
      expect(await store.query(`ASK { GRAPH <did:dkg:context-graph:${cg}/_meta> { <urn:unverified> ?p ?o } }`,
        { signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]) })).toMatchObject({ type: 'boolean', value: false });
      const query = assertPublicSnapshotQueryTrust(store, cg, undefined, { signal });
      if (mode === 'core-cache') await expect(query).rejects.toMatchObject({ code: 'CORE_CACHE_QUERY_TRUST_REQUIRED' });
      else await query;
    } finally { await store.close(); await store.close(); }
    expect(await f.target.countQuads()).toBe(0);
  } catch (error) {
    for (const name of ['loader.log', 'audit.log', 'test-readback.log']) {
      const log = await readFile(join(folder, name), 'utf8').catch(() => 'not created');
      console.error(`${name}: ${log.slice(-8000)}`);
    }
    throw error;
  }
}, 30_000);
