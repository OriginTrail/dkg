import { describe, expect, it } from 'vitest';

import { SYSTEM_RECORD_MAX_SHALLOW_JSON_DEPTH } from '@origintrail-official/dkg-core/system-record-v1';

import {
  SYSTEM_RECORD_MAX_PROJECTION_INSPECTION_ROWS_V1,
  SYSTEM_RECORD_MAX_RESERVED_INSPECTION_ROWS_V1,
  buildSystemRecordProjectionInspectionQueryV1,
  buildSystemRecordReservedInspectionQueryV1,
  estimateSystemRecordInspectionParseBytesV1,
  parseSystemRecordInspectionResponseV1,
  retainedSystemRecordInspectionQuadsBytesV1,
} from '../src/system-record-inspection-v1-internal.js';
import {
  SYSTEM_RECORD_V1_STATE_GRAPH,
  SYSTEM_RECORD_V1_SHADOW_AGENTS_GRAPH,
} from '../src/internal-graph-policy.js';

const S1 = 'urn:test:subject:1';
const S2 = 'urn:test:subject:2';
const P = 'urn:test:predicate';
const G = SYSTEM_RECORD_V1_SHADOW_AGENTS_GRAPH;

describe('system-record bounded inspection', () => {
  it('builds indexed exact-subject queries with cap+1 and no scan/sort constructs', () => {
    const reserved = buildSystemRecordReservedInspectionQueryV1([S2, S1]);
    expect(reserved).toContain(`GRAPH <${SYSTEM_RECORD_V1_STATE_GRAPH}>`);
    expect(reserved).toContain(`VALUES ?s { <${S1}> <${S2}> }`);
    expect(reserved).toContain(`LIMIT ${SYSTEM_RECORD_MAX_RESERVED_INSPECTION_ROWS_V1 + 1}`);

    const projection = buildSystemRecordProjectionInspectionQueryV1('shadow', [S1]);
    expect(projection).toContain(`LIMIT ${SYSTEM_RECORD_MAX_PROJECTION_INSPECTION_ROWS_V1}`);
    for (const banned of ['ORDER BY', 'COUNT(', 'STRSTARTS', 'GRAPH ?g', 'CLEAR ', 'DROP ']) {
      expect(`${reserved}\n${projection}`).not.toContain(banned);
    }
    expect(() => buildSystemRecordProjectionInspectionQueryV1('shadow', [])).toThrow(/subject count/);
    expect(() => buildSystemRecordProjectionInspectionQueryV1('shadow', [S1, S1])).toThrow(/unique/);
    expect(() => buildSystemRecordProjectionInspectionQueryV1(
      'caller-authored' as 'shadow', [S1],
    )).toThrow(/mode/);
  });

  it('charges one exact inspection-query buffer and its retained string without map/join copies', () => {
    const charges: number[] = [];
    const query = buildSystemRecordProjectionInspectionQueryV1(
      'shadow',
      [S2, S1],
      (bytes) => charges.push(bytes),
    );
    const encodedBytes = Buffer.byteLength(query, 'utf8');
    expect(charges).toEqual([encodedBytes * 3, encodedBytes * 2]);
    expect(query).toContain(`VALUES ?s { <${S1}> <${S2}> }`);
  });

  it('strictly decodes, canonicalizes, sorts and freezes URI/literal rows', () => {
    const body = response([
      row(S2, P, { type: 'literal', value: 'line\n"quoted"', datatype: 'urn:test:type' }),
      row(S1, P, { type: 'uri', value: 'urn:test:object' }),
    ]);
    const parsed = parseSystemRecordInspectionResponseV1({
      body, scope: 'shadow', allowedSubjects: [S1, S2], maxRows: 2,
    });
    expect(parsed).toEqual([
      { subject: S1, predicate: P, object: 'urn:test:object', graph: G },
      {
        subject: S2,
        predicate: P,
        object: '"line\\n\\"quoted\\""^^<urn:test:type>',
        graph: G,
      },
    ]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(parsed.every(Object.isFrozen)).toBe(true);
    expect(estimateSystemRecordInspectionParseBytesV1(body, 2))
      .toBeGreaterThan(retainedSystemRecordInspectionQuadsBytesV1(parsed));
  });

  it('preflights adversarial JSON structure before allocating its parsed graph', () => {
    const body = JSON.stringify(Array.from({ length: 100_000 }, () => 0));
    expect(estimateSystemRecordInspectionParseBytesV1(body, 10_000))
      .toBeGreaterThan(12 * 1024 * 1024);
  });

  it('rejects attacker-controlled nesting with fixed preflight workspace', () => {
    const depth = SYSTEM_RECORD_MAX_SHALLOW_JSON_DEPTH + 1;
    const body = `${'['.repeat(depth)}0${']'.repeat(depth)}`;
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThan(4 * 1024 * 1024);
    expect(() => estimateSystemRecordInspectionParseBytesV1(body, 10_000))
      .toThrow(/depth bound/);
  });

  it('orders projection rows by canonical N-Triples bytes while reserved rows retain tuple order', () => {
    const root = 'urn:test:root';
    const child = 'urn:test:root/.well-known/genid/cap1';
    const rows = [
      row(root, P, { type: 'uri', value: 'urn:test:object:root' }),
      row(child, P, { type: 'uri', value: 'urn:test:object:child' }),
    ];
    const projection = parseSystemRecordInspectionResponseV1({
      body: response(rows), scope: 'shadow', allowedSubjects: [root, child], maxRows: 2,
    });
    expect(projection.map((quad) => quad.subject)).toEqual([child, root]);

    const reserved = parseSystemRecordInspectionResponseV1({
      body: response(rows), scope: 'reserved', allowedSubjects: [root, child], maxRows: 2,
    });
    expect(reserved.map((quad) => quad.subject)).toEqual([root, child]);
  });

  it('rejects cap+1, duplicates, blank nodes, unknown fields and unrequested subjects', () => {
    expect(() => parse(response([
      row(S1, P, { type: 'uri', value: 'urn:o:1' }),
      row(S2, P, { type: 'uri', value: 'urn:o:2' }),
    ]), { maxRows: 1 })).toThrow(/row bound/);
    const duplicate = row(S1, P, { type: 'uri', value: 'urn:o:1' });
    expect(() => parse(response([duplicate, duplicate]), { maxRows: 2 })).toThrow(/duplicate/);
    expect(() => parse(response([
      row(S1, P, { type: 'bnode', value: 'x' }),
    ]))).toThrow(/blank nodes/);
    expect(() => parse(JSON.stringify({
      head: { vars: ['s', 'p', 'o'] },
      results: { bindings: [{ ...row(S1, P, { type: 'uri', value: 'urn:o' }), extra: {} }] },
    }))).toThrow(/unknown/);
    expect(() => parse(response([
      row('urn:not:requested', P, { type: 'uri', value: 'urn:o' }),
    ]))).toThrow(/unrequested/);
  });

  it('rejects malformed/truncated JSON and decoded-term byte overflow', () => {
    expect(() => parse('{')).toThrow(/not JSON/);
    expect(() => parse(response([
      row(S1, P, { type: 'literal', value: 'abcd' }),
    ]), { maxDecodedTermBytes: 3 })).toThrow(/decoded-term/);
    expect(() => parse(JSON.stringify({
      head: { vars: ['s', 'p'] }, results: { bindings: [] },
    }))).toThrow(/variables/);
    expect(() => parse(response([
      row(S1, P, { type: 'literal', value: 'x', datatype: 'urn:type', 'xml:lang': 'en' }),
    ]))).toThrow(/datatype and language/);
    expect(() => parse(response([
      row(S1, P, { type: 'literal', value: '\ud800' }),
    ]))).toThrow(/non-scalar/);
    expect(() => parse(' '.repeat(4 * 1024 * 1024 + 1))).toThrow(/encoded byte/);
    expect(() => parse(response([]), { maxRows: 10_001 })).toThrow(/row bound/);
    expect(() => parseSystemRecordInspectionResponseV1(new Proxy({
      body: response([]), scope: 'shadow', allowedSubjects: [S1], maxRows: 1,
    }, {}))).toThrow(/plain data/);
  });
});

function parse(
  body: string,
  overrides: Partial<Parameters<typeof parseSystemRecordInspectionResponseV1>[0]> = {},
) {
  return parseSystemRecordInspectionResponseV1({
    body,
    scope: 'shadow',
    allowedSubjects: [S1, S2],
    maxRows: 10,
    ...overrides,
  });
}

function response(bindings: unknown[]): string {
  return JSON.stringify({ head: { vars: ['s', 'p', 'o'] }, results: { bindings } });
}

function row(subject: string, predicate: string, object: Record<string, unknown>) {
  return {
    s: { type: 'uri', value: subject },
    p: { type: 'uri', value: predicate },
    o: object,
  };
}
