import type { DKGAgent } from '@origintrail-official/dkg-agent';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { describe, expect, it, vi } from 'vitest';
import { persistKnowledgeAsset } from '../src/semantic-runtime-receipt-lifecycle.js';

const datatype = 'http://www.w3.org/2001/XMLSchema#dateTime';
const literal = (value: string) => `"${value}"^^<${datatype}>`;
const triple = (object: string) => ({ subject: 'urn:execution:1', predicate: 'http://www.w3.org/ns/prov#endedAtTime', object });

async function fixture(expected: string, existing?: string) {
  const store = new OxigraphStore();
  const history = { memoryLayer: 'WM', wmCurrentAssertion: undefined as string | undefined };
  if (existing) await store.insert([{ ...triple(existing), graph: 'urn:receipt' }]);
  const assertion = {
    history: vi.fn(async () => ({ ...history })),
    create: vi.fn(),
    query: vi.fn(async () => {
      const result = await store.query('CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <urn:receipt> { ?s ?p ?o } }');
      if (result.type !== 'quads') throw new Error('Expected quads');
      return result.quads;
    }),
    write: vi.fn(async (_graph: string, _name: string, rows: ReturnType<typeof triple>[]) => {
      await store.insert(rows.map(q => ({ ...q, graph: 'urn:receipt' })));
    }),
    finalize: vi.fn(async () => { history.wmCurrentAssertion = 'sealed-assertion'; }),
  };
  const agent = { assertion } as unknown as DKGAgent;
  return {
    store, assertion,
    persist: () => persistKnowledgeAsset(agent, 'graph', 'receipt', 'owner', [triple(expected)], history as never, 'wm',
      { layerConflict: 'EXECUTION_LAYER_CONFLICT', shareFailed: 'share', publishFailed: 'publish', subject: 'Execution' }, async () => {}),
  };
}

describe('exact receipt timestamp readback through Oxigraph', () => {
  it.each(['.000', '.010', '.300', '.630', '.610', '.123'])('persists %s seconds despite store lexical normalization', async fraction => {
    const f = await fixture(literal(`2026-11-03T10:40:28${fraction}Z`));
    try {
      await expect(f.persist()).resolves.toEqual({ layer: 'wm' });
      expect(f.assertion.write).toHaveBeenCalledTimes(1);
      expect(f.assertion.finalize).toHaveBeenCalledTimes(1);
    } finally { await f.store.close(); }
  });

  it.each(['2026-11-03T10:40:28.3Z', '2026-11-03T10:40:28.3000Z', '2026-11-03T11:40:28.300+01:00'])('recovers an existing equal instant %s without another write', async value => {
    const f = await fixture(literal('2026-11-03T10:40:28.300Z'), literal(value));
    try {
      await expect(f.persist()).resolves.toEqual({ layer: 'wm' });
      expect(f.assertion.write).not.toHaveBeenCalled();
    } finally { await f.store.close(); }
  });

  it.each([
    literal('2026-11-03T10:40:28.301Z'),
    literal('2026-11-03T10:40:28.3001Z'),
    literal('2026-11-03T10:40:28.300'),
    literal('2026-02-30T10:40:28.300Z'),
    '"2026-11-03T10:40:28.300Z"',
    '"different-content"',
  ])('refuses changed or inexact content: %s', async value => {
    const f = await fixture(literal('2026-11-03T10:40:28.300Z'), value);
    try {
      await expect(f.persist()).rejects.toMatchObject({ code: 'EXECUTION_LAYER_CONFLICT' });
      expect(f.assertion.write).not.toHaveBeenCalled();
      expect(f.assertion.finalize).not.toHaveBeenCalled();
    } finally { await f.store.close(); }
  });
});
