import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OxigraphStore } from '../src/adapters/oxigraph.js';
import { SharedMemoryLiteralBlobStore, EXTERNAL_LITERAL_REF_DATATYPE } from '../src/shared-memory-literal-blob-store.js';
import type { AtomicAssetReplacement } from '../src/atomic-asset-group.js';

function member(id: number, data: string[], metadata: string[]): AtomicAssetReplacement {
  const graphUri = `did:dkg:context-graph:group-${id}/_shared_memory`;
  const metaGraphUri = `did:dkg:context-graph:meta-${id}/_shared_memory`;
  const metadataSubject = `urn:asset:${id}`;
  const quads = (values: string[], graph: string) => values.map((value, n) => ({
    graph, subject: metadataSubject, predicate: `urn:value:${n}`, object: JSON.stringify(value),
  }));
  return { graphUri, metaGraphUri, metadataSubject,
    graphQuads: quads(data, graphUri), metadataQuads: quads(metadata, metaGraphUri) };
}

describe('literal blob asset group mapping', () => {
  it('retains named arrays, destinations and member order with unequal and empty arrays', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'blob-group-'));
    const inner = new OxigraphStore();
    const publish = vi.spyOn(inner, 'replaceAssetGroup').mockResolvedValue();
    const outer = new SharedMemoryLiteralBlobStore(inner, { blobDir: dir, thresholdBytes: 1 });
    const assets = [member(1, ['first', 'second'], []), member(2, [], ['third']), member(3, ['fourth'], ['fifth', 'sixth'])];
    const options = { signal: new AbortController().signal };
    try {
      await outer.replaceAssetGroup(assets, options);
      expect(publish).toHaveBeenCalledOnce();
      const [actual, forwarded] = publish.mock.calls[0]!;
      expect(forwarded).toBe(options);
      expect(actual).toHaveLength(assets.length);
      for (const [i, expected] of assets.entries()) {
        expect(actual[i]).toMatchObject({ graphUri: expected.graphUri, metaGraphUri: expected.metaGraphUri, metadataSubject: expected.metadataSubject });
        for (const key of ['graphQuads', 'metadataQuads'] as const) {
          expect(actual[i]![key]).toHaveLength(expected[key].length);
          for (const [n, quad] of expected[key].entries()) {
            const mapped = actual[i]![key][n]!;
            expect(mapped).toMatchObject({ graph: quad.graph, subject: quad.subject, predicate: quad.predicate });
            expect(mapped.object).toContain(EXTERNAL_LITERAL_REF_DATATYPE);
            const hash = mapped.object.match(/^"sha256:([a-f0-9]{64})"/)![1]!;
            expect(await readFile(join(dir, hash), 'utf8')).toBe(quad.object);
          }
        }
      }
      expect(await readdir(dir)).toHaveLength(6);
      expect(assets[0]!.graphQuads[0]!.object).toBe('"first"');
    } finally { await outer.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it('does not publish any member when one externalization fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'blob-group-failure-'));
    const blocked = join(dir, 'file'); await writeFile(blocked, 'not a directory');
    const inner = new OxigraphStore();
    const publish = vi.spyOn(inner, 'replaceAssetGroup').mockResolvedValue();
    const outer = new SharedMemoryLiteralBlobStore(inner, { blobDir: blocked, thresholdBytes: 1 });
    try {
      await expect(outer.replaceAssetGroup([member(1, [], []), member(2, ['large'], [])])).rejects.toThrow();
      expect(publish).not.toHaveBeenCalled();
    } finally { await outer.close(); await rm(dir, { recursive: true, force: true }); }
  });
});
