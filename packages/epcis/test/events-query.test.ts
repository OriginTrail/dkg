import { describe, it, expect } from 'vitest';
import { handleEventsQuery, EpcisQueryError, toEpcisEvent, unwrapLiteral } from '../src/handlers.js';
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
    const { engine, calls } = createTrackingQueryEngine([
      makeBindings({
        configurationId: 'CFG-001',
        shipmentId: 'SHIP-001',
      }),
    ]);
    const sp = new URLSearchParams('epc=urn:epc:id:sgtin:4012345.011111.1001');

    const { body } = await handleEventsQuery(sp, { contextGraphId: CONTEXT_GRAPH_ID, queryEngine: engine, basePath: BASE_PATH });

    expect(body.type).toBe('EPCISQueryDocument');
    expect(body.schemaVersion).toBe('2.0');
    expect(body['@context']).toEqual([
      'https://ref.gs1.org/standards/epcis/2.0.0/epcis-context.jsonld',
      {
        dkg: 'http://dkg.io/ontology/',
        configurationId: 'http://dkg.io/ontology/epcis/configurationId',
        shipmentId: 'http://dkg.io/ontology/epcis/shipmentId',
      },
    ]);

    const queryResults = body.epcisBody.queryResults;
    expect(queryResults.queryName).toBe('SimpleEventQuery');
    const eventList = queryResults.resultsBody.eventList;
    expect(eventList).toHaveLength(1);

    const event = eventList[0];
    expect(event.type).toBe('ObjectEvent');
    expect(event['dkg:ual']).toBe('did:dkg:mock:31337/42');
    expect(event.configurationId).toBe('CFG-001');
    expect(event.shipmentId).toBe('SHIP-001');
    expect(event.epcList).toEqual(['urn:epc:id:sgtin:4012345.011111.1001']);
    expect(event.readPoint).toEqual({ id: 'urn:epc:id:sgln:4012345.00001.0' });
    expect(event.bizLocation).toEqual({ id: 'urn:epc:id:sgln:4012345.00001.0' });

    expect(calls).toHaveLength(1);
    expect(calls[0].sparql).toContain('GRAPH <did:dkg:context-graph:test-cg>');
    // The events query references the CG's `_private` partition, so the
    // engine must be told to allow it (else the scope guard rejects it).
    expect(calls[0].opts).toEqual({ contextGraphId: CONTEXT_GRAPH_ID, includePrivate: true });
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

  it('passes extension configurationId and shipmentId filters through to SPARQL', async () => {
    const { engine, calls } = createTrackingQueryEngine([makeBindings()]);

    await handleEventsQuery(
      new URLSearchParams('EQ_configurationId=CFG-001&shipmentId=SHIP-001'),
      { contextGraphId: CONTEXT_GRAPH_ID, queryEngine: engine, basePath: BASE_PATH },
    );

    expect(calls[0].sparql).toContain('?event ?configurationIdPredicate ?configurationId');
    expect(calls[0].sparql).toContain('FILTER(REPLACE(STR(?configurationIdPredicate), "^.*[/#]", "") = "configurationId")');
    expect(calls[0].sparql).toContain('FILTER(STR(?configurationId) = "CFG-001")');
    expect(calls[0].sparql).toContain('?event ?shipmentIdPredicate ?shipmentId');
    expect(calls[0].sparql).toContain('FILTER(REPLACE(STR(?shipmentIdPredicate), "^.*[/#]", "") = "shipmentId")');
    expect(calls[0].sparql).toContain('FILTER(STR(?shipmentId) = "SHIP-001")');
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
      eventTimeZoneOffset: '',
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
    expect(event).not.toHaveProperty('eventTimeZoneOffset');
    expect(event).not.toHaveProperty('dkg:ual');
  });

  it('includes dkg:ual when UAL binding is present', () => {
    const binding = makeBindings({ ual: 'did:dkg:hardhat1:31337/0x123/42' });
    const event = toEpcisEvent(binding);
    expect(event['dkg:ual']).toBe('did:dkg:hardhat1:31337/0x123/42');
  });

  it('includes extension configurationId and shipmentId when bindings are present', () => {
    const binding = makeBindings({
      configurationId: '"CFG-001"',
      shipmentId: '"SHIP-001"',
    });
    const event = toEpcisEvent(binding);
    expect(event.configurationId).toBe('CFG-001');
    expect(event.shipmentId).toBe('SHIP-001');
  });

  it('includes eventTimeZoneOffset when binding is present', () => {
    const binding = makeBindings({ eventTimeZoneOffset: '"+02:00"' });
    const event = toEpcisEvent(binding);
    expect(event.eventTimeZoneOffset).toBe('+02:00');
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
    // Bug 3: the handler MUST thread `subGraphName` into the engine options so
    // the scope guard admits `<cg>/<sub>` (+ `<cg>/<sub>/_private`). Without it
    // every sub-graph events request fails with "Scoped query violation".
    // Finalized route → no graphSuffix (reads the canonical data partition).
    expect(calls[0].opts).toMatchObject({
      contextGraphId: CONTEXT_GRAPH_ID,
      subGraphName: 'research',
      includePrivate: true,
    });
    expect(calls[0].opts.graphSuffix).toBeUndefined();
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
    // Bug 3: finalized=false routes the read to the SWM partition, so the
    // handler must thread BOTH `subGraphName` and `graphSuffix:'_shared_memory'`
    // (else the guard rejects `<cg>/<sub>/_shared_memory[_meta]`).
    expect(calls[0].opts).toMatchObject({
      contextGraphId: CONTEXT_GRAPH_ID,
      subGraphName: 'research',
      graphSuffix: '_shared_memory',
      includePrivate: true,
    });
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
    // Finalized canonical root route: no sub-graph, no SWM suffix.
    expect(calls[0].opts).toMatchObject({ contextGraphId: CONTEXT_GRAPH_ID, includePrivate: true });
    expect(calls[0].opts.subGraphName).toBeUndefined();
    expect(calls[0].opts.graphSuffix).toBeUndefined();
  });

  it('threads graphSuffix for finalized=false on the root partition (no sub-graph)', async () => {
    const { engine, calls } = createTrackingQueryEngine([makeBindings()]);

    await handleEventsQuery(
      new URLSearchParams('finalized=false&eventType=ObjectEvent'),
      { contextGraphId: CONTEXT_GRAPH_ID, queryEngine: engine, basePath: BASE_PATH },
    );

    expect(calls[0].sparql).toContain('GRAPH <did:dkg:context-graph:test-cg/_shared_memory>');
    // Bug 3: SWM route on the root CG still needs the graphSuffix or the guard
    // rejects `<cg>/_shared_memory` (only the canonical `<cg>` is allowed
    // otherwise).
    expect(calls[0].opts).toMatchObject({
      contextGraphId: CONTEXT_GRAPH_ID,
      graphSuffix: '_shared_memory',
      includePrivate: true,
    });
    expect(calls[0].opts.subGraphName).toBeUndefined();
  });
});

// Regression coverage for the linear-scan rewrite of `unwrapLiteral`. The
// prior greedy regex (`/^"(.*)"(?:\^\^<.*>)?$/s`) was vulnerable to
// catastrophic backtracking on malformed inputs because triplestore-
// controlled strings flow through this function. The linear parser must
// stay O(n) in input length AND preserve the same observable behaviour
// on the typed/plain/raw paths used elsewhere in handlers.ts.
describe('unwrapLiteral (CodeQL ReDoS regression)', () => {
  it('unwraps a plain N-Quads string literal', () => {
    expect(unwrapLiteral('"hello"')).toBe('hello');
  });

  it('unwraps a typed N-Quads literal', () => {
    expect(unwrapLiteral('"2024-03-01T08:00:00.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>'))
      .toBe('2024-03-01T08:00:00.000Z');
  });

  it('returns empty / falsy inputs unchanged', () => {
    expect(unwrapLiteral('')).toBe('');
    expect(unwrapLiteral(undefined as unknown as string)).toBeUndefined();
  });

  it('returns bare unquoted strings unchanged (URI bindings)', () => {
    expect(unwrapLiteral('urn:epc:id:sgtin:001.001.001'))
      .toBe('urn:epc:id:sgtin:001.001.001');
    expect(unwrapLiteral('https://gs1.github.io/EPCIS/ObjectEvent'))
      .toBe('https://gs1.github.io/EPCIS/ObjectEvent');
  });

  it('returns malformed inputs (no closing quote) unchanged', () => {
    expect(unwrapLiteral('"missing close')).toBe('"missing close');
  });

  it('returns malformed inputs (trailing garbage after literal) unchanged', () => {
    // `"value"trailing` is not a recognised N-Quads shape — must NOT unwrap.
    expect(unwrapLiteral('"value"trailing')).toBe('"value"trailing');
  });

  it('honours backslash-escaped quotes inside the literal', () => {
    // \" stays inside the literal — the closing quote is the unescaped one.
    expect(unwrapLiteral('"foo\\"bar"')).toBe('foo\\"bar');
  });

  it('runs in linear time on adversarial inputs that broke the old regex', () => {
    // The prior greedy regex `/^"(.*)"(?:\^\^<.*>)?$/s` exponentially
    // backtracks on inputs that look like repeated typed-literal suffixes
    // without ever matching the closing anchor. The linear parser must
    // process N such inputs in O(N) time.
    //
    // The regression we care about is asymptotic, NOT absolute speed on
    // any given machine — a fixed wall-clock ceiling (e.g. `<100ms`) is
    // flake-prone on busy CI runners. Instead, sample two input sizes
    // (1k and 10k) and assert the 10x-larger input does not blow up
    // catastrophically. Catastrophic backtracking is exponential; any
    // linear scan stays well within the generous 25x ratio bound even
    // with GC pauses and CPU contention.
    //
    // The 1000ms absolute ceiling is the hang guard: if the parser ever
    // becomes pathologically slow on the larger input, the test fails
    // cleanly instead of timing out the suite.
    const adversarial = (n: number) => '"' + '"^^<x>'.repeat(n);

    // Take min across repeats to filter out GC / scheduler noise. The
    // O(n) parser is allocation-light, so the spread between repeats is
    // typically <2x even on cold runs.
    const measure = (n: number) => {
      let minMs = Infinity;
      for (let i = 0; i < 5; i++) {
        const input = adversarial(n);
        const t0 = performance.now();
        const result = unwrapLiteral(input);
        const elapsed = performance.now() - t0;
        // Sanity: result is always a string regardless of tail recognition.
        expect(typeof result).toBe('string');
        if (elapsed < minMs) minMs = elapsed;
      }
      return minMs;
    };

    const smallMs = measure(1_000);
    const largeMs = measure(10_000);

    // Hang guard: 10k repetitions should finish in well under a second
    // on any modern CI. The exponential regex would take >>10s here.
    expect(largeMs).toBeLessThan(1000);

    // Linearity guard: 10x input → ratio must stay bounded. The `+ 25ms`
    // cushion guards against the degenerate case where `smallMs ≈ 0` and
    // any wall-clock noise on `largeMs` would otherwise blow the ratio.
    // A 25x ceiling on linear growth leaves ample headroom for jitter
    // while still failing decisively on exponential blow-up.
    expect(largeMs).toBeLessThan(smallMs * 25 + 25);
  });
});
