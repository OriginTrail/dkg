import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { contextGraphSharedMemoryUri } from '@origintrail-official/dkg-core';
import { resolvePublishRootEntities } from '../src/daemon/routes/memory.js';

// Regression for the OT-RFC-46 read-both gap (publish-from-SWM after promote).
//
// `promote` (POST /api/knowledge-assets/:name/swm/share) writes a minted KA's
// quads into the PER-KA SWM layer graph `<bucket>/<addr>/<num>`. The
// selection-mode publish pre-check `resolvePublishRootEntities` used to query
// ONLY the bare `<bucket>`, so it found nothing and the route returned a
// spurious HTTP 400 "No quads in shared memory ... matching selection" — even
// though `publishFromSharedMemory` itself reads both layouts and would have
// published fine. The fix scopes the pre-check to read BOTH the bucket and its
// per-KA layer graphs, while excluding the `/staging/` sub-tree.
describe('resolvePublishRootEntities — OT-RFC-46 read-both SWM scope', () => {
  const CG = '0x1111111111111111111111111111111111111111/readboth-cg';
  const ADDR = '0x1111111111111111111111111111111111111111';
  const ROOT = 'urn:test:finding:rb1';
  const PREDICATE = 'http://schema.org/about';
  const OBJECT = 'urn:test:thing:rb1';

  const bucket = contextGraphSharedMemoryUri(CG);
  const perKaGraph = `${bucket}/${ADDR}/1`; // promote target (per-KA SWM layer)
  const stagingGraph = `${bucket}/staging/${ADDR}/1`; // must stay excluded

  let store: OxigraphStore;
  // resolvePublishRootEntities only touches agent.store.query.
  const agentWith = (s: OxigraphStore) =>
    ({ store: s }) as unknown as Parameters<typeof resolvePublishRootEntities>[0];

  beforeEach(() => {
    store = new OxigraphStore();
  });

  it('finds a root that promote wrote into the per-KA SWM layer graph', async () => {
    await store.insert([{ subject: ROOT, predicate: PREDICATE, object: OBJECT, graph: perKaGraph }]);
    const roots = await resolvePublishRootEntities(agentWith(store), CG, { rootEntities: [ROOT] });
    expect(roots).toEqual([ROOT]);
  });

  it('still finds a root written into the bare bucket (no regression)', async () => {
    await store.insert([{ subject: ROOT, predicate: PREDICATE, object: OBJECT, graph: bucket }]);
    const roots = await resolvePublishRootEntities(agentWith(store), CG, { rootEntities: [ROOT] });
    expect(roots).toEqual([ROOT]);
  });

  it('"all" selection also surfaces a per-KA-layer root', async () => {
    await store.insert([{ subject: ROOT, predicate: PREDICATE, object: OBJECT, graph: perKaGraph }]);
    const roots = await resolvePublishRootEntities(agentWith(store), CG, 'all');
    expect(roots).toContain(ROOT);
  });

  it('excludes the /staging/ sub-tree', async () => {
    await store.insert([{ subject: ROOT, predicate: PREDICATE, object: OBJECT, graph: stagingGraph }]);
    const roots = await resolvePublishRootEntities(agentWith(store), CG, { rootEntities: [ROOT] });
    expect(roots).toEqual([]);
  });
});
