import { describe, it, expect } from 'vitest';
import { handleEventsQuery, EpcisQueryError, toEpcisEvent } from '../src/handlers.js';
import type { QueryEngine } from '../src/types.js';

const CONTEXT_GRAPH_ID = 'test-cg';
const BASE_PATH = '/api/epcis/events';

interface QueryCall {
  sparql: string;
  opts: any;
}

function createTrackingQueryEngine(bindings: Record<string, string>[] = []): { engine: QueryEngine; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const engine: QueryEngine = {
    query: async (sparql: string, opts?: any) => {
      calls.push({ sparql, opts });
      return { bindings };
    },
  };
  return { engine, calls };
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
  it('returns EPCISQueryDocument envelope with reconstructed events', async () => {
    const { engine, calls } = createTrackingQueryEngine([makeBindings()]);
    const sp = new URLSearchParams('epc=urn:epc:id:sgtin:4012345.011111.1001');

    const { body } = await handleEventsQuery(sp, { contextGraphId: CONTEXT_GRAPH_ID, queryEngine: engine, basePath: BASE_PATH });

    expect(body.type).toBe('EPCISQueryDocument');
    expect(body.schemaVersion).toBe('2.0');
    expect(body['@context']).toEqual([
      'https://ref.gs1.org/standards/epcis/2.0.0/epcis-context.jsonld',
      { dkg: 'http://dkg.io/ontology/' },
    ]);

    const queryResults = body.epcisBody.queryResults;
    expect(queryResults.queryName).toBe('SimpleEventQuery');
    const eventList = queryResults.resultsBody.eventList;
    expect(eventList).toHaveLength(1);

    const event = eventList[0];
    expect(event.type).toBe('ObjectEvent');
    expect(event['dkg:ual']).toBe('did:dkg:mock:31337/42');
    expect(event.epcList).toEqual(['urn:epc:id:sgtin:4012345.011111.1001']);
    expect(event.readPoint).toEqual({ id: 'urn:epc:id:sgln:4012345.00001.0' });
    expect(event.bizLocation).toEqual({ id: 'urn:epc:id:sgln:4012345.00001.0' });

    expect(calls).toHaveLength(1);
    expect(calls[0].sparql).toContain('GRAPH <did:dkg:context-graph:test-cg>');
    expect(calls[0].opts).toEqual({ contextGraphId: CONTEXT_GRAPH_ID });
  });

  it('returns multiple events in eventList', async () => {
    const { engine } = createTrackingQueryEngine([
      makeBindings({
        event: 'urn:uuid:event-1',
        eventTime: '2024-03-01T08:00:00Z',
        ual: 'did:dkg:mock:1',
        epcList: 'urn:epc:id:sgtin:001.001.001',
      }),
      makeBindings({
        event: 'urn:uuid:event-2',
        eventType: 'https://gs1.github.io/EPCIS/AggregationEvent',
        eventTime: '2024-03-02T08:00:00Z',
        ual: 'did:dkg:mock:2',
        epcList: '',
        parentID: 'urn:epc:id:sscc:001',
        childEPCList: 'urn:child:1, urn:child:2',
      }),
      makeBindings({
        event: 'urn:uuid:event-3',
        eventType: 'https://gs1.github.io/EPCIS/TransformationEvent',
        eventTime: '2024-03-03T08:00:00Z',
        ual: 'did:dkg:mock:3',
        epcList: '',
        inputEPCs: 'urn:in:1, urn:in:2',
        outputEPCs: 'urn:out:1',
      }),
    ]);

    const { body } = await handleEventsQuery(
      new URLSearchParams('bizStep=receiving'),
      { contextGraphId: CONTEXT_GRAPH_ID, queryEngine: engine, basePath: BASE_PATH },
    );

    const eventList = body.epcisBody.queryResults.resultsBody.eventList;
    expect(eventList).toHaveLength(3);
    expect(eventList.map((event) => event['dkg:ual'])).toEqual([
      'did:dkg:mock:1',
      'did:dkg:mock:2',
      'did:dkg:mock:3',
    ]);
    expect(eventList[1]).toMatchObject({
      type: 'AggregationEvent',
      parentID: 'urn:epc:id:sscc:001',
      childEPCs: ['urn:child:1', 'urn:child:2'],
      'dkg:ual': 'did:dkg:mock:2',
    });
    expect(eventList[2]).toMatchObject({
      type: 'TransformationEvent',
      inputEPCList: ['urn:in:1', 'urn:in:2'],
      outputEPCList: ['urn:out:1'],
      'dkg:ual': 'did:dkg:mock:3',
    });
  });

  it('allows no-filter query (returns recent events)', async () => {
    const { engine, calls } = createTrackingQueryEngine([
      makeBindings({
        event: 'urn:uuid:event-1',
        ual: 'did:dkg:mock:no-filter-1',
        epcList: 'urn:epc:id:sgtin:001.001.001',
      }),
      makeBindings({
        event: 'urn:uuid:event-2',
        eventType: 'https://gs1.github.io/EPCIS/TransformationEvent',
        ual: 'did:dkg:mock:no-filter-2',
        epcList: '',
        inputEPCs: 'urn:in:1',
        outputEPCs: 'urn:out:1',
      }),
    ]);

    const { body } = await handleEventsQuery(
      new URLSearchParams(''),
      { contextGraphId: CONTEXT_GRAPH_ID, queryEngine: engine, basePath: BASE_PATH },
    );

    expect(body.epcisBody.queryResults.resultsBody.eventList).toEqual([
      expect.objectContaining({
        type: 'ObjectEvent',
        epcList: ['urn:epc:id:sgtin:001.001.001'],
        'dkg:ual': 'did:dkg:mock:no-filter-1',
      }),
      expect.objectContaining({
        type: 'TransformationEvent',
        inputEPCList: ['urn:in:1'],
        outputEPCList: ['urn:out:1'],
        'dkg:ual': 'did:dkg:mock:no-filter-2',
      }),
    ]);
    expect(calls).toHaveLength(1);
  });

  it('throws EpcisQueryError with 400 when date range is invalid', async () => {
    const { engine } = createTrackingQueryEngine();

    try {
      await handleEventsQuery(
        new URLSearchParams('epc=urn:test&from=2024-12-31T00:00:00Z&to=2024-01-01T00:00:00Z'),
        { contextGraphId: CONTEXT_GRAPH_ID, queryEngine: engine, basePath: BASE_PATH },
      );
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EpcisQueryError);
      expect((err as EpcisQueryError).statusCode).toBe(400);
      expect((err as EpcisQueryError).message).toMatch(/date range/i);
    }
  });

  it('passes eventType filter through to SPARQL query', async () => {
    const { engine, calls } = createTrackingQueryEngine([makeBindings()]);

    await handleEventsQuery(
      new URLSearchParams('eventType=ObjectEvent'),
      { contextGraphId: CONTEXT_GRAPH_ID, queryEngine: engine, basePath: BASE_PATH },
    );

    expect(calls[0].sparql).toContain('FILTER(?eventType = <https://gs1.github.io/EPCIS/ObjectEvent>)');
  });

  it('passes action filter through to SPARQL query via alias', async () => {
    const { engine, calls } = createTrackingQueryEngine([makeBindings()]);

    await handleEventsQuery(
      new URLSearchParams('action=OBSERVE'),
      { contextGraphId: CONTEXT_GRAPH_ID, queryEngine: engine, basePath: BASE_PATH },
    );

    expect(calls[0].sparql).toContain('FILTER(STR(?action) = "OBSERVE")');
  });

  it('passes disposition filter with shorthand normalization through to SPARQL', async () => {
    const { engine, calls } = createTrackingQueryEngine([makeBindings()]);

    await handleEventsQuery(
      new URLSearchParams('disposition=in_transit'),
      { contextGraphId: CONTEXT_GRAPH_ID, queryEngine: engine, basePath: BASE_PATH },
    );

    expect(calls[0].sparql).toContain('https://ref.gs1.org/cbv/Disp-in_transit');
  });

  it('passes readPoint filter through to SPARQL query', async () => {
    const { engine, calls } = createTrackingQueryEngine([makeBindings()]);

    await handleEventsQuery(
      new URLSearchParams('readPoint=urn:epc:id:sgln:4012345.00001.0'),
      { contextGraphId: CONTEXT_GRAPH_ID, queryEngine: engine, basePath: BASE_PATH },
    );

    expect(calls[0].sparql).toContain('epcis:readPoint <urn:epc:id:sgln:4012345.00001.0>');
  });

  it('returns Link header when more pages exist (perPage+1 trick)', async () => {
    const bindings = Array.from({ length: 11 }, (_, i) =>
      makeBindings({ event: `urn:uuid:event-${i}`, eventTime: `2024-03-${String(i + 1).padStart(2, '0')}T08:00:00Z` }),
    );
    const { engine } = createTrackingQueryEngine(bindings);

    const { body, headers } = await handleEventsQuery(
      new URLSearchParams('perPage=10'),
      { contextGraphId: CONTEXT_GRAPH_ID, queryEngine: engine, basePath: BASE_PATH },
    );

    expect(body.epcisBody.queryResults.resultsBody.eventList).toHaveLength(10);
    expect(headers?.link).toBeDefined();
    expect(headers!.link).toContain('rel="next"');
  });

  it('Link header URL preserves original query params and adds nextPageToken', async () => {
    const bindings = Array.from({ length: 6 }, (_, i) =>
      makeBindings({ event: `urn:uuid:event-${i}` }),
    );
    const { engine } = createTrackingQueryEngine(bindings);

    const { headers } = await handleEventsQuery(
      new URLSearchParams('epc=urn:test&bizStep=receiving&perPage=5'),
      { contextGraphId: CONTEXT_GRAPH_ID, queryEngine: engine, basePath: BASE_PATH },
    );

    expect(headers?.link).toBeDefined();
    const link = headers!.link!;
    expect(link).toContain('epc=urn');
    expect(link).toContain('bizStep=receiving');
    expect(link).toContain('nextPageToken=');
    expect(link).toContain(BASE_PATH);
    expect(link).toMatch(/^<.*>; rel="next"$/);
    expect(link).not.toContain('offset=');

    const tokenMatch = link.match(/nextPageToken=([^&>]+)/);
    expect(tokenMatch).toBeTruthy();
    const decoded = atob(decodeURIComponent(tokenMatch![1]));
    expect(decoded).toBe('offset:5');
  });

  it('defaults to perPage=30 (requests 31 from SPARQL)', async () => {
    const { engine, calls } = createTrackingQueryEngine([]);

    await handleEventsQuery(
      new URLSearchParams(''),
      { contextGraphId: CONTEXT_GRAPH_ID, queryEngine: engine, basePath: BASE_PATH },
    );

    expect(calls[0].sparql).toContain('LIMIT 31');
    expect(calls[0].sparql).toContain('OFFSET 0');
  });

  it('queries finalized canonical partition by default', async () => {
    const { engine, calls } = createTrackingQueryEngine([makeBindings()]);

    await handleEventsQuery(
      new URLSearchParams('eventType=ObjectEvent'),
      { contextGraphId: CONTEXT_GRAPH_ID, queryEngine: engine, basePath: BASE_PATH },
    );

    expect(calls[0].sparql).toContain('GRAPH <did:dkg:context-graph:test-cg>');
    expect(calls[0].sparql).not.toContain('GRAPH <did:dkg:context-graph:test-cg/_shared_memory>');
    expect(calls[0].sparql).toContain('GRAPH <did:dkg:context-graph:test-cg/_private>');
  });

  it('queries shared memory partition when finalized=false', async () => {
    const { engine, calls } = createTrackingQueryEngine([makeBindings()]);

    await handleEventsQuery(
      new URLSearchParams('finalized=false&eventType=ObjectEvent'),
      { contextGraphId: CONTEXT_GRAPH_ID, queryEngine: engine, basePath: BASE_PATH },
    );

    expect(calls[0].sparql).toContain('GRAPH <did:dkg:context-graph:test-cg/_shared_memory>');
    expect(calls[0].sparql).toContain('GRAPH <did:dkg:context-graph:test-cg/_private>');
    expect(calls[0].sparql).toContain('dkg:privateDataAnchor "true"');
  });

  it('returns full EPCIS fields from anchored private payload bindings when finalized=false', async () => {
    const { engine, calls } = createTrackingQueryEngine([
      makeBindings({
        event: 'urn:uuid:private-event',
        eventType: 'https://gs1.github.io/EPCIS/ObjectEvent',
        eventTime: '2024-04-01T08:00:00.000Z',
        action: 'OBSERVE',
        epcList: 'urn:epc:id:sgtin:4012345.011111.9999',
        bizStep: 'https://ref.gs1.org/cbv/BizStep-shipping',
        ual: '',
      }),
    ]);

    const { body } = await handleEventsQuery(
      new URLSearchParams('finalized=false&epc=urn:epc:id:sgtin:4012345.011111.9999'),
      { contextGraphId: CONTEXT_GRAPH_ID, queryEngine: engine, basePath: BASE_PATH },
    );

    expect(calls[0].sparql).toContain('dkg:privateDataAnchor "true"');
    expect(calls[0].sparql).toContain('GRAPH <did:dkg:context-graph:test-cg/_private>');
    expect(body.epcisBody.queryResults.resultsBody.eventList).toEqual([
      expect.objectContaining({
        type: 'ObjectEvent',
        action: 'OBSERVE',
        bizStep: 'https://ref.gs1.org/cbv/BizStep-shipping',
        epcList: ['urn:epc:id:sgtin:4012345.011111.9999'],
      }),
    ]);
  });

  it('constructs finalized=false private branch so orphan private payloads cannot match', async () => {
    const { engine, calls } = createTrackingQueryEngine([]);

    await handleEventsQuery(
      new URLSearchParams('finalized=false'),
      { contextGraphId: CONTEXT_GRAPH_ID, queryEngine: engine, basePath: BASE_PATH },
    );

    // Orphan exclusion: the private event subject must equal the public
    // anchor subject. We express the join by reusing `?event` across both
    // graphs (SPARQL native bind-by-name) instead of `FILTER(?event = ?root)`,
    // because some triplestores fail to bridge URI bindings across graph
    // contexts via FILTER and the anchored payload otherwise stays empty
    // on live data.
    expect(calls[0].sparql).toContain('GRAPH <did:dkg:context-graph:test-cg/_shared_memory>');
    expect(calls[0].sparql).toContain('?event dkg:privateDataAnchor "true" .');
    expect(calls[0].sparql).toContain('GRAPH <did:dkg:context-graph:test-cg/_private>');
    expect(calls[0].sparql).not.toContain('FILTER(?event = ?root)');
  });

  it('keeps finalized=false on pagination Link headers', async () => {
    const bindings = Array.from({ length: 6 }, (_, i) =>
      makeBindings({ event: `urn:uuid:event-${i}` }),
    );
    const { engine } = createTrackingQueryEngine(bindings);

    const { headers } = await handleEventsQuery(
      new URLSearchParams('finalized=false&perPage=5'),
      { contextGraphId: CONTEXT_GRAPH_ID, queryEngine: engine, basePath: BASE_PATH },
    );

    expect(headers?.link).toContain('finalized=false');
    expect(headers?.link).toContain('nextPageToken=');
  });

  it('omits Link header on last page (fewer than perPage+1 rows)', async () => {
    const bindings = Array.from({ length: 5 }, (_, i) =>
      makeBindings({ event: `urn:uuid:event-${i}` }),
    );
    const { engine } = createTrackingQueryEngine(bindings);

    const { body, headers } = await handleEventsQuery(
      new URLSearchParams('perPage=10'),
      { contextGraphId: CONTEXT_GRAPH_ID, queryEngine: engine, basePath: BASE_PATH },
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

describe('handleEventsQuery — validation', () => {
  it('does not call query engine when date range validation fails', async () => {
    const { engine, calls } = createTrackingQueryEngine();

    // Pin to date-range validation vocabulary. A bare `rejects.toThrow()`
    // would pass if the handler rejected for unrelated reasons (e.g. query
    // engine crashed, URL parse failure), masking a real validation bug.
    await expect(
      handleEventsQuery(
        new URLSearchParams('epc=urn:test&from=2024-12-31T00:00:00Z&to=2024-01-01T00:00:00Z'),
        { contextGraphId: CONTEXT_GRAPH_ID, queryEngine: engine, basePath: BASE_PATH },
      ),
    ).rejects.toThrow(/date|range|from|to|invalid|validation|before|after|order/i);

    expect(calls).toHaveLength(0);
  });
});

describe('handleEventsQuery — per-request sub-graph', () => {
  it('threads subGraphName from config into the SPARQL graph URIs (finalized=true canonical partition)', async () => {
    const { engine, calls } = createTrackingQueryEngine([makeBindings()]);

    await handleEventsQuery(
      new URLSearchParams('eventType=ObjectEvent'),
      {
        contextGraphId: CONTEXT_GRAPH_ID,
        subGraphName: 'research',
        queryEngine: engine,
        basePath: BASE_PATH,
      },
    );

    // Finalized sub-graph URI is `<cg>/<sub>` (no `/context/` segment),
    // matching `packages/agent/src/finalization-handler.ts:358-362`
    // (the publisher's actual write target). The earlier expectation
    // against `<cg>/context/<sub>` read from a graph URI the publisher
    // never populates — finalized sub-graph queries returned zero rows.
    expect(calls[0].sparql).toContain('GRAPH <did:dkg:context-graph:test-cg/research>');
    expect(calls[0].sparql).not.toContain('GRAPH <did:dkg:context-graph:test-cg/context/research>');
    expect(calls[0].sparql).toContain('GRAPH <did:dkg:context-graph:test-cg/research/_private>');
    expect(calls[0].sparql).not.toContain('GRAPH <did:dkg:context-graph:test-cg>');
    expect(calls[0].sparql).not.toContain('GRAPH <did:dkg:context-graph:test-cg/_private>');
  });

  it('threads subGraphName into SPARQL graph URIs (finalized=false SWM partition)', async () => {
    const { engine, calls } = createTrackingQueryEngine([makeBindings()]);

    await handleEventsQuery(
      new URLSearchParams('finalized=false&eventType=ObjectEvent'),
      {
        contextGraphId: CONTEXT_GRAPH_ID,
        subGraphName: 'research',
        queryEngine: engine,
        basePath: BASE_PATH,
      },
    );

    expect(calls[0].sparql).toContain('GRAPH <did:dkg:context-graph:test-cg/research/_shared_memory>');
    expect(calls[0].sparql).toContain('GRAPH <did:dkg:context-graph:test-cg/research/_private>');
    expect(calls[0].sparql).not.toContain('GRAPH <did:dkg:context-graph:test-cg/_shared_memory>');
    expect(calls[0].sparql).not.toContain('GRAPH <did:dkg:context-graph:test-cg/_private>');
  });

  it('falls back to root partition when subGraphName is omitted', async () => {
    const { engine, calls } = createTrackingQueryEngine([makeBindings()]);

    await handleEventsQuery(
      new URLSearchParams('eventType=ObjectEvent'),
      {
        contextGraphId: CONTEXT_GRAPH_ID,
        queryEngine: engine,
        basePath: BASE_PATH,
      },
    );

    expect(calls[0].sparql).toContain('GRAPH <did:dkg:context-graph:test-cg>');
    expect(calls[0].sparql).toContain('GRAPH <did:dkg:context-graph:test-cg/_private>');
    expect(calls[0].sparql).not.toContain('test-cg/research');
  });
});
