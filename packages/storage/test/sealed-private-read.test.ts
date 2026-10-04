import { describe, expect, it, vi } from 'vitest';
import { createGraphKnowledgeAssetScope } from '@origintrail-official/dkg-core';
import { GraphManager, OxigraphStore, PrivateContentStore, type Quad } from '../src/index.js';

const CG = 'sealed-private-selection';
const scope = createGraphKnowledgeAssetScope('did:dkg:mock:31337/0x1111111111111111111111111111111111111111/9', 1);
const payload = (value: string): Quad[] => [{ subject: 'urn:private', predicate: 'urn:secret', object: `"${value}"`, graph: '' }];
const root = 'ab'.repeat(32);

describe('sealed private read boundary', () => {
  it('returns zero-count content without reading a reused private version or archive', async () => {
    const store = new OxigraphStore();
    try {
      const privateStore = new PrivateContentStore(store, new GraphManager(store));
      await privateStore.replaceKnowledgeAssetPrivateTriples(CG, scope, payload('new-unshared'), undefined, root);
      const read = vi.spyOn(store, 'query');
      const count = vi.spyOn(store, 'countQuads');
      expect(await privateStore.getSealedKnowledgeAssetPrivateTriples(CG, scope,
        { privateTripleCount: 0, privateMerkleRoot: undefined })).toEqual([]);
      expect(read).not.toHaveBeenCalled();
      expect(count).not.toHaveBeenCalled();
    } finally { await store.close(); }
  });

  it.each(['hex', 'bytes'] as const)('selects the sealed archive over the reused latest version (%s)', async kind => {
    const store = new OxigraphStore();
    try {
      const privateStore = new PrivateContentStore(store, new GraphManager(store));
      await privateStore.replaceKnowledgeAssetPrivateTriples(CG, scope, payload('shared-b'), undefined, root);
      await privateStore.replaceKnowledgeAssetPrivateTriples(CG, scope, payload('unshared-c'), undefined, 'cd'.repeat(32));
      const privateMerkleRoot = kind === 'hex' ? `0x${root}` : new Uint8Array(32).fill(0xab);
      expect(await privateStore.getSealedKnowledgeAssetPrivateTriples(CG, scope,
        { privateTripleCount: 1, privateMerkleRoot })).toEqual(payload('shared-b'));
      expect(await privateStore.getKnowledgeAssetPrivateTriples(CG, scope)).toEqual(payload('unshared-c'));
    } finally { await store.close(); }
  });

  it('uses pre-upgrade version content with the authenticated count and enforces archive counts', async () => {
    const store = new OxigraphStore();
    try {
      const privateStore = new PrivateContentStore(store, new GraphManager(store));
      await privateStore.replaceKnowledgeAssetPrivateTriples(CG, scope, payload('pre-upgrade'));
      expect(await privateStore.getSealedKnowledgeAssetPrivateTriples(CG, scope,
        { privateTripleCount: 1, privateMerkleRoot: root })).toEqual(payload('pre-upgrade'));
      await expect(privateStore.getSealedKnowledgeAssetPrivateTriples(CG, scope,
        { privateTripleCount: 2, privateMerkleRoot: root })).rejects.toMatchObject({ code: 'QUAD_COUNT_MISMATCH' });
      await privateStore.archiveKnowledgeAssetPrivateTriples(CG, scope, payload('archive'), root);
      await expect(privateStore.getSealedKnowledgeAssetPrivateTriples(CG, scope,
        { privateTripleCount: 2, privateMerkleRoot: root })).rejects.toMatchObject({ code: 'QUAD_COUNT_MISMATCH' });
    } finally { await store.close(); }
  });

  it('refuses invalid authenticated counts and missing positive-count commitments before store reads', async () => {
    const store = new OxigraphStore();
    try {
      const privateStore = new PrivateContentStore(store, new GraphManager(store));
      const read = vi.spyOn(store, 'query');
      const count = vi.spyOn(store, 'countQuads');
      for (const privateTripleCount of [-1, 1.5, Number.NaN]) {
        await expect(privateStore.getSealedKnowledgeAssetPrivateTriples(CG, scope,
          { privateTripleCount, privateMerkleRoot: root })).rejects.toThrow('non-negative safe integer');
      }
      await expect(privateStore.getSealedKnowledgeAssetPrivateTriples(CG, scope,
        { privateTripleCount: 1, privateMerkleRoot: undefined })).rejects.toThrow('Merkle root');
      expect(read).not.toHaveBeenCalled();
      expect(count).not.toHaveBeenCalled();
    } finally { await store.close(); }
  });
});
