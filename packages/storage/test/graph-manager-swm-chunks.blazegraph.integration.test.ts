import { describe, expect, it } from 'vitest';
import { BlazegraphStore } from '../src/adapters/blazegraph.js';
import { loadSelectedSharedMemoryQuads } from '../src/graph-manager.js';
import type { Quad } from '../src/triple-store.js';
import { contextGraphSharedMemoryUri } from '@origintrail-official/dkg-core';

const url = process.env.BLAZEGRAPH_TEST_URL;

describe.skipIf(!url)('complete SWM read on live Blazegraph', () => {
  it('reads across query chunks and globally deduplicates a recurring root', async () => {
    const store = new BlazegraphStore(url as string, { timeout: 30_000 });
    const swm = contextGraphSharedMemoryUri(`swm-chunks-${Date.now()}`);
    const root = `urn:swm-chunks:${Date.now()}:root`;
    const child = `${root}/.well-known/genid/child`;
    const quads: Quad[] = Array.from({ length: 130 }, (_, i) => ({
      subject: `urn:swm-chunks:decoy:${i}`,
      predicate: 'urn:p',
      object: '"decoy"',
      graph: `${swm}/0xabcdef0123456789abcdef0123456789abcdef01/${i + 1}`,
    }));
    quads.push(
      { subject: root, predicate: 'urn:p', object: '"same"', graph: quads[0]!.graph },
      { subject: root, predicate: 'urn:p', object: '"same"', graph: quads[129]!.graph },
      { subject: child, predicate: 'urn:p', object: '"child"', graph: quads[129]!.graph },
    );
    try {
      await store.insert(quads);
      const selected = await loadSelectedSharedMemoryQuads(
        store,
        swm,
        { rootEntities: [root] },
        { resultBudget: { pageRows: 1, maxRows: 2, maxBytesEstimate: 1024 * 1024 } },
      );
      expect(selected.map((q) => [q.subject, q.predicate, q.object].join('|')).sort()).toEqual([
        `${child}|urn:p|"child"`,
        `${root}|urn:p|"same"`,
      ].sort());
    } finally {
      await store.delete(quads).catch(() => {});
      await store.close();
    }
  }, 60_000);
});
