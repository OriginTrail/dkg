import { describe, expect, it } from 'vitest';
import {
  analyzeQuery,
  assertQueryWithinLimit,
  countResultRows,
  DEFAULT_QUERY_GUARDS,
  QUERY_COST_SCHEDULE_V1,
  QUERY_COST_SCHEDULE_V1_DIGEST,
  QUERY_MAX_SPARQL_BYTES,
  queryAdmissionUnits,
  queryCostScheduleDigest,
  queryDeliveryUnits,
  queryRowCap,
  QueryTooLargeError,
  queryWorstCaseUnits,
  type QueryCostSchedule,
} from '../src/index.js';

const PROBE = 'SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 5';

describe('schedule v1', () => {
  it('pins the integer schedule, its canonical JSON and digest', () => {
    expect(QUERY_COST_SCHEDULE_V1).toEqual({
      version: 'dkg-mkt-query-cost/1',
      base: 2,
      perTriplePattern: 1,
      perJoinVar: 2,
      perPropertyPath: 3,
      perOptionalOrUnion: 3,
      perFilter: 1,
      perAggregation: 5,
      missingLimitSurcharge: 10,
      rowsPerDeliveryUnit: 100,
    });
    const record = QUERY_COST_SCHEDULE_V1 as unknown as Record<string, unknown>;
    const canonical = JSON.stringify(Object.fromEntries(Object.keys(record).sort().map((k) => [k, record[k]])));
    expect(canonical).toBe(
      '{"base":2,"missingLimitSurcharge":10,"perAggregation":5,"perFilter":1,"perJoinVar":2,"perOptionalOrUnion":3,' +
        '"perPropertyPath":3,"perTriplePattern":1,"rowsPerDeliveryUnit":100,"version":"dkg-mkt-query-cost/1"}',
    );
    expect(QUERY_COST_SCHEDULE_V1_DIGEST).toBe('sha256:70beea38241810353b4934b29627f4ef0699d6b0159d33ccf0357b070f7b0642');
    // Key order of the input object does not change the content address.
    const reordered = { rowsPerDeliveryUnit: 100, ...QUERY_COST_SCHEDULE_V1 } as QueryCostSchedule;
    expect(queryCostScheduleDigest(reordered)).toBe(QUERY_COST_SCHEDULE_V1_DIGEST);
    expect(queryCostScheduleDigest({ ...QUERY_COST_SCHEDULE_V1, base: 3 })).not.toBe(QUERY_COST_SCHEDULE_V1_DIGEST);
    expect(DEFAULT_QUERY_GUARDS).toEqual({ timeoutMs: 10_000, maxRows: 10_000 });
  });
});

describe('golden vectors', () => {
  it('GV-8 admission units', () => {
    expect(queryAdmissionUnits(PROBE)).toBe(3n);
    expect(queryAdmissionUnits('SELECT ?s ?p ?o WHERE { ?s ?p ?o }')).toBe(13n);
    expect(
      queryAdmissionUnits(
        'PREFIX mkt: <https://w3id.org/dkg/marketplace#> SELECT ?o ?a WHERE { ?o a mkt:Offer . ?o mkt:askPerUnitWei ?a . } LIMIT 10',
      ),
    ).toBe(6n);
    expect(queryAdmissionUnits('SELECT ?s WHERE { ?s <http://x/p>/<http://x/q>* ?o . OPTIONAL { ?s ?p2 ?o2 } FILTER(?o > 3) } LIMIT 3')).toBe(
      17n,
    );
  });

  it('GV-8 complexity breakdown (verbatim analyzer)', () => {
    expect(analyzeQuery(PROBE)).toEqual({
      triplePatterns: 1,
      joinVars: 0,
      propertyPaths: 0,
      optionalsAndUnions: 0,
      filters: 0,
      aggregations: 0,
      hasLimit: true,
    });
    expect(analyzeQuery('SELECT ?s WHERE { ?s <http://x/p>/<http://x/q>* ?o . OPTIONAL { ?s ?p2 ?o2 } FILTER(?o > 3) } LIMIT 3')).toEqual({
      triplePatterns: 1,
      joinVars: 2,
      propertyPaths: 2,
      optionalsAndUnions: 1,
      filters: 1,
      aggregations: 0,
      hasLimit: true,
    });
    expect(analyzeQuery('SELECT (COUNT(?s) AS ?n) WHERE { ?s ?p "LIMIT 5 # OPTIONAL" } GROUP BY ?p').aggregations).toBe(2);
    expect(analyzeQuery('SELECT ?s WHERE { ?s ?p "LIMIT 5" }').hasLimit).toBe(false);
  });

  it('GV-9 delivery units: ceil(rows / 100)', () => {
    const cases: Array<[number | bigint, bigint]> = [
      [0, 0n],
      [1, 1n],
      [100, 1n],
      [101, 2n],
      [10_000, 100n],
      [250n, 3n],
    ];
    for (const [rows, units] of cases) expect(queryDeliveryUnits(rows)).toBe(units);
    expect(() => queryDeliveryUnits(-1)).toThrow('non-negative');
    expect(() => queryDeliveryUnits(1.5)).toThrow('integer');
  });

  it('GV-10 worst case: admission + delivery(maxRows)', () => {
    expect(queryWorstCaseUnits(PROBE, 100)).toBe(4n);
    expect(queryWorstCaseUnits(PROBE, 10_000)).toBe(103n);
  });
});

describe('queryRowCap', () => {
  it('refuses when maxUnits cannot cover admission', () => {
    expect(queryRowCap(PROBE, 2n, 10_000)).toEqual({ admit: false });
    expect(queryRowCap(PROBE, 0n, 10_000)).toEqual({ admit: false });
  });

  it('admits at exactly admission with a zero row cap, then caps by units and by the guard', () => {
    expect(queryRowCap(PROBE, 3n, 10_000)).toEqual({ admit: true, admissionUnits: 3n, rowCap: 0n });
    expect(queryRowCap(PROBE, 4n, 10_000)).toEqual({ admit: true, admissionUnits: 3n, rowCap: 100n });
    expect(queryRowCap(PROBE, 103n, 10_000)).toEqual({ admit: true, admissionUnits: 3n, rowCap: 10_000n });
    expect(queryRowCap(PROBE, 1_000_000n, 250n)).toEqual({ admit: true, admissionUnits: 3n, rowCap: 250n });
  });

  it('a delivery within the row cap never exceeds the authorization', () => {
    for (const maxUnits of [3n, 4n, 5n, 50n, 103n]) {
      const cap = queryRowCap(PROBE, maxUnits, 10_000);
      if (!cap.admit) throw new Error('unreachable');
      expect(cap.admissionUnits + queryDeliveryUnits(cap.rowCap)).toBeLessThanOrEqual(maxUnits);
    }
  });
});

describe('countResultRows', () => {
  it('counts bindings plus quads arrays only', () => {
    expect(countResultRows({ bindings: [{}, {}], quads: [{}] })).toBe(3);
    expect(countResultRows({ bindings: [] })).toBe(0);
    expect(countResultRows({ quads: [{}, {}] })).toBe(2);
    expect(countResultRows({ bindings: 'nope', quads: { length: 4 } })).toBe(0);
    for (const value of [null, undefined, 7, 'rows', [1, 2]]) expect(countResultRows(value)).toBe(0);
  });
});

describe('size gate', () => {
  it(`accepts ${QUERY_MAX_SPARQL_BYTES} bytes and refuses ${QUERY_MAX_SPARQL_BYTES + 1}`, () => {
    const head = 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 1 #';
    const atLimit = head + 'x'.repeat(QUERY_MAX_SPARQL_BYTES - head.length);
    expect(Buffer.byteLength(atLimit)).toBe(8192);
    expect(() => assertQueryWithinLimit(atLimit)).not.toThrow();
    expect(queryAdmissionUnits(atLimit)).toBe(3n);
    const over = `${atLimit}x`;
    expect(() => queryAdmissionUnits(over)).toThrow(QueryTooLargeError);
    // Multi-byte: 4096 two-byte characters fit, one more byte does not.
    expect(() => assertQueryWithinLimit('é'.repeat(4096))).not.toThrow();
    let caught: unknown;
    try {
      assertQueryWithinLimit(`${'é'.repeat(4096)}x`);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(QueryTooLargeError);
    expect((caught as QueryTooLargeError).name).toBe('QueryTooLargeError');
    expect((caught as QueryTooLargeError).bytes).toBe(8193);
  });

  it('every analysing function refuses before any regex runs (1 MiB whitespace run < 50 ms)', () => {
    const hostile = `SELECT ?s WHERE {${' '.repeat(1024 * 1024)}?s ?p ?o }`;
    for (const analyse of [
      () => analyzeQuery(hostile),
      () => queryAdmissionUnits(hostile),
      () => queryWorstCaseUnits(hostile, 10),
      () => queryRowCap(hostile, 100n, 10),
    ]) {
      const started = performance.now();
      expect(analyse).toThrow(QueryTooLargeError);
      expect(performance.now() - started).toBeLessThan(50);
    }
    expect(() => assertQueryWithinLimit(42 as unknown as string)).toThrow(TypeError);
  });

  it('rejects a schedule with non-integer terms', () => {
    expect(() => queryAdmissionUnits(PROBE, { ...QUERY_COST_SCHEDULE_V1, perFilter: 0.5 })).toThrow('perFilter');
    expect(() => queryDeliveryUnits(5, { ...QUERY_COST_SCHEDULE_V1, rowsPerDeliveryUnit: 0 })).toThrow('rowsPerDeliveryUnit');
  });
});
