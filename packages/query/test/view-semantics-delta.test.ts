import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it, vi } from 'vitest';
import type { ViewQuerySemantics } from '@origintrail-official/dkg-core';
import { activeDefaultStoreWorkPriority, withDefaultStoreWorkPriority } from '@origintrail-official/dkg-storage';
import type { QueryResult } from '../src/query-engine.js';
import {
  ViewSemanticsDeltaSampler, classifyViewSemanticsDelta, generatesValuesInEvaluation, viewQueryShape, type ViewSemanticsDeltaSample,
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

  it('compares answers whose blank nodes keep their rows, and does not compare those where nodes gain, lose or swap rows', () => {
    const construct = 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }';
    const graph = (...items: Array<[string, string, string]>): QueryResult => ({ bindings: [],
      quads: items.map(([subject, predicate, object]) => ({ subject, predicate, object, graph: '' })) });
    // Two nodes become one.
    expect(classifyViewSemanticsDelta(construct, graph(['_:a', 'urn:p', 'urn:x'], ['_:b', 'urn:q', 'urn:y']),
      graph(['_:z', 'urn:p', 'urn:x'], ['_:z', 'urn:q', 'urn:y']))).toBeUndefined();
    // One node becomes two.
    expect(classifyViewSemanticsDelta(construct, graph(['_:a', 'urn:p', 'urn:x'], ['_:a', 'urn:p', 'urn:y']),
      graph(['_:b', 'urn:p', 'urn:x'], ['_:c', 'urn:p', 'urn:y']))).toBeUndefined();
    // A node gains a row; its first row is still there under the node's new name.
    expect(classifyViewSemanticsDelta(construct, graph(['_:a', 'urn:p', 'urn:x']),
      graph(['_:b', 'urn:p', 'urn:x'], ['_:b', 'urn:q', 'urn:y']))).toBeUndefined();
    // The same structure under other labels, with nodes linked to each other.
    expect(classifyViewSemanticsDelta(construct,
      graph(['_:a', 'urn:next', '_:b'], ['_:b', 'urn:next', '_:c'], ['_:c', 'urn:value', '"1"']),
      graph(['_:z', 'urn:value', '"1"'], ['_:x', 'urn:next', '_:y'], ['_:y', 'urn:next', '_:z']))).toBe('none');
    // A link reversed is another structure.
    expect(classifyViewSemanticsDelta(construct, graph(['_:a', 'urn:next', '_:b'], ['_:b', 'urn:value', '"1"']),
      graph(['_:a', 'urn:next', '_:b'], ['_:a', 'urn:value', '"1"']))).toBeUndefined();
    // A row without blank nodes that is gone is a removal, beside blank-node rows that kept theirs.
    expect(classifyViewSemanticsDelta(construct, graph(['urn:s', 'urn:p', 'urn:x'], ['_:a', 'urn:q', '"_:not-a-node"']),
      graph(['_:b', 'urn:q', '"_:not-a-node"']))).toBe('rows-removed-or-changed');
  });

  it('counts copies of rows with blank nodes as copies', () => {
    const select = 'SELECT ?s ?o WHERE { ?s ?p ?o }';
    expect(classifyViewSemanticsDelta(select, { bindings: [{ s: '_:a', o: 'urn:x' }, { s: '_:a', o: 'urn:x' }] },
      { bindings: [{ s: '_:b', o: 'urn:x' }] })).toBe('copies-removed');
    const construct = 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }';
    const graph = (...items: Array<[string, string, string]>): QueryResult => ({ bindings: [],
      quads: items.map(([subject, predicate, object]) => ({ subject, predicate, object, graph: '' })) });
    expect(classifyViewSemanticsDelta(construct, graph(['_:a', 'urn:p', 'urn:x'], ['_:a', 'urn:p', 'urn:x'], ['_:b', 'urn:q', 'urn:y']),
      graph(['_:c', 'urn:p', 'urn:x'], ['_:d', 'urn:q', 'urn:y']))).toBe('copies-removed');
    expect(classifyViewSemanticsDelta(construct, graph(['_:c', 'urn:p', 'urn:x'], ['_:d', 'urn:q', 'urn:y']),
      graph(['_:a', 'urn:p', 'urn:x'], ['_:a', 'urn:p', 'urn:x'], ['_:b', 'urn:q', 'urn:y']))).toBe('rows-added');
  });

  it('does not compare answers whose blank nodes their structure cannot tell apart', () => {
    const construct = 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }';
    const cycle = (...nodes: string[]): Array<[string, string, string]> =>
      nodes.map((node, index) => [node, 'urn:next', nodes[(index + 1) % nodes.length]!]);
    const graph = (...items: Array<[string, string, string]>): QueryResult => ({ bindings: [],
      quads: items.map(([subject, predicate, object]) => ({ subject, predicate, object, graph: '' })) });
    // One six-node cycle against two three-node cycles: every node looks the same.
    expect(classifyViewSemanticsDelta(construct, graph(...cycle('_:a', '_:b', '_:c', '_:d', '_:e', '_:f')),
      graph(...cycle('_:u', '_:v', '_:w'), ...cycle('_:x', '_:y', '_:z')))).toBeUndefined();
    // Two nodes with the same rows, in one answer only.
    expect(classifyViewSemanticsDelta(construct, graph(['_:a', 'urn:p', 'urn:x'], ['_:b', 'urn:p', 'urn:x']),
      graph(['_:c', 'urn:p', 'urn:x']))).toBeUndefined();
  });

  it('keeps which bindings share a blank node across variables and rows', () => {
    const select = 'SELECT ?a ?b WHERE { ?a ?p ?b }';
    const shared: QueryResult = { bindings: [{ a: '_:n', b: '_:n' }, { a: '_:m', b: 'urn:x' }] };
    expect(classifyViewSemanticsDelta(select, shared, { bindings: [{ a: '_:k', b: 'urn:x' }, { a: '_:j', b: '_:j' }] })).toBe('none');
    expect(classifyViewSemanticsDelta(select, shared, { bindings: [{ a: '_:k', b: '_:j' }, { a: '_:m', b: 'urn:x' }] }))
      .toBeUndefined();
    // A row added beside unchanged blank-node rows.
    expect(classifyViewSemanticsDelta(select, shared, { bindings: [...shared.bindings, { a: 'urn:y', b: 'urn:z' }] }))
      .toBe('rows-added');
  });
});

describe('queries that generate values during evaluation', () => {
  it('are found by the functions they call, in any case and spacing', () => {
    for (const sparql of [
      'SELECT ?s (NOW() AS ?t) WHERE { ?s ?p ?o }',
      'SELECT ?s WHERE { ?s ?p ?o FILTER(rand () < 0.5) }',
      'SELECT (UUID() AS ?id) WHERE { ?s ?p ?o }',
      'SELECT (STRUUID() AS ?id) WHERE { ?s ?p ?o }',
      'PREFIX ex: <urn:ex:> CONSTRUCT { ?s ex:at ?t } WHERE { ?s ?p ?o BIND(NOW() AS ?t) }',
    ]) expect(generatesValuesInEvaluation(sparql), sparql).toBe(true);
  });

  it('are not found in names, strings, IRIs or language tags', () => {
    for (const sparql of [
      'SELECT ?now ?rand WHERE { ?now <urn:uuid> ?rand }',
      'SELECT ?s WHERE { ?s <urn:p> "NOW()" }',
      'SELECT ?s WHERE { ?s <urn:NOW> ?o }',
      'PREFIX ex: <urn:ex:> SELECT ?s WHERE { ?s ex:now ?o }',
      'SELECT ?s WHERE { ?s ?p "x"@now }',
    ]) expect(generatesValuesInEvaluation(sparql), sparql).toBe(false);
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
  const run = vi.fn(async (semantics: ViewQuerySemantics, _signal: AbortSignal) => (semantics === 'merged' ? answers.merged : answers.perAsset));
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
    let locked = false;
    const lock = vi.fn(async <T>(work: () => Promise<T>) => {
      locked = true;
      try {
        return await work();
      } finally {
        locked = false;
      }
    });
    // Whether each read, and the check after them, ran while the lock was held.
    const inside: string[] = [];
    const { offered, run } = sample({ perAsset: rows('1'), merged: rows('1', '2') }, {
      withWriteLock: lock,
      isCurrent: () => { inside.push(`check ${locked}`); return true; },
    });
    sampler.offer({ ...offered, run: (semantics, signal) => { inside.push(`${semantics} ${locked}`); return run(semantics, signal); } });
    // The caller's answer does not wait: the sample runs after the current turn.
    expect(run).not.toHaveBeenCalled();
    await sampler.idle();
    expect(lock).toHaveBeenCalledTimes(1);
    expect(inside).toEqual(['per-asset true', 'merged true', 'check true']);
    expect(run.mock.calls.map(([semantics]) => semantics)).toEqual(['per-asset', 'merged']);
    // Both reads share the sample's deadline, which they finished before.
    const [[, first], [, second]] = run.mock.calls;
    expect(second).toBe(first);
    expect(first!.aborted).toBe(false);
    expect(onDelta).toHaveBeenCalledWith('rows-added');
    expect(sampler.report()).toEqual([{
      contextGraphId: 'cg-a', since: '2026-11-11T02:05:00.000Z', samples: 1, skipped: 0, uncomparable: 0,
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

  it('counts a sampled query that generates values during evaluation as not compared, and never runs it', async () => {
    const sampler = new ViewSemanticsDeltaSampler({ sampleRate: 1, maxQueued: 1 });
    const { offered, run } = sample({ perAsset: rows('1'), merged: rows('1') }, { sparql: 'SELECT ?s (NOW() AS ?t) WHERE { ?s ?p ?o }' });
    sampler.offer(offered);
    sampler.offer(offered);
    // A text that cannot be read is not compared either.
    sampler.offer({ ...offered, sparql: undefined as unknown as string });
    await sampler.idle();
    expect(run).not.toHaveBeenCalled();
    expect(sampler.report()).toMatchObject([{ contextGraphId: 'cg-a', samples: 0, skipped: 0, uncomparable: 3 }]);
  });

  it('counts a sample whose answers cannot be compared as not compared', async () => {
    const sampler = new ViewSemanticsDeltaSampler({ sampleRate: 1 });
    const symmetric: QueryResult = { bindings: [{ s: '_:a', o: 'urn:x' }, { s: '_:b', o: 'urn:x' }] };
    sampler.offer(sample({ perAsset: symmetric, merged: { bindings: [{ s: '_:c', o: 'urn:x' }] } }).offered);
    await sampler.idle();
    expect(sampler.report()).toMatchObject([{ samples: 0, skipped: 0, uncomparable: 1, shapes: [] }]);
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

  it('aborts and skips a sample that runs past its deadline, waiting for the lock included', async () => {
    const sampler = new ViewSemanticsDeltaSampler({ sampleRate: 1, maxSampleMs: 5 });
    const late = <T>(value: T) => new Promise<T>(resolve => setTimeout(() => resolve(value), 20));
    // A read that stops when its signal aborts.
    const aborting = vi.fn((_semantics: ViewQuerySemantics, signal: AbortSignal) => new Promise<QueryResult>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    sampler.offer({ ...sample({ perAsset: rows('1'), merged: rows('1') }).offered, run: aborting });
    // Reads that answer after the deadline anyway.
    const slow = vi.fn(() => late(rows('1')));
    sampler.offer({ ...sample({ perAsset: rows('1'), merged: rows('1') }).offered, run: slow });
    // A write lock granted after the deadline.
    const locked = sample({ perAsset: rows('1'), merged: rows('1') }, {
      withWriteLock: async <T>(work: () => Promise<T>): Promise<T> => {
        await late(undefined);
        return work();
      },
    });
    sampler.offer(locked.offered);
    await sampler.idle();
    expect(aborting).toHaveBeenCalledTimes(1);
    expect(aborting.mock.calls[0]![1].reason).toEqual(new Error('The sample ran past its deadline'));
    expect(slow).toHaveBeenCalledTimes(2);
    expect(locked.run).not.toHaveBeenCalled();
    expect(sampler.report()[0]).toMatchObject({ samples: 0, skipped: 3 });
  });

  it('runs samples outside the async context of the query that offered them, at background priority', async () => {
    const request = new AsyncLocalStorage<string>();
    const seen: unknown[] = [];
    const { offered } = sample({ perAsset: rows('1'), merged: rows('1') });
    const run = vi.fn(async (semantics: ViewQuerySemantics) => {
      seen.push([semantics, request.getStore(), activeDefaultStoreWorkPriority()]);
      return rows('1');
    });
    const sampler = new ViewSemanticsDeltaSampler({ sampleRate: 1 });
    request.run('request-1', () => withDefaultStoreWorkPriority('normal', () => sampler.offer({ ...offered, run })));
    await sampler.idle();
    expect(seen).toEqual([['per-asset', undefined, 'background'], ['merged', undefined, 'background']]);
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
