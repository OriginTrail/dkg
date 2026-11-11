import { describe, expect, it, vi } from 'vitest';
import type { ViewQuerySemantics } from '@origintrail-official/dkg-core';
import type { QueryResult } from '../src/query-engine.js';
import {
  ViewSemanticsDeltaSampler, classifyViewSemanticsDelta, viewQueryShape, type ViewSemanticsDeltaSample,
} from '../src/view-semantics-delta.js';

const SELECT = 'SELECT ?s ?o WHERE { ?s ?p ?o }';
const rows = (...values: string[]): QueryResult => ({ bindings: values.map(o => ({ s: 'urn:s', o })) });

describe('classifying the merged answer against the per-asset answer', () => {
  it('tells apart the same rows, fewer copies, more rows or copies, and lost or changed rows', () => {
    expect(classifyViewSemanticsDelta(SELECT, rows('1', '2'), rows('2', '1'))).toBe('none');
    expect(classifyViewSemanticsDelta(SELECT, rows('1', '1', '2'), rows('1', '2'))).toBe('copies-removed');
    expect(classifyViewSemanticsDelta(SELECT, rows('1'), rows('1', '2'))).toBe('rows-added');
    expect(classifyViewSemanticsDelta(SELECT, rows('1'), rows('1', '1'))).toBe('rows-added');
    // One row loses a copy while another gains one: the answer has rows it did not have as often.
    expect(classifyViewSemanticsDelta(SELECT, rows('1', '1', '2'), rows('1', '2', '2'))).toBe('rows-added');
    expect(classifyViewSemanticsDelta(SELECT, rows('1', '2'), rows('1'))).toBe('rows-removed-or-changed');
    expect(classifyViewSemanticsDelta(SELECT, rows('1'), rows('2', '3'))).toBe('rows-removed-or-changed');
    const count = 'SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o }';
    expect(classifyViewSemanticsDelta(count, { bindings: [{ n: '"2"' }] }, { bindings: [{ n: '"1"' }] })).toBe('rows-removed-or-changed');
  });

  it('reads ASK as a match found or lost', () => {
    const ask = 'ASK { ?s ?p ?o }';
    const answer = (value: boolean): QueryResult => ({ bindings: [{ result: String(value) }] });
    expect(classifyViewSemanticsDelta(ask, answer(false), answer(true))).toBe('rows-added');
    expect(classifyViewSemanticsDelta(ask, answer(true), answer(false))).toBe('rows-removed-or-changed');
    expect(classifyViewSemanticsDelta(ask, answer(true), answer(true))).toBe('none');
  });

  it('compares quads by their terms, whatever the blank node labels', () => {
    const construct = 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }';
    const quads = (...items: Array<[string, string]>): QueryResult => ({ bindings: [],
      quads: items.map(([subject, object]) => ({ subject, predicate: 'urn:p', object, graph: '' })) });
    expect(classifyViewSemanticsDelta(construct, quads(['_:b1', 'urn:o']), quads(['_:x9', 'urn:o']))).toBe('none');
    expect(classifyViewSemanticsDelta(construct, quads(['urn:a', 'urn:o'], ['urn:a', 'urn:o']), quads(['urn:a', 'urn:o'])))
      .toBe('copies-removed');
    expect(classifyViewSemanticsDelta(construct, quads(), quads(['urn:a', 'urn:o']))).toBe('rows-added');
    expect(classifyViewSemanticsDelta(construct, quads(['urn:a', 'urn:o']), quads())).toBe('rows-removed-or-changed');
  });
});

describe('the shape of a query', () => {
  it('keeps the structure and masks every value', () => {
    expect(viewQueryShape('PREFIX ex: <http://ex.org/> SELECT ?p ?x WHERE { ?p a ex:Product . '
      + '?p <http://ex.org/price> ?x FILTER(?x > 10 && STR(?p) != "secret" && LANG(?x) = "en") }'))
      .toBe('SELECT ?p ?x WHERE { ?p a ex:… . ?p <…> ?x FILTER(?x > 0 && STR(?p) != "…" && LANG(?x) = "…") }');
    expect(viewQueryShape('SELECT ?s WHERE { ?s <urn:label> "Alice"@en }')).toBe('SELECT ?s WHERE { ?s <…> "…"@en }');
  });

  it('cuts a long shape', () => {
    const shape = viewQueryShape(`SELECT ?s WHERE { ${Array.from({ length: 200 }, (_, n) => `?s <urn:p${n}> ?o${n} .`).join(' ')} }`);
    expect(shape.length).toBe(401);
    expect(shape.endsWith('…')).toBe(true);
  });
});

function sample(answers: { perAsset: QueryResult; merged: QueryResult }, overrides: Partial<ViewSemanticsDeltaSample> = {}) {
  const run = vi.fn(async (semantics: ViewQuerySemantics) => (semantics === 'merged' ? answers.merged : answers.perAsset));
  const offered: ViewSemanticsDeltaSample = {
    contextGraphId: 'cg-a', view: 'verifiable-memory', sparql: SELECT, run, isCurrent: () => true, ...overrides,
  };
  return { offered, run };
}

describe('the semantic-delta sampler', () => {
  const at = (minute: number) => () => new Date(Date.UTC(2026, 10, 11, 2, minute));

  it('runs a sample both ways in the background, under the write lock, and keeps the summary', async () => {
    const onDelta = vi.fn();
    const sampler = new ViewSemanticsDeltaSampler({ sampleRate: 1, onDelta, now: at(5) });
    const lock = vi.fn(async <T>(work: () => Promise<T>) => work());
    const { offered, run } = sample({ perAsset: rows('1'), merged: rows('1', '2') }, { withWriteLock: lock });
    sampler.offer(offered);
    // The caller's answer does not wait: the sample runs after the current turn.
    expect(run).not.toHaveBeenCalled();
    await sampler.idle();
    expect(lock).toHaveBeenCalledTimes(1);
    expect(run.mock.calls).toEqual([['per-asset'], ['merged']]);
    expect(onDelta).toHaveBeenCalledWith('rows-added');
    expect(sampler.report()).toEqual([{
      contextGraphId: 'cg-a', since: '2026-11-11T02:05:00.000Z', samples: 1, skipped: 0,
      kinds: { 'none': 0, 'copies-removed': 0, 'rows-added': 1, 'rows-removed-or-changed': 0 },
      shapes: [{ shape: 'SELECT ?s ?o WHERE { ?s ?p ?o }', view: 'verifiable-memory', samples: 1, lastSampledAt: '2026-11-11T02:05:00.000Z',
        kinds: { 'none': 0, 'copies-removed': 0, 'rows-added': 1, 'rows-removed-or-changed': 0 } }],
    }]);
  });

  it('samples at its rate and drops offers beyond its queue', async () => {
    const draws = [0.5, 0.1, 0.1, 0.1];
    const sampler = new ViewSemanticsDeltaSampler({ sampleRate: 0.2, maxQueued: 2, random: () => draws.shift() ?? 0 });
    const { offered, run } = sample({ perAsset: rows('1'), merged: rows('1') });
    sampler.offer(offered); // 0.5: not sampled
    sampler.offer(offered); // waits
    sampler.offer(offered); // waits
    sampler.offer(offered); // the queue is full
    await sampler.idle();
    expect(run).toHaveBeenCalledTimes(4);
    expect(sampler.report()[0]).toMatchObject({ samples: 2, kinds: { none: 2 } });
  });

  it('skips a sample whose read graph changed, or whose read failed', async () => {
    const sampler = new ViewSemanticsDeltaSampler({ sampleRate: 1 });
    sampler.offer(sample({ perAsset: rows('1'), merged: rows('2') }, { isCurrent: () => false }).offered);
    const failing = sample({ perAsset: rows('1'), merged: rows('1') });
    failing.run.mockRejectedValueOnce(new Error('store unavailable'));
    sampler.offer(failing.offered);
    // So is one whose read graph cannot be checked after the reads.
    sampler.offer(sample({ perAsset: rows('1'), merged: rows('1') }, { isCurrent: () => { throw new Error('state unavailable'); } }).offered);
    await sampler.idle();
    expect(sampler.report()[0]).toMatchObject({ samples: 0, skipped: 3 });
  });

  it('keeps a sample when counting it elsewhere fails', async () => {
    const sampler = new ViewSemanticsDeltaSampler({ sampleRate: 1, onDelta: () => { throw new Error('no meter'); } });
    sampler.offer(sample({ perAsset: rows('1'), merged: rows('1') }).offered);
    await sampler.idle();
    expect(sampler.report()[0]).toMatchObject({ samples: 1, skipped: 0, kinds: { none: 1 } });
  });

  it('orders shapes by changed answers and context graphs by samples, and keeps both bounded', async () => {
    let minute = 0;
    const sampler = new ViewSemanticsDeltaSampler({ sampleRate: 1, maxShapes: 2, maxContextGraphs: 2,
      now: () => new Date(Date.UTC(2026, 10, 11, 2, minute++)) });
    const run = async (contextGraphId: string, sparql: string, answers: { perAsset: QueryResult; merged: QueryResult }) => {
      sampler.offer(sample(answers, { contextGraphId, sparql }).offered);
      await sampler.idle();
    };
    const same = { perAsset: rows('1'), merged: rows('1') };
    const lost = { perAsset: rows('1', '2'), merged: rows('1') };
    await run('cg-a', 'SELECT ?a WHERE { ?a ?p ?o }', same);
    await run('cg-a', 'SELECT ?a WHERE { ?a ?p ?o }', same);
    await run('cg-a', 'SELECT ?b WHERE { ?b ?p ?o }', lost);
    // A third shape evicts the least recently sampled one.
    await run('cg-a', 'SELECT ?c WHERE { ?c ?p ?o }', same);
    await run('cg-b', 'SELECT ?a WHERE { ?a ?p ?o }', same);
    expect(sampler.report().map(summary => [summary.contextGraphId, summary.samples])).toEqual([['cg-a', 4], ['cg-b', 1]]);
    expect(sampler.report(['cg-a'])[0]!.shapes.map(shape => shape.shape)).toEqual(['SELECT ?b WHERE { ?b ?p ?o }', 'SELECT ?c WHERE { ?c ?p ?o }']);
    // A third context graph evicts the least recently sampled one.
    await run('cg-c', 'SELECT ?a WHERE { ?a ?p ?o }', same);
    expect(sampler.report().map(summary => summary.contextGraphId).sort()).toEqual(['cg-b', 'cg-c']);
  });

  it('stops when closed', async () => {
    const sampler = new ViewSemanticsDeltaSampler({ sampleRate: 1 });
    sampler.close();
    const { offered, run } = sample({ perAsset: rows('1'), merged: rows('1') });
    sampler.offer(offered);
    await sampler.idle();
    expect(run).not.toHaveBeenCalled();
    expect(sampler.report()).toEqual([]);
  });
});
