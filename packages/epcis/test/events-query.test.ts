import { describe, it, expect, vi } from 'vitest';
import { handleEventsQuery, EpcisQueryError, toEpcisEvent } from '../src/handlers.js';
import type { QueryEngine } from '../src/types.js';

const PARANET_ID = 'test-paranet';
const BASE_PATH = '/api/epcis/events';

function mockQueryEngine(bindings: Record<string, string>[] = []): QueryEngine {
  return {
    query: vi.fn().mockResolvedValue({ bindings }),
  };
}

function makeBindings(overrides: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    event: 'urn:uuid:event-1',
    eventType: 'https://gs1.github.io/EPCIS/ObjectEvent',
    eventTime: '2024-03-01T08:00:00.000Z',
    bizStep: 'https://ref.gs1.org/cbv/BizStep-receiving',
    bizLocation: 'urn:epc:id:sgln:4012345.00001.0',
    disposition: 'https://ref.gs1.org/cbv/Disp-in_progress',
    readPoint: 'urn:epc:id:sgln:4012345.00001.0',
    action: 'ADD',
    parentID: '',
    epcList: 'urn:epc:id:sgtin:4012345.011111.1001',
    childEPCList: '',
    inputEPCs: '',
    outputEPCs: '',
    ual: 'did:dkg:mock:31337/42',
    ...overrides,
  };
}

describe('handleEventsQuery', () => {
  const defaultConfig = { paranetId: PARANET_ID, queryEngine: mockQueryEngine(), basePath: BASE_PATH };

  it('returns EPCISQueryDocument envelope with reconstructed events', async () => {
    const engine = mockQueryEngine([makeBindings()]);
    const sp = new URLSearchParams('epc=urn:epc:id:sgtin:4012345.011111.1001');

    const { body } = await handleEventsQuery(sp, { ...defaultConfig, queryEngine: engine });

    // Envelope structure
    expect(body.type).toBe('EPCISQueryDocument');
    expect(body.schemaVersion).toBe('2.0');
    expect(body['@context']).toEqual([
      'https://ref.gs1.org/standards/epcis/2.0.0/epcis-context.jsonld',
      { dkg: 'http://dkg.io/ontology/' },
    ]);

    // Query results body
    const queryResults = body.epcisBody.queryResults;
    expect(queryResults.queryName).toBe('SimpleEventQuery');
    const eventList = queryResults.resultsBody.eventList;
    expect(eventList).toHaveLength(1);

    // First event is reconstructed
    const event = eventList[0];
    expect(event.type).toBe('ObjectEvent');
    expect(event['dkg:ual']).toBe('did:dkg:mock:31337/42');
    expect(event.epcList).toEqual(['urn:epc:id:sgtin:4012345.011111.1001']);
    expect(event.readPoint).toEqual({ id: 'urn:epc:id:sgln:4012345.00001.0' });
    expect(event.bizLocation).toEqual({ id: 'urn:epc:id:sgln:4012345.00001.0' });

    // Verify the query engine was called with paranetId
    expect(engine.query).toHaveBeenCalledOnce();
    const [sparql, opts] = (engine.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sparql).toContain('GRAPH <did:dkg:paranet:test-paranet>');
    expect(opts).toEqual({ paranetId: PARANET_ID });
  });

  it('returns multiple events in eventList', async () => {
    const engine = mockQueryEngine([
      makeBindings({ event: 'urn:uuid:event-1', eventTime: '2024-03-01T08:00:00Z' }),
      makeBindings({ event: 'urn:uuid:event-2', eventTime: '2024-03-02T08:00:00Z' }),
      makeBindings({ event: 'urn:uuid:event-3', eventTime: '2024-03-03T08:00:00Z' }),
    ]);

    const { body } = await handleEventsQuery(
      new URLSearchParams('bizStep=receiving'),
      { ...defaultConfig, queryEngine: engine },
    );

    expect(body.epcisBody.queryResults.resultsBody.eventList).toHaveLength(3);
  });

  it('allows no-filter query (returns recent events)', async () => {
    const engine = mockQueryEngine([
      makeBindings({ event: 'urn:uuid:event-1' }),
      makeBindings({ event: 'urn:uuid:event-2' }),
    ]);

    const { body } = await handleEventsQuery(
      new URLSearchParams(''),
      { ...defaultConfig, queryEngine: engine },
    );

    expect(body.epcisBody.queryResults.resultsBody.eventList).toHaveLength(2);
    expect(engine.query).toHaveBeenCalledOnce();
  });

  it('throws EpcisQueryError with 400 when date range is invalid', async () => {
    const engine = mockQueryEngine();

    try {
      await handleEventsQuery(
        new URLSearchParams('epc=urn:test&from=2024-12-31T00:00:00Z&to=2024-01-01T00:00:00Z'),
        { ...defaultConfig, queryEngine: engine },
      );
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EpcisQueryError);
      expect((err as EpcisQueryError).statusCode).toBe(400);
      expect((err as EpcisQueryError).message).toMatch(/date range/i);
    }
  });

  it('passes eventType filter through to SPARQL query', async () => {
    const engine = mockQueryEngine([makeBindings()]);

    await handleEventsQuery(
      new URLSearchParams('eventType=ObjectEvent'),
      { ...defaultConfig, queryEngine: engine },
    );

    const [sparql] = (engine.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sparql).toContain('FILTER(?eventType = <https://gs1.github.io/EPCIS/ObjectEvent>)');
  });

  it('passes action filter through to SPARQL query via alias', async () => {
    const engine = mockQueryEngine([makeBindings()]);

    await handleEventsQuery(
      new URLSearchParams('action=OBSERVE'),
      { ...defaultConfig, queryEngine: engine },
    );

    const [sparql] = (engine.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sparql).toContain('FILTER(STR(?action) = "OBSERVE")');
  });

  it('passes disposition filter with shorthand normalization through to SPARQL', async () => {
    const engine = mockQueryEngine([makeBindings()]);

    await handleEventsQuery(
      new URLSearchParams('disposition=in_transit'),
      { ...defaultConfig, queryEngine: engine },
    );

    const [sparql] = (engine.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sparql).toContain('https://ref.gs1.org/cbv/Disp-in_transit');
  });

  it('passes readPoint filter through to SPARQL query', async () => {
    const engine = mockQueryEngine([makeBindings()]);

    await handleEventsQuery(
      new URLSearchParams('readPoint=urn:epc:id:sgln:4012345.00001.0'),
      { ...defaultConfig, queryEngine: engine },
    );

    const [sparql] = (engine.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sparql).toContain('FILTER(STR(?readPoint) = "urn:epc:id:sgln:4012345.00001.0")');
  });

  it('returns Link header when more pages exist (perPage+1 trick)', async () => {
    // Engine returns 11 rows for perPage=10 → more pages exist
    const bindings = Array.from({ length: 11 }, (_, i) =>
      makeBindings({ event: `urn:uuid:event-${i}`, eventTime: `2024-03-${String(i + 1).padStart(2, '0')}T08:00:00Z` }),
    );
    const engine = mockQueryEngine(bindings);

    const { body, headers } = await handleEventsQuery(
      new URLSearchParams('perPage=10'),
      { ...defaultConfig, queryEngine: engine },
    );

    // Should return only 10 events (the extra row is discarded)
    expect(body.epcisBody.queryResults.resultsBody.eventList).toHaveLength(10);
    // Link header should be present
    expect(headers?.link).toBeDefined();
    expect(headers!.link).toContain('rel="next"');
  });

  it('Link header URL preserves original query params and adds nextPageToken', async () => {
    const bindings = Array.from({ length: 6 }, (_, i) =>
      makeBindings({ event: `urn:uuid:event-${i}` }),
    );
    const engine = mockQueryEngine(bindings);

    const { headers } = await handleEventsQuery(
      new URLSearchParams('epc=urn:test&bizStep=receiving&perPage=5'),
      { ...defaultConfig, queryEngine: engine },
    );

    expect(headers?.link).toBeDefined();
    const link = headers!.link!;
    // Should preserve original params
    expect(link).toContain('epc=urn');
    expect(link).toContain('bizStep=receiving');
    // Should contain nextPageToken
    expect(link).toContain('nextPageToken=');
    // Should use basePath
    expect(link).toContain(BASE_PATH);
    // Should have rel="next"
    expect(link).toMatch(/^<.*>; rel="next"$/);
    // Should NOT contain raw offset or perPage+1 internal details
    expect(link).not.toContain('offset=');

    // Decode the token to verify it encodes the correct next offset
    const tokenMatch = link.match(/nextPageToken=([^&>]+)/);
    expect(tokenMatch).toBeTruthy();
    const decoded = atob(decodeURIComponent(tokenMatch![1]));
    expect(decoded).toBe('offset:5');
  });

  it('defaults to perPage=30 (requests 31 from SPARQL)', async () => {
    const engine = mockQueryEngine([]);

    await handleEventsQuery(
      new URLSearchParams(''),
      { ...defaultConfig, queryEngine: engine },
    );

    const [sparql] = (engine.query as ReturnType<typeof vi.fn>).mock.calls[0];
    // Default perPage=30, so the handler requests 31 (perPage+1)
    expect(sparql).toContain('LIMIT 31');
    expect(sparql).toContain('OFFSET 0');
  });

  it('omits Link header on last page (fewer than perPage+1 rows)', async () => {
    // Engine returns 5 rows for perPage=10 → last page
    const bindings = Array.from({ length: 5 }, (_, i) =>
      makeBindings({ event: `urn:uuid:event-${i}` }),
    );
    const engine = mockQueryEngine(bindings);

    const { body, headers } = await handleEventsQuery(
      new URLSearchParams('perPage=10'),
      { ...defaultConfig, queryEngine: engine },
    );

    expect(body.epcisBody.queryResults.resultsBody.eventList).toHaveLength(5);
    expect(headers).toBeUndefined();
  });

});

describe('toEpcisEvent', () => {
  it('strips eventType URI prefix to short name', () => {
    const binding = makeBindings({ eventType: 'https://gs1.github.io/EPCIS/ObjectEvent' });
    const event = toEpcisEvent(binding);
    expect(event.type).toBe('ObjectEvent');
  });

  it('strips AggregationEvent URI to short name', () => {
    const binding = makeBindings({ eventType: 'https://gs1.github.io/EPCIS/AggregationEvent' });
    const event = toEpcisEvent(binding);
    expect(event.type).toBe('AggregationEvent');
  });

  it('splits epcList GROUP_CONCAT string into array', () => {
    const binding = makeBindings({ epcList: 'urn:epc:id:sgtin:001.001.001, urn:epc:id:sgtin:001.001.002' });
    const event = toEpcisEvent(binding);
    expect(event.epcList).toEqual(['urn:epc:id:sgtin:001.001.001', 'urn:epc:id:sgtin:001.001.002']);
  });

  it('splits single epcList value into single-element array', () => {
    const binding = makeBindings({ epcList: 'urn:epc:id:sgtin:001.001.001' });
    const event = toEpcisEvent(binding);
    expect(event.epcList).toEqual(['urn:epc:id:sgtin:001.001.001']);
  });

  it('wraps readPoint in { id } object', () => {
    const binding = makeBindings({ readPoint: 'urn:epc:id:sgln:4012345.00001.0' });
    const event = toEpcisEvent(binding);
    expect(event.readPoint).toEqual({ id: 'urn:epc:id:sgln:4012345.00001.0' });
  });

  it('wraps bizLocation in { id } object', () => {
    const binding = makeBindings({ bizLocation: 'urn:epc:id:sgln:4012345.00001.0' });
    const event = toEpcisEvent(binding);
    expect(event.bizLocation).toEqual({ id: 'urn:epc:id:sgln:4012345.00001.0' });
  });

  it('omits empty fields from event object', () => {
    const binding = makeBindings({
      epcList: '',
      childEPCList: '',
      inputEPCs: '',
      outputEPCs: '',
      readPoint: '',
      bizLocation: '',
      action: '',
      parentID: '',
      disposition: '',
      bizStep: '',
      ual: '',
    });
    const event = toEpcisEvent(binding);

    // Only type and eventTime should be present
    expect(event.type).toBe('ObjectEvent');
    expect(event.eventTime).toBe('2024-03-01T08:00:00.000Z');
    expect(event).not.toHaveProperty('epcList');
    expect(event).not.toHaveProperty('childEPCs');
    expect(event).not.toHaveProperty('inputEPCList');
    expect(event).not.toHaveProperty('outputEPCList');
    expect(event).not.toHaveProperty('readPoint');
    expect(event).not.toHaveProperty('bizLocation');
    expect(event).not.toHaveProperty('action');
    expect(event).not.toHaveProperty('parentID');
    expect(event).not.toHaveProperty('disposition');
    expect(event).not.toHaveProperty('bizStep');
    expect(event).not.toHaveProperty('dkg:ual');
  });

  it('includes dkg:ual when UAL binding is present', () => {
    const binding = makeBindings({ ual: 'did:dkg:hardhat1:31337/0x123/42' });
    const event = toEpcisEvent(binding);
    expect(event['dkg:ual']).toBe('did:dkg:hardhat1:31337/0x123/42');
  });

  it('omits dkg:ual when UAL binding is empty', () => {
    const binding = makeBindings({ ual: '' });
    const event = toEpcisEvent(binding);
    expect(event).not.toHaveProperty('dkg:ual');
  });

  it('splits childEPCList, inputEPCs, outputEPCs into arrays', () => {
    const binding = makeBindings({
      childEPCList: 'urn:child:1, urn:child:2',
      inputEPCs: 'urn:in:1, urn:in:2',
      outputEPCs: 'urn:out:1',
    });
    const event = toEpcisEvent(binding);
    expect(event.childEPCs).toEqual(['urn:child:1', 'urn:child:2']);
    expect(event.inputEPCList).toEqual(['urn:in:1', 'urn:in:2']);
    expect(event.outputEPCList).toEqual(['urn:out:1']);
  });
});

// Remaining handler tests kept below
describe('handleEventsQuery — validation', () => {
  it('does not call query engine when date range validation fails', async () => {
    const engine = mockQueryEngine();

    await expect(
      handleEventsQuery(
        new URLSearchParams('epc=urn:test&from=2024-12-31T00:00:00Z&to=2024-01-01T00:00:00Z'),
        { paranetId: PARANET_ID, queryEngine: engine, basePath: BASE_PATH },
      ),
    ).rejects.toThrow();

    expect(engine.query).not.toHaveBeenCalled();
  });
});
