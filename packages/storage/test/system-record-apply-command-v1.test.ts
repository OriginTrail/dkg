import { afterEach, describe, expect, it } from 'vitest';

import {
  buildSystemRecordConditionalApplyUpdateV1,
  mergeSystemRecordOwnedSubjectsV1,
} from '../src/system-record-apply-command-v1-internal.js';
import { SYSTEM_RECORD_V1_STATE_GRAPH } from '../src/internal-graph-policy.js';
import {
  makeAuthenticActiveReplacementFixtureV1,
} from './helpers/system-record-active-replacement-fixture.js';
import {
  startOxigraphSparqlEndpoint,
  type OxigraphSparqlEndpoint,
} from './helpers/oxigraph-sparql-endpoint.js';

const subject = (index: number): string => `urn:test:subject:${index.toString().padStart(4, '0')}`;

describe('system-record conditional apply command V1', () => {
  let endpoint: OxigraphSparqlEndpoint | undefined;
  afterEach(async () => {
    await endpoint?.close();
    endpoint = undefined;
  });

  it('merges prior and next UTF-8 tables once, sorted and duplicate-free', () => {
    expect(mergeSystemRecordOwnedSubjectsV1(
      [subject(0), subject(2), subject(4)],
      [subject(1), subject(2), subject(3)],
    )).toEqual([
      subject(0), subject(1), subject(2), subject(3), subject(4),
    ]);
  });

  it('accepts an exact 2,048-subject union and rejects 2,049 predispatch', () => {
    const exact = Array.from({ length: 2_048 }, (_, index) => subject(index));
    expect(mergeSystemRecordOwnedSubjectsV1(exact.slice(0, 1_024), exact.slice(1_024)))
      .toHaveLength(2_048);

    const left = Array.from({ length: 2_048 }, (_, index) => subject(index));
    expect(() => mergeSystemRecordOwnedSubjectsV1(left, [subject(2_048)]))
      .toThrow(/2,048/);
  });

  it('accepts only a factory-authentic complete transition and emits one bounded Modify', () => {
    const { ready } = makeAuthenticActiveReplacementFixtureV1('shadow');
    const result = buildSystemRecordConditionalApplyUpdateV1(ready);

    expect(result.subjectUnion).toEqual(ready.plan.next.ownedSubjectTable);
    expect(result.requestBytes).toBe(Buffer.byteLength(result.sparql, 'utf8'));
    expect(result.sparql.match(/\bDELETE\s*\{/g)).toHaveLength(1);
    expect(result.sparql.match(/\bINSERT\s*\{/g)).toHaveLength(1);
    expect(result.sparql.match(/\bWHERE\s*\{/g)).toHaveLength(1);
    expect(result.sparql).toContain(`GRAPH <${ready.plan.projectionGraph}>`);
    expect(result.sparql).toContain(`GRAPH <${SYSTEM_RECORD_V1_STATE_GRAPH}>`);
    expect(result.sparql).not.toMatch(/;|STRSTARTS|COUNT\s*\(|ORDER\s+BY|GRAPH\s+\?g/i);
    expect(result.sparql).not.toContain('DROP');
    expect(result.sparql).not.toContain('CLEAR');

    expect(() => buildSystemRecordConditionalApplyUpdateV1(
      structuredClone(ready),
    )).toThrow(/not produced by the verified state derivation/);
  });

  it('atomically replaces authoritative legacy rows and a stale CAS becomes a zero-write miss', async () => {
    endpoint = await startOxigraphSparqlEndpoint();
    const { ready } = makeAuthenticActiveReplacementFixtureV1('authoritative');
    const legacySubject = ready.plan.next.ownedSubjectTable[0];
    endpoint.store.update(`INSERT DATA {
      ${ready.plan.prior.reservedQuads.map(renderQuad).join('\n')}
      GRAPH <${ready.plan.projectionGraph}> {
        <${legacySubject}> <urn:test:legacy> "must-be-replaced" .
      }
    }`);
    const update = buildSystemRecordConditionalApplyUpdateV1(ready);
    const dispatch = async () => {
      const response = await fetch(endpoint!.updateEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sparql-update; charset=utf-8' },
        body: update.sparql,
      });
      expect(response.status).toBe(204);
    };
    const ask = (pattern: string): boolean => endpoint!.store.query(`ASK { ${pattern} }`) as boolean;

    await dispatch();
    const projection = ready.plan.next.projectionQuads[0];
    expect(ask(`GRAPH <${ready.plan.projectionGraph}> { <${projection.subject}> ` +
      `<${projection.predicate}> ${renderObject(projection.object)} }`)).toBe(true);
    const reserved = ready.plan.next.reservedQuads[0];
    expect(ask(`GRAPH <${SYSTEM_RECORD_V1_STATE_GRAPH}> { <${reserved.subject}> ` +
      `<${reserved.predicate}> ${renderObject(reserved.object)} }`)).toBe(true);
    expect(ask(`GRAPH <${ready.plan.projectionGraph}> { <${legacySubject}> ` +
      '<urn:test:legacy> "must-be-replaced" }')).toBe(false);

    const guardedSubject = ready.plan.next.ownedSubjectTable[0];
    endpoint.store.update(`INSERT DATA { GRAPH <${ready.plan.projectionGraph}> {
      <${guardedSubject}> <urn:test:late> "must-survive-stale-cas" .
    } }`);
    await dispatch();
    expect(ask(`GRAPH <${ready.plan.projectionGraph}> { <${guardedSubject}> ` +
      '<urn:test:late> "must-survive-stale-cas" }')).toBe(true);
  });
});

function renderQuad(quad: Readonly<{ subject: string; predicate: string; object: string; graph: string }>): string {
  return `GRAPH <${quad.graph}> { <${quad.subject}> <${quad.predicate}> ${renderObject(quad.object)} . }`;
}

function renderObject(value: string): string {
  return value.startsWith('"') ? value : `<${value}>`;
}
