import { afterEach, describe, expect, it, vi } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { contextGraphMetaUri } from '@origintrail-official/dkg-core';
import { computeFlatKCRootV10 } from '@origintrail-official/dkg-publisher';
import { auditSnapshotCheckpoint } from '../src/snapshot-checkpoint-audit.js';
import { markCoreTrustedGraph } from '../src/public-snapshot-evidence.js';

const stores: OxigraphStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); });
async function fixture(mode: 'rpc-only' | 'core-cache' = 'rpc-only') {
  const store = new OxigraphStore(); stores.push(store);
  const graph = 'urn:asset:content', ual = 'urn:asset:identity', contextGraphId = 'checkpoint-audit';
  const data: Quad[] = [{ subject: 'urn:subject', predicate: 'urn:predicate', object: '"value"', graph }];
  const root = Buffer.from(computeFlatKCRootV10(data, [])).toString('hex');
  const metaGraph = contextGraphMetaUri(contextGraphId);
  await store.insert([...data,
    { subject: ual, predicate: 'http://dkg.io/ontology/merkleRoot', object: JSON.stringify(`0x${root}`), graph: metaGraph },
    { subject: ual, predicate: 'http://dkg.io/ontology/assertionVersion', object: '"1"^^<http://www.w3.org/2001/XMLSchema#integer>', graph: metaGraph },
  ]);
  if (mode === 'core-cache') await markCoreTrustedGraph(store, contextGraphId);
  const manifest = { observation: { mode, snapshot: { contextGraphId } },
    assets: [{ ual, graph, root, version: '1', publicQuads: 1 }],
  } as unknown as Parameters<typeof auditSnapshotCheckpoint>[1];
  return { store, manifest, data, metaGraph, signal: new AbortController().signal };
}

describe('full native journal readback', () => {
  it.each(['bare', 'plain', 'typed'] as const)('accepts %s metadata bindings using the shared literal decoder', async representation => {
    const f = await fixture(), query = f.store.query.bind(f.store);
    const literal = (value: string, datatype: string) => representation === 'bare' ? value
      : JSON.stringify(value) + (representation === 'typed' ? `^^<http://www.w3.org/2001/XMLSchema#${datatype}>` : '');
    vi.spyOn(f.store, 'query').mockImplementation(async (sparql, options) => {
      const result = await query(sparql, options);
      if (result.type === 'bindings' && sparql.includes('SELECT ?ual ?root ?version')) {
        for (const row of result.bindings) {
          row.root = literal(`0x${f.manifest.assets[0]!.root}`, 'string'); row.version = literal('1', 'integer');
        }
      }
      if (result.type === 'bindings' && sparql.includes('COUNT(*) AS ?n')) result.bindings[0]!.n = literal('1', 'integer');
      return result;
    });
    await expect(auditSnapshotCheckpoint(f.store, f.manifest, f.signal)).resolves.toEqual({ assets: 1, publicQuads: 1, fullReadback: true });
  });
  it.each(['rpc-only', 'core-cache'] as const)('verifies every asset, total coverage and bounded queries in %s mode', async mode => {
    const f = await fixture(mode); const query = vi.spyOn(f.store, 'query');
    await expect(auditSnapshotCheckpoint(f.store, f.manifest, f.signal)).resolves.toEqual({ assets: 1, publicQuads: 1, fullReadback: true });
    expect(query.mock.calls.every(([, options]) => options?.signal instanceof AbortSignal)).toBe(true);
    expect(query.mock.calls.some(([sparql]) => sparql.includes('checkpoint:absent'))).toBe(true);
  });
  it.each(['metadata', 'version', 'content', 'extra graph', 'trust'] as const)('refuses incomplete or altered %s', async failure => {
    const f = await fixture(failure === 'trust' ? 'core-cache' : 'rpc-only');
    if (failure === 'metadata') await f.store.dropGraph(f.metaGraph);
    if (failure === 'version') f.manifest.assets[0]!.version = '2';
    if (failure === 'content') {
      await f.store.dropGraph(f.data[0]!.graph);
      await f.store.insert([{ ...f.data[0]!, object: '"changed"' }]);
    }
    if (failure === 'extra graph') await f.store.insert([{ ...f.data[0]!, graph: 'urn:unexpected' }]);
    if (failure === 'trust') await f.store.dropGraph('urn:dkg:local:public-snapshot-trust');
    const message = { metadata: 'metadata coverage', version: 'identity or version', content: 'readback failed', 'extra graph': 'total coverage', trust: 'trust guard missing' }[failure];
    await expect(auditSnapshotCheckpoint(f.store, f.manifest, f.signal)).rejects.toThrow(message);
  });
});
