import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphManager, OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  resolveKnowledgeAssetOperationPublicQuads,
  resolveLiftWorkspaceSlice,
  storeKnowledgeAssetOperationPublicQuads,
  storeWorkspaceOperationPublicQuads,
} from '../src/workspace-resolution.js';
import { WORKSPACE_DIGEST_ORDERING_ENV } from '../src/workspace-public-quads-digest.js';
import type { WorkspacePublicSnapshotStore } from '../src/workspace-snapshot-store.js';
import { divergentObjectQuads, referenceDigest, useAmbientCollation } from './_helpers/digest-locale.js';

/**
 * Metadata records the digest of the snapshot it points at, in whatever form
 * the node that wrote it produced. A node reading it back (after an upgrade,
 * on another locale, or after the operator opts into code-unit digests) must
 * treat any accepted form of the same content as intact, and still reject
 * content that differs.
 */
const CONTEXT_GRAPH = 'digest-form-resolution';
const UAL = 'did:dkg:otp:20430/0x1111111111111111111111111111111111111111/9';
const ROOT = 'urn:x:root';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function memorySnapshots() {
  const snapshots = new Map<string, Quad[]>();
  const store: WorkspacePublicSnapshotStore = {
    async putSnapshot({ digest, quads }) {
      snapshots.set(digest, quads.map((quad) => ({ ...quad })));
      return { ref: digest, byteLength: 0 };
    },
    async getSnapshot(ref) {
      return snapshots.get(ref) ?? null;
    },
  };
  return { snapshots, store };
}

describe('graph-scoped operation snapshot resolution', () => {
  const quads = divergentObjectQuads('urn:asset');

  async function recorded(gate?: 'code-unit') {
    const store = new OxigraphStore();
    const graphManager = new GraphManager(store);
    const { snapshots, store: publicSnapshotStore } = memorySnapshots();
    if (gate) vi.stubEnv(WORKSPACE_DIGEST_ORDERING_ENV, gate);
    await storeKnowledgeAssetOperationPublicQuads({
      store, graphManager, contextGraphId: CONTEXT_GRAPH, shareOperationId: 'op-1',
      kaUal: UAL, assertionVersion: 1, quads, privateTripleCount: 0, publisherPeerId: 'peer',
      publicSnapshotStore,
    });
    if (gate) vi.unstubAllEnvs();
    const resolve = () => resolveKnowledgeAssetOperationPublicQuads({
      store, graphManager, contextGraphId: CONTEXT_GRAPH, shareOperationId: 'op-1',
      kaUal: UAL, assertionVersion: 1, publicSnapshotStore,
    });
    return { snapshots, resolve };
  }

  it('resolves a snapshot recorded under the en-US digest on a da-DK node and reports the recorded digest', async () => {
    const { resolve } = await recorded();
    const enUS = referenceDigest(quads, 'en-US');
    useAmbientCollation('da-DK');
    const resolved = await resolve();
    expect(resolved.quads).toHaveLength(quads.length);
    expect(resolved.publicQuadsDigest).toBe(enUS);
    expect(resolved.publicQuadsDigest).not.toBe(referenceDigest(quads, 'da-DK'));
  });

  it('resolves a snapshot recorded under the code-unit digest on a node still writing legacy digests', async () => {
    const { resolve } = await recorded('code-unit');
    const resolved = await resolve();
    expect(resolved.publicQuadsDigest).toBe(referenceDigest(quads, 'code-unit'));
    expect(resolved.quads).toHaveLength(quads.length);
  });

  it('resolves a snapshot recorded under the legacy digest on a node that opted into code-unit digests', async () => {
    const { resolve } = await recorded();
    vi.stubEnv(WORKSPACE_DIGEST_ORDERING_ENV, 'code-unit');
    const resolved = await resolve();
    expect(resolved.publicQuadsDigest).toBe(referenceDigest(quads, 'en-US'));
  });

  it('still fails closed when the stored bytes are not the recorded content', async () => {
    const { snapshots, resolve } = await recorded();
    const [ref] = [...snapshots.keys()];
    snapshots.set(ref!, [...quads.slice(1), { ...quads[0]!, object: '"tampered"' }]);
    await expect(resolve()).rejects.toThrow(/missing or corrupt/u);
    snapshots.set(ref!, quads.slice(1));
    await expect(resolve()).rejects.toThrow(/missing or corrupt/u);
  });
});

describe('compact workspace operation snapshot resolution', () => {
  const quads = divergentObjectQuads(ROOT);

  async function recorded(gate?: 'code-unit') {
    const store = new OxigraphStore();
    const graphManager = new GraphManager(store);
    const { snapshots, store: publicSnapshotStore } = memorySnapshots();
    if (gate) vi.stubEnv(WORKSPACE_DIGEST_ORDERING_ENV, gate);
    await storeWorkspaceOperationPublicQuads({
      store, graphManager, contextGraphId: CONTEXT_GRAPH, shareOperationId: 'op-compact',
      rootEntities: [ROOT], quads, publisherPeerId: 'peer', publicSnapshotStore,
    });
    if (gate) vi.unstubAllEnvs();
    const resolve = () => resolveLiftWorkspaceSlice({
      store, graphManager, publicSnapshotStore,
      request: { shareOperationId: 'op-compact', roots: [ROOT], contextGraphId: CONTEXT_GRAPH },
    });
    return { snapshots, resolve };
  }

  it('resolves a snapshot recorded under the en-US digest on a da-DK node', async () => {
    const { resolve } = await recorded();
    useAmbientCollation('da-DK');
    await expect(resolve()).resolves.toMatchObject({ quads: expect.arrayContaining([quads[0]]) });
  });

  it('resolves a snapshot recorded under the code-unit digest on a node still writing legacy digests', async () => {
    const { resolve, snapshots } = await recorded('code-unit');
    expect([...snapshots.keys()]).toEqual([referenceDigest(quads, 'code-unit')]);
    await expect(resolve()).resolves.toMatchObject({ quads: expect.arrayContaining([quads[0]]) });
  });

  it('reports a root as stale when its snapshot differs from every accepted form', async () => {
    const { snapshots, resolve } = await recorded();
    const [ref] = [...snapshots.keys()];
    snapshots.set(ref!, [...quads.slice(1), { ...quads[0]!, object: '"tampered"' }]);
    await expect(resolve()).rejects.toThrow(/missing or corrupt/u);
  });
});
