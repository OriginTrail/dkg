import { afterEach, expect, it, vi } from 'vitest';
import * as core from '@origintrail-official/dkg-core';
import { prepareAtomicGraphAndSubjectReplace } from '../src/adapters/atomic-write-plans.js';
import { observeInvalidSparqlTerms } from './helpers/invalid-sparql-term-observer.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it.each(['direct', 'overlapping', 'oversized'] as const)('preflights and reports each term once for the %s strategy', strategy => {
  // Each case gets a fresh warning window; counters are deliberately unthrottled.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + ['direct', 'overlapping', 'oversized'].indexOf(strategy) * 60_001);
  const graph = 'urn:data', meta = strategy === 'overlapping' ? graph : 'urn:meta';
  const object = JSON.stringify('x'.repeat(strategy === 'oversized' ? 60_000 : 1));
  const quads = Array.from({ length: strategy === 'oversized' ? 560 : 1 }, (_, i) => ({
    graph, subject: `urn:asset:${i}`, predicate: i === 0 ? 'relative-predicate' : 'urn:value', object,
  }));
  const literals = vi.spyOn(core, 'assertQuadLiteralsMutf8Safe');
  const observer = observeInvalidSparqlTerms();
  try {
    const plan = prepareAtomicGraphAndSubjectReplace('blazegraph', graph, quads, meta, 'urn:metadata', []);
    expect(literals).toHaveBeenCalledTimes(1);
    expect(observer.counted).toEqual([{ value: 1, adapter: 'blazegraph', operation: 'replaceGraphAndSubject',
      position: 'predicate', kind: 'relative-iri', enforcement: 'observe' }]);
    expect(observer.warnings).toHaveLength(1);
    expect(plan.cleanup === '').toBe(strategy === 'direct');
  } finally { observer.restore(); }
}, 30_000);

it.each([false, true])('rejects invalid payloads before optional IRI reporting, overlapping=%s', overlapping => {
  const graph = 'urn:data', meta = overlapping ? graph : 'urn:meta';
  const observer = observeInvalidSparqlTerms();
  try {
    expect(() => prepareAtomicGraphAndSubjectReplace('blazegraph', graph, [{ graph: 'urn:wrong',
      subject: 'urn:asset', predicate: 'relative-predicate', object: '"value"' }], meta, 'urn:metadata', [])).toThrow('targets');
    expect(observer.counted).toEqual([]);
    expect(observer.warnings).toEqual([]);
  } finally { observer.restore(); }
});
