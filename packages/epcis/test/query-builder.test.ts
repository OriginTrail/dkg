import { describe, it, expect } from 'vitest';
import { buildEpcisQuery, escapeSparql, normalizeBizStep, normalizeGs1Vocabulary } from '../src/query-builder.js';

const PARANET_ID = 'test-paranet';
const DATA_GRAPH = `did:dkg:paranet:${PARANET_ID}`;
const META_GRAPH = `${DATA_GRAPH}/_meta`;

describe('buildEpcisQuery', () => {
  it('generates SPARQL with explicit GRAPH for a single EPC filter', () => {
    const sparql = buildEpcisQuery({ epc: 'urn:epc:id:sgtin:4012345.011111.1001' }, PARANET_ID);

    expect(sparql).toContain(`GRAPH <${DATA_GRAPH}>`);
    expect(sparql).not.toContain('GRAPH ?');
    expect(sparql).toContain('urn:epc:id:sgtin:4012345.011111.1001');
    expect(sparql).toContain(`GRAPH <${META_GRAPH}>`);
    expect(sparql).toContain('dkg:rootEntity');
    expect(sparql).toContain('dkg:partOf');
    expect(sparql).toMatch(/GROUP BY.*\?event/);
  });

  it('filters by bizStep with shorthand normalization', () => {
    const sparql = buildEpcisQuery({ bizStep: 'assembling' }, PARANET_ID);

    expect(sparql).toContain('?event epcis:bizStep ?bizStep');
    expect(sparql).toContain('https://ref.gs1.org/cbv/BizStep-assembling');
    // When bizStep is filtered, it should NOT be OPTIONAL
    expect(sparql).not.toMatch(/OPTIONAL.*bizStep/);
  });

  it('filters by bizStep with full URI', () => {
    const sparql = buildEpcisQuery({ bizStep: 'https://ref.gs1.org/cbv/BizStep-receiving' }, PARANET_ID);

    expect(sparql).toContain('https://ref.gs1.org/cbv/BizStep-receiving');
  });

  it('filters by bizLocation', () => {
    const sparql = buildEpcisQuery({ bizLocation: 'urn:epc:id:sgln:4012345.00001.0' }, PARANET_ID);

    expect(sparql).toContain('epcis:bizLocation <urn:epc:id:sgln:4012345.00001.0>');
  });

  it('filters by date range (from and to) with strict < for to', () => {
    const sparql = buildEpcisQuery(
      { from: '2024-01-01T00:00:00Z', to: '2024-12-31T23:59:59Z', epc: 'urn:test' },
      PARANET_ID,
    );

    expect(sparql).toContain('?event epcis:eventTime ?eventTime');
    expect(sparql).toContain('xsd:dateTime("2024-01-01T00:00:00Z")');
    expect(sparql).toContain('xsd:dateTime("2024-12-31T23:59:59Z")');
    expect(sparql).toContain('>=');
    // LT_eventTime per EPCIS 2.0 standard: strict less-than
    expect(sparql).toMatch(/< xsd:dateTime\("2024-12-31/);
    expect(sparql).not.toMatch(/<= xsd:dateTime\("2024-12-31/);
  });

  it('filters by from date only', () => {
    const sparql = buildEpcisQuery({ from: '2024-06-01T00:00:00Z', epc: 'urn:test' }, PARANET_ID);

    expect(sparql).toContain('>=');
    expect(sparql).toContain('2024-06-01T00:00:00Z');
    expect(sparql).not.toContain('<=');
  });

  it('filters by to date only with strict <', () => {
    const sparql = buildEpcisQuery({ to: '2024-06-01T00:00:00Z', epc: 'urn:test' }, PARANET_ID);

    expect(sparql).toMatch(/< xsd:dateTime\("2024-06-01/);
    expect(sparql).not.toMatch(/<= xsd:dateTime\("2024-06-01/);
    expect(sparql).not.toContain('>=');
  });

  it('filters by parentID', () => {
    const sparql = buildEpcisQuery({ parentID: 'urn:epc:id:sscc:4012345.0000000001' }, PARANET_ID);

    expect(sparql).toContain('epcis:parentID "urn:epc:id:sscc:4012345.0000000001"');
  });

  it('filters by childEPC', () => {
    const sparql = buildEpcisQuery({ childEPC: 'urn:epc:id:sgtin:4012345.099999.9001' }, PARANET_ID);

    expect(sparql).toContain('epcis:childEPCs "urn:epc:id:sgtin:4012345.099999.9001"');
  });

  it('filters by inputEPC', () => {
    const sparql = buildEpcisQuery({ inputEPC: 'urn:epc:id:sgtin:4012345.011111.1001' }, PARANET_ID);

    expect(sparql).toContain('epcis:inputEPCList "urn:epc:id:sgtin:4012345.011111.1001"');
  });

  it('filters by outputEPC', () => {
    const sparql = buildEpcisQuery({ outputEPC: 'urn:epc:id:sgtin:4012345.099999.9001' }, PARANET_ID);

    expect(sparql).toContain('epcis:outputEPCList "urn:epc:id:sgtin:4012345.099999.9001"');
  });

  it('epc filter UNIONs epcList + childEPCs per EPCIS 2.0 Section 8.2.7.1', () => {
    const sparql = buildEpcisQuery({ epc: 'urn:epc:id:sgtin:4012345.011111.1001' }, PARANET_ID);

    expect(sparql).toContain('UNION');
    expect(sparql).toContain('epcis:epcList "urn:epc:id:sgtin:4012345.011111.1001"');
    expect(sparql).toContain('epcis:childEPCs "urn:epc:id:sgtin:4012345.011111.1001"');
    // Should NOT include other EPC fields — that's anyEPC
    expect(sparql).not.toMatch(/epcis:inputEPCList "urn:epc:id:sgtin:4012345.011111.1001"/);
    expect(sparql).not.toMatch(/epcis:outputEPCList "urn:epc:id:sgtin:4012345.011111.1001"/);
    expect(sparql).not.toMatch(/epcis:parentID "urn:epc:id:sgtin:4012345.011111.1001"/);
  });

  it('anyEPC generates 5-way UNION across all EPC fields', () => {
    const sparql = buildEpcisQuery({ anyEPC: 'urn:epc:id:sgtin:4012345.011111.1001' }, PARANET_ID);

    expect(sparql).toContain('epcis:epcList "urn:epc:id:sgtin:4012345.011111.1001"');
    expect(sparql).toContain('epcis:childEPCs "urn:epc:id:sgtin:4012345.011111.1001"');
    expect(sparql).toContain('epcis:parentID "urn:epc:id:sgtin:4012345.011111.1001"');
    expect(sparql).toContain('epcis:inputEPCList "urn:epc:id:sgtin:4012345.011111.1001"');
    expect(sparql).toContain('epcis:outputEPCList "urn:epc:id:sgtin:4012345.011111.1001"');
    // Count UNION keywords — 5 branches = 4 UNIONs
    const unions = sparql.match(/UNION/g);
    expect(unions).toHaveLength(4);
  });

  it('combines multiple filters', () => {
    const sparql = buildEpcisQuery(
      { epc: 'urn:test', bizStep: 'receiving', bizLocation: 'urn:loc:1' },
      PARANET_ID,
    );

    // epc now UNIONs epcList + childEPCs
    expect(sparql).toContain('epcis:epcList "urn:test"');
    expect(sparql).toContain('epcis:childEPCs "urn:test"');
    expect(sparql).toContain('UNION');
    expect(sparql).toContain('BizStep-receiving');
    expect(sparql).toContain('epcis:bizLocation <urn:loc:1>');
  });

  it('uses default pagination (limit 100, offset 0)', () => {
    const sparql = buildEpcisQuery({ epc: 'urn:test' }, PARANET_ID);

    expect(sparql).toContain('LIMIT 100');
    expect(sparql).toContain('OFFSET 0');
  });

  it('respects custom pagination', () => {
    const sparql = buildEpcisQuery({ epc: 'urn:test', limit: 50, offset: 200 }, PARANET_ID);

    expect(sparql).toContain('LIMIT 50');
    expect(sparql).toContain('OFFSET 200');
  });

  it('caps limit at 1000', () => {
    const sparql = buildEpcisQuery({ epc: 'urn:test', limit: 5000 }, PARANET_ID);

    expect(sparql).toContain('LIMIT 1000');
  });

  it('clamps limit minimum to 1', () => {
    const sparql = buildEpcisQuery({ epc: 'urn:test', limit: 0 }, PARANET_ID);

    expect(sparql).toContain('LIMIT 1');
  });

  it('clamps negative offset to 0', () => {
    const sparql = buildEpcisQuery({ epc: 'urn:test', offset: -5 }, PARANET_ID);

    expect(sparql).toContain('OFFSET 0');
  });

  it('includes GROUP_CONCAT for array fields', () => {
    const sparql = buildEpcisQuery({ epc: 'urn:test' }, PARANET_ID);

    expect(sparql).toContain('GROUP_CONCAT(DISTINCT ?epc; SEPARATOR=", ") AS ?epcList');
    expect(sparql).toContain('GROUP_CONCAT(DISTINCT ?childEPCs; SEPARATOR=", ") AS ?childEPCList');
    expect(sparql).toContain('GROUP_CONCAT(DISTINCT ?inputEPCList; SEPARATOR=", ") AS ?inputEPCs');
    expect(sparql).toContain('GROUP_CONCAT(DISTINCT ?outputEPCList; SEPARATOR=", ") AS ?outputEPCs');
  });

  it('filters by disposition with shorthand normalization', () => {
    const sparql = buildEpcisQuery({ disposition: 'in_transit' }, PARANET_ID);

    expect(sparql).toContain('?event epcis:disposition ?disposition');
    expect(sparql).toContain('https://ref.gs1.org/cbv/Disp-in_transit');
    // Should NOT be OPTIONAL when filtered
    expect(sparql).not.toMatch(/OPTIONAL\s*\{[^}]*epcis:disposition/);
  });

  it('filters by disposition with full URI passthrough', () => {
    const sparql = buildEpcisQuery({ disposition: 'https://ref.gs1.org/cbv/Disp-in_progress' }, PARANET_ID);

    expect(sparql).toContain('https://ref.gs1.org/cbv/Disp-in_progress');
  });

  it('filters by readPoint — uses angle bracket URI match', () => {
    const sparql = buildEpcisQuery({ readPoint: 'urn:epc:id:sgln:4012345.00001.0' }, PARANET_ID);

    expect(sparql).toContain('epcis:readPoint <urn:epc:id:sgln:4012345.00001.0>');
  });

  it('filters by action — moves from OPTIONAL to required WHERE with FILTER', () => {
    const sparql = buildEpcisQuery({ action: 'OBSERVE' }, PARANET_ID);

    expect(sparql).toContain('?event epcis:action ?action');
    expect(sparql).toContain('FILTER(STR(?action) = "OBSERVE")');
    // Should NOT be OPTIONAL when filtered
    expect(sparql).not.toMatch(/OPTIONAL\s*\{[^}]*epcis:action/);
  });

  it('filters by eventType with full EPCIS URI', () => {
    const sparql = buildEpcisQuery({ eventType: 'ObjectEvent' }, PARANET_ID);

    expect(sparql).toContain('FILTER(?eventType = <https://gs1.github.io/EPCIS/ObjectEvent>)');
  });

  it('combines new filters with existing filters', () => {
    const sparql = buildEpcisQuery(
      { eventType: 'ObjectEvent', action: 'OBSERVE', bizStep: 'shipping', disposition: 'in_transit' },
      PARANET_ID,
    );

    expect(sparql).toContain('FILTER(?eventType = <https://gs1.github.io/EPCIS/ObjectEvent>)');
    expect(sparql).toContain('FILTER(STR(?action) = "OBSERVE")');
    expect(sparql).toContain('https://ref.gs1.org/cbv/BizStep-shipping');
    expect(sparql).toContain('https://ref.gs1.org/cbv/Disp-in_transit');
    // None of the filtered fields should be OPTIONAL
    expect(sparql).not.toMatch(/OPTIONAL\s*\{[^}]*epcis:action/);
    expect(sparql).not.toMatch(/OPTIONAL\s*\{[^}]*epcis:disposition/);
    expect(sparql).not.toMatch(/OPTIONAL\s*\{[^}]*epcis:bizStep/);
  });

  it('orders by eventTime descending with secondary sort on ?event for deterministic pagination', () => {
    const sparql = buildEpcisQuery({ epc: 'urn:test' }, PARANET_ID);

    expect(sparql).toContain('ORDER BY DESC(?eventTime) ?event');
  });
});

describe('escapeSparql', () => {
  it('escapes backslashes', () => {
    expect(escapeSparql('a\\b')).toBe('a\\\\b');
  });

  it('escapes double quotes', () => {
    expect(escapeSparql('say "hello"')).toBe('say \\"hello\\"');
  });

  it('leaves normal strings unchanged', () => {
    expect(escapeSparql('urn:epc:id:sgtin:123')).toBe('urn:epc:id:sgtin:123');
  });
});

describe('normalizeGs1Vocabulary', () => {
  it('converts BizStep shorthand to full GS1 URI', () => {
    expect(normalizeGs1Vocabulary('BizStep', 'assembling')).toBe('https://ref.gs1.org/cbv/BizStep-assembling');
    expect(normalizeGs1Vocabulary('BizStep', 'receiving')).toBe('https://ref.gs1.org/cbv/BizStep-receiving');
    expect(normalizeGs1Vocabulary('BizStep', 'shipping')).toBe('https://ref.gs1.org/cbv/BizStep-shipping');
  });

  it('converts Disp shorthand to full GS1 URI', () => {
    expect(normalizeGs1Vocabulary('Disp', 'in_transit')).toBe('https://ref.gs1.org/cbv/Disp-in_transit');
    expect(normalizeGs1Vocabulary('Disp', 'in_progress')).toBe('https://ref.gs1.org/cbv/Disp-in_progress');
  });

  it('passes through full URIs unchanged for both prefixes', () => {
    const bizStepUri = 'https://ref.gs1.org/cbv/BizStep-assembling';
    const dispUri = 'https://ref.gs1.org/cbv/Disp-in_transit';
    expect(normalizeGs1Vocabulary('BizStep', bizStepUri)).toBe(bizStepUri);
    expect(normalizeGs1Vocabulary('Disp', dispUri)).toBe(dispUri);
  });

  it('throws on empty string', () => {
    expect(() => normalizeGs1Vocabulary('BizStep', '')).toThrow('Invalid BizStep value');
    expect(() => normalizeGs1Vocabulary('Disp', '')).toThrow('Invalid Disp value');
  });
});

describe('normalizeBizStep', () => {
  it('converts shorthand to full GS1 URI', () => {
    expect(normalizeBizStep('assembling')).toBe('https://ref.gs1.org/cbv/BizStep-assembling');
    expect(normalizeBizStep('receiving')).toBe('https://ref.gs1.org/cbv/BizStep-receiving');
    expect(normalizeBizStep('shipping')).toBe('https://ref.gs1.org/cbv/BizStep-shipping');
  });

  it('passes through full URIs unchanged', () => {
    const uri = 'https://ref.gs1.org/cbv/BizStep-assembling';
    expect(normalizeBizStep(uri)).toBe(uri);
  });

  it('throws on empty string', () => {
    expect(() => normalizeBizStep('')).toThrow('Invalid bizStep');
  });
});
