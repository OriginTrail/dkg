import { describe, expect, it } from 'vitest';
import { ADAPTER_SPARQL_TERM_POLICY } from '../src/adapters/sparql-term-policy.js';
import type { GraphNameTest } from '../src/read-graph/membership.js';
import {
  ReadGraphDeltaFormError,
  readGraphCopy,
  readGraphDeltaDelete,
  readGraphDeltaDeleteMatching,
  readGraphReferenceProcedure,
  readGraphRetraction,
  readGraphUnheldSubjectAsk,
  renderGraphNameTest,
  type ReadGraphTarget,
} from '../src/read-graph/statements.js';
import { readGraphStatementsConformance } from './helpers/read-graph-statements-conformance.js';

const R = 'did:dkg:context-graph:x/_read/cg/_verifiable_memory';
const G = 'did:dkg:context-graph:x/_verifiable_memory/0xaa/1';
const target: ReadGraphTarget = { readGraph: R, membership: { kind: 'prefix', prefix: 'did:dkg:context-graph:x/_verifiable_memory/' } };
const render = ADAPTER_SPARQL_TERM_POLICY.renderer({ adapter: 'oxigraph', operation: 'delete' }, () => {});

readGraphStatementsConformance('oxigraph');

describe('read-graph statements, rendering', () => {
  it('renders each kind of name test, and the empty ones as constants', () => {
    const tests: Array<[GraphNameTest, string]> = [
      [{ kind: 'equals', iri: 'urn:"a"' }, '(STR(?g) = "urn:\\"a\\"")'],
      [{ kind: 'segment', segment: '_meta' }, 'CONTAINS(CONCAT(STR(?g), "/"), "/_meta/")'],
      [{ kind: 'all', tests: [] }, 'true'],
      [{ kind: 'any', tests: [] }, 'false'],
      [{ kind: 'address-after', prefix: 'urn:a/', addresses: [] }, '(STRSTARTS(STR(?g), "urn:a/") && STRLEN(STRBEFORE(STRAFTER(STR(?g), "urn:a/"), "/")) > 0 && false)'],
    ];
    for (const [test, expected] of tests) expect(renderGraphNameTest(test, '?g')).toBe(expected);
    expect(() => renderGraphNameTest({ kind: 'all', tests: [] }, 'g')).toThrow(/Unsafe SPARQL variable/);
  });

  it('excludes every touched graph from the existence check and reads each touched graph alone', () => {
    const other = 'did:dkg:context-graph:x/_verifiable_memory/0xaa/2';
    const procedure = readGraphReferenceProcedure(target, [G, other, G], [other]);
    expect(procedure.before).toHaveLength(2);
    for (const statement of procedure.before) expect(statement).toContain(`?readGraphHolder NOT IN (<${G}>, <${other}>)`);
    expect(procedure.after).toEqual([readGraphCopy(R, other)]);
    expect(() => readGraphReferenceProcedure(target, [G], [other])).toThrow(/one of the touched graphs/);
    expect(() => readGraphRetraction(target, other, [G])).toThrow(/one of the touched graphs/);
  });

  it('refuses what a restated form cannot carry, and names that are not read graphs', () => {
    expect(() => readGraphDeltaDelete(target, [{ subject: '_:b0', predicate: 'urn:p', object: '"x"', graph: G }], render))
      .toThrow(ReadGraphDeltaFormError);
    expect(() => readGraphDeltaDelete(target, [{ subject: 'urn:s', predicate: 'urn:p', object: '_:b1', graph: G }], render))
      .toThrow(ReadGraphDeltaFormError);
    expect(readGraphDeltaDelete(target, [], render)).toBeUndefined();
    expect(() => readGraphDeltaDeleteMatching(target, G, { object: '_:b2' }, render)).toThrow(ReadGraphDeltaFormError);
    expect(() => readGraphCopy(R, G, { subject: '_:b3' })).toThrow(ReadGraphDeltaFormError);
    expect(() => readGraphCopy(G, G)).toThrow(/Not a read graph/);
    expect(() => readGraphCopy(R, 'urn:a b')).toThrow(/Unsafe or empty IRI/);
    expect(readGraphUnheldSubjectAsk(target, 'urn:s')).toContain('GRAPH <did:dkg:context-graph:x/_read/cg/_verifiable_memory> { <urn:s> ?p ?o }');
  });
});
