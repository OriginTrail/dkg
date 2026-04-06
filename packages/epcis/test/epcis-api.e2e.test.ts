/**
 * EPCIS API End-to-End Test Suite
 *
 * Tests the full round-trip against a live DKG node:
 * HTTP → validation → publish → SPARQL query → response
 *
 * Written against the EPCIS 2.0 Conformance PRD (Asana task 1213722180223357).
 * Tests verify the INTENDED API contract, not the current implementation state.
 * Failures surface gaps in the daemon integration layer.
 *
 * Prerequisites:
 *   1. Add "epcis": { "contextGraphId": "testing" } to ~/.dkg/config.json
 *   2. Restart daemon: dkg stop && dkg start
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { loadTokens } from '../../cli/src/auth.js';
import { readApiPort } from '../../cli/src/config.js';

// ---------------------------------------------------------------------------
// Test isolation: unique prefix per run
// ---------------------------------------------------------------------------

const RUN_ID = Date.now();
const makeEpc = (suffix: string) => `urn:epc:id:sgtin:TEST.${RUN_ID}.${suffix}`;

// ---------------------------------------------------------------------------
// Shared state populated in beforeAll
// ---------------------------------------------------------------------------

let BASE_URL = '';
let TOKEN = '';
let nodeReachable = false;

type StoryCaptureKey = 'objectEvent' | 'transformationEvent' | 'aggregationEvent';

type CaptureResponseData = {
  ual: string;
  kcId: string;
  status: string;
  receivedAt: string;
  eventCount: number;
};

// Captures created for the run-scoped bicycle story.
const capturedUals: Partial<Record<StoryCaptureKey, string>> = {};
const capturedResponses: Partial<Record<StoryCaptureKey, CaptureResponseData>> = {};

// ---------------------------------------------------------------------------
// Test EPCs for the bicycle supply-chain story
// ---------------------------------------------------------------------------

const EPC = {
  frame: makeEpc('frame'),
  handlebars: makeEpc('handlebars'),
  wheels: makeEpc('wheels'),
  bicycle: makeEpc('bicycle'),
  pallet: makeEpc('pallet'),
};

const LOCATION = {
  receiving: 'urn:epc:id:sgln:TEST.00001.0',
  assembly: 'urn:epc:id:sgln:TEST.00003.0',
  packing: 'urn:epc:id:sgln:TEST.00004.0',
};

const EVENT_ID = {
  objectEvent: `urn:uuid:${RUN_ID}-story-object`,
  transformationEvent: `urn:uuid:${RUN_ID}-story-transformation`,
  aggregationEvent: `urn:uuid:${RUN_ID}-story-aggregation`,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EPCIS_CONTEXT = {
  '@vocab': 'https://gs1.github.io/EPCIS/',
  'epcis': 'https://gs1.github.io/EPCIS/',
  'cbv': 'https://ref.gs1.org/cbv/',
  'type': '@type',
  'id': '@id',
  'eventID': '@id',
};

function makeValidDoc(events: Record<string, unknown>[]) {
  return {
    '@context': EPCIS_CONTEXT,
    type: 'EPCISDocument',
    schemaVersion: '2.0',
    creationDate: new Date().toISOString(),
    epcisBody: { eventList: events },
  };
}

let eventCounter = 0;
function makeObjectEvent(overrides: Record<string, unknown> = {}) {
  return {
    eventID: `urn:uuid:${RUN_ID}-obj-${++eventCounter}`,
    type: 'ObjectEvent',
    eventTime: new Date().toISOString(),
    eventTimeZoneOffset: '+00:00',
    epcList: [EPC.frame],
    action: 'ADD',
    bizStep: 'https://ref.gs1.org/cbv/BizStep-receiving',
    disposition: 'https://ref.gs1.org/cbv/Disp-in_progress',
    readPoint: { id: 'urn:epc:id:sgln:TEST.00001.0' },
    bizLocation: { id: 'urn:epc:id:sgln:TEST.00001.0' },
    ...overrides,
  };
}

function makeStoryObjectDoc() {
  return makeValidDoc([
    makeObjectEvent({
      eventID: EVENT_ID.objectEvent,
      epcList: [EPC.frame],
      eventTime: '2024-03-01T08:00:00.000Z',
      bizStep: 'https://ref.gs1.org/cbv/BizStep-receiving',
      bizLocation: { id: LOCATION.receiving },
      readPoint: { id: LOCATION.receiving },
    }),
  ]);
}

function makeStoryTransformationDoc() {
  return makeValidDoc([
    {
      eventID: EVENT_ID.transformationEvent,
      type: 'TransformationEvent',
      eventTime: '2024-03-01T12:00:00.000Z',
      eventTimeZoneOffset: '+00:00',
      inputEPCList: [EPC.frame, EPC.handlebars, EPC.wheels],
      outputEPCList: [EPC.bicycle],
      bizStep: 'https://ref.gs1.org/cbv/BizStep-commissioning',
      disposition: 'https://ref.gs1.org/cbv/Disp-active',
      readPoint: { id: LOCATION.assembly },
      bizLocation: { id: LOCATION.assembly },
    },
  ]);
}

function makeStoryAggregationDoc() {
  return makeValidDoc([
    {
      eventID: EVENT_ID.aggregationEvent,
      type: 'AggregationEvent',
      eventTime: '2024-03-01T14:00:00.000Z',
      eventTimeZoneOffset: '+00:00',
      parentID: EPC.pallet,
      childEPCs: [EPC.bicycle],
      action: 'ADD',
      bizStep: 'https://ref.gs1.org/cbv/BizStep-packing',
      disposition: 'https://ref.gs1.org/cbv/Disp-in_progress',
      readPoint: { id: LOCATION.packing },
      bizLocation: { id: LOCATION.packing },
    },
  ]);
}

function authedFetch(method: string, path: string, body?: unknown): Promise<Response> {
  const opts: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  return fetch(`${BASE_URL}${path}`, opts);
}

function rawFetch(method: string, path: string, opts: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, { method, ...opts });
}

async function captureDoc(doc: Record<string, unknown>): Promise<CaptureResponseData> {
  const res = await authedFetch('POST', '/api/epcis/capture', { epcisDocument: doc });
  expect(res.status).toBe(200);

  const data = await res.json() as CaptureResponseData;
  expect(typeof data.ual).toBe('string');
  expect(typeof data.kcId).toBe('string');
  expect(typeof data.status).toBe('string');
  expect(typeof data.eventCount).toBe('number');
  expect(typeof data.receivedAt).toBe('string');
  expect(Number.isNaN(Date.parse(data.receivedAt))).toBe(false);

  return data;
}

async function ensureStoryCapture(name: StoryCaptureKey): Promise<CaptureResponseData> {
  const existing = capturedResponses[name];
  if (existing && capturedUals[name]) {
    try {
      const events = await fetchEvents(`/api/epcis/events?eventID=${encodeURIComponent(EVENT_ID[name])}`);
      if (eventUals(events).includes(capturedUals[name]!)) {
        return existing;
      }
    } catch {
      // Fall through and recapture if the cached data is no longer queryable.
    }
  }

  const docByName: Record<StoryCaptureKey, Record<string, unknown>> = {
    objectEvent: makeStoryObjectDoc(),
    transformationEvent: makeStoryTransformationDoc(),
    aggregationEvent: makeStoryAggregationDoc(),
  };

  const data = await captureDoc(docByName[name]);
  capturedResponses[name] = data;
  capturedUals[name] = data.ual;
  return data;
}

async function ensureHappyPathCaptures() {
  if (!nodeReachable) return;
  await ensureStoryCapture('objectEvent');
  await ensureStoryCapture('transformationEvent');
  await ensureStoryCapture('aggregationEvent');
}

function getCapturedUal(name: StoryCaptureKey): string {
  const ual = capturedUals[name];
  expect(ual).toBeDefined();
  return ual!;
}

function expectQueryDoc(data: Record<string, unknown>): Record<string, unknown> {
  expect(data.type).toBe('EPCISQueryDocument');
  expect(data.schemaVersion).toBe('2.0');
  expect(Array.isArray(data['@context'])).toBe(true);
  return data;
}

async function fetchQueryDoc(path: string): Promise<Record<string, unknown>> {
  const res = await authedFetch('GET', path);
  expect(res.status).toBe(200);
  return expectQueryDoc(await res.json());
}

async function fetchQuery(path: string): Promise<{
  body: Record<string, unknown>;
  events: Record<string, unknown>[];
  headers: Headers;
}> {
  const res = await authedFetch('GET', path);
  expect(res.status).toBe(200);
  const body = expectQueryDoc(await res.json());
  return { body, events: extractEventList(body), headers: res.headers };
}

function extractEventList(data: Record<string, unknown>): Record<string, unknown>[] {
  const doc = expectQueryDoc(data);
  const epcisBody = doc.epcisBody as Record<string, unknown> | undefined;
  const queryResults = epcisBody?.queryResults as Record<string, unknown> | undefined;
  const resultsBody = queryResults?.resultsBody as Record<string, unknown> | undefined;
  return (resultsBody?.eventList ?? []) as Record<string, unknown>[];
}

async function fetchEvents(path: string): Promise<Record<string, unknown>[]> {
  return extractEventList(await fetchQueryDoc(path));
}

function eventUals(events: Record<string, unknown>[]): string[] {
  return events.map((event) => String(event['dkg:ual'])).sort();
}

async function expectEventUals(path: string, expectedUals: string[]): Promise<Record<string, unknown>[]> {
  const events = await fetchEvents(path);
  expect(eventUals(events)).toEqual([...expectedUals].sort());
  return events;
}

// ---------------------------------------------------------------------------
// Suite setup — resolve port + token, check reachability
// ---------------------------------------------------------------------------

beforeAll(async () => {
  try {
    const envPort = process.env.DKG_API_PORT ? parseInt(process.env.DKG_API_PORT, 10) : null;
    const port = envPort ?? (await readApiPort()) ?? 9200;
    BASE_URL = `http://127.0.0.1:${port}`;

    const tokens = await loadTokens();
    TOKEN = tokens.values().next().value as string;

    const res = await fetch(`${BASE_URL}/api/status`, { signal: AbortSignal.timeout(5000) });
    nodeReachable = res.ok;
  } catch {
    console.warn('DKG node not reachable — all E2E tests will be skipped');
    nodeReachable = false;
  }
}, 15_000);

// ===================================================================
// All tests wrapped: skip gracefully when no node is available
// ===================================================================

describe('EPCIS API E2E', () => {
  beforeEach(({ skip }) => {
    if (!nodeReachable) skip();
  });

  // =================================================================
  // Category 1: Connectivity & EPCIS Config
  // =================================================================

  describe('Category 1: Connectivity & EPCIS Config', () => {
    it('node is reachable at /api/status', async () => {
      const res = await fetch(`${BASE_URL}/api/status`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveProperty('peerId');
    });

    it('EPCIS endpoints return 200 (not 503), confirming contextGraphId is configured', async () => {
      // Per PRD user story #20: no-filter query returns 30 most recent events
      const res = await authedFetch('GET', '/api/epcis/events');
      expect(res.status).not.toBe(503);
      expect(res.status).toBe(200);
    }, 30_000);
  });

  // =================================================================
  // Category 2: Authentication
  // =================================================================

  describe('Category 2: Authentication', () => {
    it('no Authorization header → 401', async () => {
      const res = await rawFetch('GET', '/api/epcis/events?epc=test');
      expect(res.status).toBe(401);
    });

    it('empty Authorization header → 401', async () => {
      const res = await rawFetch('GET', '/api/epcis/events?epc=test', {
        headers: { Authorization: '' },
      });
      expect(res.status).toBe(401);
    });

    it('invalid bearer token → 401', async () => {
      const res = await rawFetch('GET', '/api/epcis/events?epc=test', {
        headers: { Authorization: 'Bearer totally-invalid-token-12345' },
      });
      expect(res.status).toBe(401);
    });

    it('"Bearer " with no token after it → 401', async () => {
      const res = await rawFetch('GET', '/api/epcis/events?epc=test', {
        headers: { Authorization: 'Bearer ' },
      });
      expect(res.status).toBe(401);
    });

    it('all EPCIS endpoints reject without auth', async () => {
      const [events, capture] = await Promise.all([
        rawFetch('GET', '/api/epcis/events?epc=test'),
        rawFetch('POST', '/api/epcis/capture', {
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        }),
      ]);
      expect(events.status).toBe(401);
      expect(capture.status).toBe(401);
    });

    it('wrong auth scheme (Basic) → 401', async () => {
      const encoded = Buffer.from('user:pass').toString('base64');
      const res = await rawFetch('GET', '/api/epcis/events?epc=test', {
        headers: { Authorization: `Basic ${encoded}` },
      });
      expect(res.status).toBe(401);
    });

    it('valid token works → 200 with an EPCISQueryDocument response', async () => {
      const doc = await fetchQueryDoc('/api/epcis/events?epc=urn:epc:nonexistent');
      expect(extractEventList(doc)).toHaveLength(0);
    });
  });

  // =================================================================
  // Category 3: Happy Path — Bicycle Supply Chain Round-Trip
  // =================================================================

  describe('Category 3: Happy Path — Bicycle Supply Chain', () => {
    it(
      'capture ObjectEvent (receiving bicycle frame)',
      async () => {
        const data = await ensureStoryCapture('objectEvent');
        expect(data.eventCount).toBe(1);
      },
      120_000,
    );

    it(
      'capture TransformationEvent (assembly: frame+handlebars+wheels → bicycle)',
      async () => {
        const data = await ensureStoryCapture('transformationEvent');
        expect(data.eventCount).toBe(1);
      },
      120_000,
    );

    it(
      'capture AggregationEvent (packing bicycle onto pallet)',
      async () => {
        const data = await ensureStoryCapture('aggregationEvent');
        expect(data.eventCount).toBe(1);
      },
      120_000,
    );

    it(
      'query by epc (MATCH_epc) returns the frame ObjectEvent from this run',
      async () => {
        await ensureHappyPathCaptures();
        // Per PRD: MATCH_epc / epc= searches epcList + childEPCs per Section 8.2.7.1
        const events = await expectEventUals(
          `/api/epcis/events?epc=${encodeURIComponent(EPC.frame)}`,
          [getCapturedUal('objectEvent')],
        );
        expect(events[0].type).toBe('ObjectEvent');
      },
      30_000,
    );

    it(
      'query by bizStep=receiving (shorthand alias) returns the frame ObjectEvent',
      async () => {
        await ensureHappyPathCaptures();
        // PRD user story #2: aliases (bizStep) produce same results as standard names (EQ_bizStep)
        const events = await expectEventUals(
          `/api/epcis/events?MATCH_anyEPC=${encodeURIComponent(EPC.frame)}&bizStep=receiving`,
          [getCapturedUal('objectEvent')],
        );
        expect(String(events[0].bizStep)).toContain('receiving');
      },
      30_000,
    );

    it(
      'query with MATCH_anyEPC (fullTrace backward compat) for frame → 2 events',
      async () => {
        await ensureHappyPathCaptures();
        // PRD user story #9: MATCH_anyEPC searches all 5 EPC fields
        // PRD user story #10: epc=X&fullTrace=true is backward-compat alias for MATCH_anyEPC=X
        // Frame appears in: ObjectEvent epcList + TransformationEvent inputEPCList
        // NOT in AggregationEvent (only the assembled bicycle appears there)
        const events = await expectEventUals(
          `/api/epcis/events?epc=${encodeURIComponent(EPC.frame)}&fullTrace=true`,
          [getCapturedUal('objectEvent'), getCapturedUal('transformationEvent')],
        );
        expect(events.length).toBe(2);
      },
      30_000,
    );
  });

  // =================================================================
  // Category 4: Query Result Integrity
  // =================================================================

  describe('Category 4: Query Result Integrity', () => {
    beforeAll(async () => {
      await ensureHappyPathCaptures();
    });

    it(
      'query by bizLocation returns the frame ObjectEvent from this run',
      async () => {
        const events = await expectEventUals(
          `/api/epcis/events?MATCH_anyEPC=${encodeURIComponent(EPC.frame)}&bizLocation=${encodeURIComponent(LOCATION.receiving)}`,
          [getCapturedUal('objectEvent')],
        );
        const loc = events[0].bizLocation as { id: string } | undefined;
        expect(loc?.id).toBe(LOCATION.receiving);
      },
      30_000,
    );

    it(
      'full bizStep URI vs shorthand alias → same results (PRD user story #22)',
      async () => {
        const [fullEvents, shortEvents] = await Promise.all([
          fetchEvents(
            `/api/epcis/events?MATCH_anyEPC=${encodeURIComponent(EPC.frame)}&EQ_bizStep=${encodeURIComponent('https://ref.gs1.org/cbv/BizStep-receiving')}`,
          ),
          fetchEvents(
            `/api/epcis/events?MATCH_anyEPC=${encodeURIComponent(EPC.frame)}&bizStep=receiving`,
          ),
        ]);

        const expected = [getCapturedUal('objectEvent')];
        expect(eventUals(fullEvents)).toEqual(expected);
        expect(eventUals(shortEvents)).toEqual(expected);
      },
      30_000,
    );

    it(
      'query by parentID (pallet) → AggregationEvent',
      async () => {
        const events = await expectEventUals(
          `/api/epcis/events?parentID=${encodeURIComponent(EPC.pallet)}`,
          [getCapturedUal('aggregationEvent')],
        );
        expect(events[0].type).toBe('AggregationEvent');
      },
      30_000,
    );

    it(
      'query by childEPC (bicycle) → AggregationEvent (DKG-specific narrow filter)',
      async () => {
        // PRD user story #11: childEPC is a DKG-specific filter that searches only childEPCs
        const events = await expectEventUals(
          `/api/epcis/events?childEPC=${encodeURIComponent(EPC.bicycle)}`,
          [getCapturedUal('aggregationEvent')],
        );
        expect(events[0].type).toBe('AggregationEvent');
      },
      30_000,
    );

    it(
      'query by inputEPC (frame) → TransformationEvent',
      async () => {
        const events = await expectEventUals(
          `/api/epcis/events?inputEPC=${encodeURIComponent(EPC.frame)}`,
          [getCapturedUal('transformationEvent')],
        );
        expect(events[0].type).toBe('TransformationEvent');
      },
      30_000,
    );

    it(
      'query by outputEPC (bicycle) → TransformationEvent',
      async () => {
        const events = await expectEventUals(
          `/api/epcis/events?outputEPC=${encodeURIComponent(EPC.bicycle)}`,
          [getCapturedUal('transformationEvent')],
        );
        expect(events[0].type).toBe('TransformationEvent');
      },
      30_000,
    );

    it(
      'query by date range encompassing all events → events within range',
      async () => {
        // PRD: GE_eventTime (alias: from) and LT_eventTime (alias: to)
        const events = await expectEventUals(
          `/api/epcis/events?epc=${encodeURIComponent(EPC.frame)}&fullTrace=true&from=2024-03-01T00:00:00Z&to=2024-03-02T00:00:00Z`,
          [getCapturedUal('objectEvent'), getCapturedUal('transformationEvent')],
        );
        expect(events.length).toBe(2);
      },
      30_000,
    );

    it(
      'MATCH_anyEPC for bicycle → TransformationEvent + AggregationEvent',
      async () => {
        // PRD user story #9: MATCH_anyEPC searches all 5 EPC fields
        // Bicycle appears in: TransformationEvent outputEPCList + AggregationEvent childEPCs
        const events = await expectEventUals(
          `/api/epcis/events?MATCH_anyEPC=${encodeURIComponent(EPC.bicycle)}`,
          [getCapturedUal('aggregationEvent'), getCapturedUal('transformationEvent')],
        );
        expect(events.length).toBe(2);
      },
      30_000,
    );
  });

  // =================================================================
  // Category 5: Capture Validation Boundaries
  // =================================================================

  describe('Category 5: Capture Validation Boundaries', () => {
    it('missing epcisDocument key → 400', async () => {
      const res = await authedFetch('POST', '/api/epcis/capture', { notTheRightKey: {} });
      expect(res.status).toBe(400);
    });

    it('epcisDocument: null → 400', async () => {
      const res = await authedFetch('POST', '/api/epcis/capture', { epcisDocument: null });
      expect(res.status).toBe(400);
    });

    it('epcisDocument: "" (empty string) → 400', async () => {
      const res = await authedFetch('POST', '/api/epcis/capture', { epcisDocument: '' });
      expect(res.status).toBe(400);
    });

    it('epcisDocument: 42 (truthy non-object) → 400', async () => {
      const res = await authedFetch('POST', '/api/epcis/capture', { epcisDocument: 42 });
      expect(res.status).toBe(400);
    });

    it('epcisDocument: [1,2,3] (array) → 400', async () => {
      const res = await authedFetch('POST', '/api/epcis/capture', { epcisDocument: [1, 2, 3] });
      expect(res.status).toBe(400);
    });

    it('missing @context → 400', async () => {
      const res = await authedFetch('POST', '/api/epcis/capture', {
        epcisDocument: {
          type: 'EPCISDocument',
          schemaVersion: '2.0',
          creationDate: new Date().toISOString(),
          epcisBody: { eventList: [makeObjectEvent()] },
        },
      });
      expect(res.status).toBe(400);
    });

    it('missing schemaVersion → 400', async () => {
      const res = await authedFetch('POST', '/api/epcis/capture', {
        epcisDocument: {
          '@context': EPCIS_CONTEXT,
          type: 'EPCISDocument',
          creationDate: new Date().toISOString(),
          epcisBody: { eventList: [makeObjectEvent()] },
        },
      });
      expect(res.status).toBe(400);
    });

    it('missing creationDate → 400', async () => {
      const res = await authedFetch('POST', '/api/epcis/capture', {
        epcisDocument: {
          '@context': EPCIS_CONTEXT,
          type: 'EPCISDocument',
          schemaVersion: '2.0',
          epcisBody: { eventList: [makeObjectEvent()] },
        },
      });
      expect(res.status).toBe(400);
    });

    it('missing epcisBody → 400', async () => {
      const res = await authedFetch('POST', '/api/epcis/capture', {
        epcisDocument: {
          '@context': EPCIS_CONTEXT,
          type: 'EPCISDocument',
          schemaVersion: '2.0',
          creationDate: new Date().toISOString(),
        },
      });
      expect(res.status).toBe(400);
    });

    it('empty eventList → 400', async () => {
      const res = await authedFetch('POST', '/api/epcis/capture', {
        epcisDocument: makeValidDoc([]),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('eventList must contain at least one event');
    });

    it('wrong type: "NotEPCIS" → 400', async () => {
      const doc = makeValidDoc([makeObjectEvent()]);
      (doc as Record<string, unknown>).type = 'NotEPCIS';
      const res = await authedFetch('POST', '/api/epcis/capture', { epcisDocument: doc });
      expect(res.status).toBe(400);
    });

    it('invalid eventTime format → 400', async () => {
      const doc = makeValidDoc([makeObjectEvent({ eventTime: 'not-a-date' })]);
      const res = await authedFetch('POST', '/api/epcis/capture', { epcisDocument: doc });
      expect(res.status).toBe(400);
    });

    it('epcisDocument: {} → 400', async () => {
      const res = await authedFetch('POST', '/api/epcis/capture', { epcisDocument: {} });
      expect(res.status).toBe(400);
    });

    it('epcisDocument: true → 400', async () => {
      const res = await authedFetch('POST', '/api/epcis/capture', { epcisDocument: true });
      expect(res.status).toBe(400);
    });

    it(
      'event without eventID → still succeeds (blank nodes auto-assigned UUIDs)',
      async () => {
        const doc = makeValidDoc([{
          type: 'ObjectEvent',
          eventTime: new Date().toISOString(),
          eventTimeZoneOffset: '+00:00',
          epcList: [`urn:epc:id:sgtin:TEST.${RUN_ID}.no-event-id`],
          action: 'ADD',
          bizStep: 'https://ref.gs1.org/cbv/BizStep-receiving',
        }]);
        const res = await authedFetch('POST', '/api/epcis/capture', { epcisDocument: doc });
        // Should succeed — blank nodes get auto-assigned uuid: URIs like dkg.js v8
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data).toHaveProperty('ual');
      },
      120_000,
    );
  });

  // =================================================================
  // Category 6: Malformed Request Body
  // =================================================================

  describe('Category 6: Malformed Request Body', () => {
    it('invalid JSON body → 400', async () => {
      // Daemon now wraps JSON.parse in try/catch and returns 400
      const res = await fetch(`${BASE_URL}/api/epcis/capture`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN}`,
        },
        body: 'this is not json {',
      });
      expect(res.status).toBe(400);
    });

    it('empty POST body → 400', async () => {
      const res = await fetch(`${BASE_URL}/api/epcis/capture`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN}`,
        },
        body: '',
      });
      expect(res.status).toBe(400);
    });

    it(
      'wrong Content-Type with valid JSON → still processes (Content-Type agnostic)',
      async () => {
        const body = JSON.stringify({ epcisDocument: makeValidDoc([makeObjectEvent({ epcList: [makeEpc('content-type-test')] })]) });
        const res = await fetch(`${BASE_URL}/api/epcis/capture`, {
          method: 'POST',
          headers: {
            'Content-Type': 'text/xml',
            Authorization: `Bearer ${TOKEN}`,
          },
          body,
        });
        // The daemon reads raw bytes regardless of Content-Type
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(typeof data.ual).toBe('string');
      },
      120_000,
    );

    it('double-encoded JSON → 400 "Missing epcisDocument"', async () => {
      const doc = makeValidDoc([makeObjectEvent()]);
      const doubleEncoded = JSON.stringify(JSON.stringify({ epcisDocument: doc }));
      const res = await fetch(`${BASE_URL}/api/epcis/capture`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN}`,
        },
        body: doubleEncoded,
      });
      expect(res.status).toBe(400);
    });

    it('array as top-level JSON → 400', async () => {
      const doc = makeValidDoc([makeObjectEvent()]);
      const res = await fetch(`${BASE_URL}/api/epcis/capture`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify([{ epcisDocument: doc }]),
      });
      expect(res.status).toBe(400);
    });
  });

  // =================================================================
  // Category 7: Query Parameter Edge Cases
  // =================================================================

  describe('Category 7: Query Parameter Edge Cases', () => {
    beforeAll(async () => {
      await ensureHappyPathCaptures();
    });

    it(
      'no query params → returns a valid first page of at most 30 events',
      async () => {
        const { events, headers } = await fetchQuery('/api/epcis/events');
        expect(Array.isArray(events)).toBe(true);
        expect(events.length).toBeLessThanOrEqual(30);

        const link = headers.get('link');
        if (events.length < 30) {
          expect(link).toBeNull();
        } else if (link) {
          expect(link).toContain('nextPageToken=');
        }
      },
      30_000,
    );

    it('invalid date range (from > to) → 400', async () => {
      const res = await authedFetch(
        'GET',
        '/api/epcis/events?epc=test&from=2024-12-31T00:00:00Z&to=2024-01-01T00:00:00Z',
      );
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('date range');
    });

    it(
      'equal from and to → 200 with 0 events (LT_eventTime is strict <)',
      async () => {
        // PRD user story #19: LT_eventTime uses strict < not <=
        // from=X & to=X means >= X && < X — logically empty range
        const ts = '2024-03-01T08:00:00Z';
        const events = await fetchEvents(
          `/api/epcis/events?MATCH_anyEPC=${encodeURIComponent(EPC.frame)}&from=${ts}&to=${ts}`,
        );
        expect(events.length).toBe(0);
      },
      30_000,
    );

    it(
      'invalid date string in bounded range → 400',
      async () => {
        const res = await authedFetch(
          'GET',
          '/api/epcis/events?epc=test&from=not-a-date&to=2024-03-02T00:00:00Z',
        );
        expect(res.status).toBe(400);
      },
      30_000,
    );

    it(
      'perPage=1 → returns only the newest matching event and a next-page link',
      async () => {
        const { events, headers } = await fetchQuery(
          `/api/epcis/events?MATCH_anyEPC=${encodeURIComponent(EPC.frame)}&perPage=1`,
        );

        expect(eventUals(events)).toEqual([getCapturedUal('transformationEvent')]);
        expect(events[0].type).toBe('TransformationEvent');
        expect(headers.get('link')).toContain('nextPageToken=');
      },
      30_000,
    );

    it(
      'limit works as alias for perPage and preserves pagination behavior',
      async () => {
        const { events, headers } = await fetchQuery(
          `/api/epcis/events?MATCH_anyEPC=${encodeURIComponent(EPC.frame)}&limit=1`,
        );

        expect(eventUals(events)).toEqual([getCapturedUal('transformationEvent')]);
        expect(events[0].type).toBe('TransformationEvent');
        expect(headers.get('link')).toContain('nextPageToken=');
      },
      30_000,
    );

    it(
      'very large offset → 200 with 0 events',
      async () => {
        const events = await fetchEvents(
          `/api/epcis/events?MATCH_anyEPC=${encodeURIComponent(EPC.frame)}&offset=999999`,
        );
        expect(events).toHaveLength(0);
      },
      30_000,
    );

    it(
      'non-numeric limit → ignored, uses default perPage',
      async () => {
        const expected = [getCapturedUal('objectEvent'), getCapturedUal('transformationEvent')].sort();
        const { events, headers } = await fetchQuery(
          `/api/epcis/events?MATCH_anyEPC=${encodeURIComponent(EPC.frame)}&limit=abc`,
        );
        expect(eventUals(events)).toEqual(expected);
        expect(headers.get('link')).toBeNull();
      },
      30_000,
    );
  });

  // =================================================================
  // Category 8: SPARQL Injection / Special Characters
  // =================================================================

  describe('Category 8: SPARQL Injection / Special Characters', () => {
    it(
      'EPC with double quotes → escaped, returns 0 events',
      async () => {
        const epc = 'urn:epc:id:sgtin:TEST."injection".1';
        const res = await authedFetch('GET', `/api/epcis/events?epc=${encodeURIComponent(epc)}`);
        expect(res.status).toBe(200);
        const events = extractEventList(await res.json());
        expect(events).toHaveLength(0);
      },
      30_000,
    );

    it(
      'EPC with backslash → escaped, returns 0 events',
      async () => {
        const epc = 'urn:epc:id:sgtin:TEST.\\backslash.1';
        const res = await authedFetch('GET', `/api/epcis/events?epc=${encodeURIComponent(epc)}`);
        expect(res.status).toBe(200);
        const events = extractEventList(await res.json());
        expect(events).toHaveLength(0);
      },
      30_000,
    );

    it(
      'EPC with SPARQL comment char # → no query breakage',
      async () => {
        const epc = 'urn:epc:id:sgtin:TEST.#comment.1';
        const { events } = await fetchQuery(`/api/epcis/events?epc=${encodeURIComponent(epc)}`);
        expect(events).toHaveLength(0);
      },
      30_000,
    );

    it(
      'EPC with curly braces }{ → no injection',
      async () => {
        const epc = 'urn:epc:id:sgtin:TEST.}{.1';
        const { events } = await fetchQuery(`/api/epcis/events?epc=${encodeURIComponent(epc)}`);
        expect(events).toHaveLength(0);
      },
      30_000,
    );

    it(
      'EPC containing literal percent-encoded text remains a literal string',
      async () => {
        const epc = 'urn:epc:id:sgtin:TEST.%0Anewline.1';
        const { events } = await fetchQuery(`/api/epcis/events?epc=${encodeURIComponent(epc)}`);
        expect(events).toHaveLength(0);
      },
      30_000,
    );

    it(
      'bizStep with injection attempt → normalized, quotes escaped',
      async () => {
        const bizStep = 'receiving" } UNION { ?x ?y ?z } #';
        const { events } = await fetchQuery(
          `/api/epcis/events?bizStep=${encodeURIComponent(bizStep)}`,
        );
        expect(events).toHaveLength(0);
      },
      30_000,
    );

    it(
      'bizLocation with URI fragment → treated as a literal URI filter and returns 0 events',
      async () => {
        const loc = 'urn:epc:id:sgln:TEST.00001.0#fragment';
        const { events } = await fetchQuery(`/api/epcis/events?bizLocation=${encodeURIComponent(loc)}`);
        expect(events).toHaveLength(0);
      },
      30_000,
    );

    it(
      'EPC with unicode → treated as literal text and returns 0 events',
      async () => {
        const epc = 'urn:epc:id:sgtin:TEST.🚲.1';
        const { events } = await fetchQuery(`/api/epcis/events?epc=${encodeURIComponent(epc)}`);
        expect(events).toHaveLength(0);
      },
      30_000,
    );
  });

  // =================================================================
  // Category 9: EPCIS 2.0 Standard Parameter Names
  // (Replaces old track endpoint tests — track removed per PR #219)
  // =================================================================

  describe('Category 9: EPCIS 2.0 Standard Parameter Names', () => {
    beforeAll(async () => {
      await ensureHappyPathCaptures();
    });

    it(
      'MATCH_epc produces same results as epc alias (PRD user story #22)',
      async () => {
        const [standardEvents, aliasEvents] = await Promise.all([
          fetchEvents(`/api/epcis/events?MATCH_epc=${encodeURIComponent(EPC.frame)}`),
          fetchEvents(`/api/epcis/events?epc=${encodeURIComponent(EPC.frame)}`),
        ]);

        const expected = [getCapturedUal('objectEvent')];
        expect(eventUals(standardEvents)).toEqual(expected);
        expect(eventUals(aliasEvents)).toEqual(expected);
      },
      30_000,
    );

    it(
      'GE_eventTime / LT_eventTime produce same results as from/to aliases',
      async () => {
        const from = '2024-03-01T00:00:00Z';
        const to = '2024-03-02T00:00:00Z';
        const epc = encodeURIComponent(EPC.frame);

        const [standardRes, aliasRes] = await Promise.all([
          fetchEvents(`/api/epcis/events?MATCH_anyEPC=${epc}&GE_eventTime=${from}&LT_eventTime=${to}`),
          fetchEvents(`/api/epcis/events?epc=${epc}&fullTrace=true&from=${from}&to=${to}`),
        ]);

        const expected = [getCapturedUal('objectEvent'), getCapturedUal('transformationEvent')];
        expect(eventUals(standardRes)).toEqual([...expected].sort());
        expect(eventUals(aliasRes)).toEqual([...expected].sort());
      },
      30_000,
    );

    it(
      'MATCH_anyEPC directly → 5-way UNION search (PRD user story #9)',
      async () => {
        const events = await expectEventUals(
          `/api/epcis/events?MATCH_anyEPC=${encodeURIComponent(EPC.frame)}`,
          [getCapturedUal('objectEvent'), getCapturedUal('transformationEvent')],
        );
        // Frame in ObjectEvent epcList + TransformationEvent inputEPCList
        expect(events.length).toBe(2);
      },
      30_000,
    );

    it(
      'eventType filter → only events of that type (PRD user story #3)',
      async () => {
        const events = await expectEventUals(
          `/api/epcis/events?MATCH_anyEPC=${encodeURIComponent(EPC.frame)}&eventType=ObjectEvent`,
          [getCapturedUal('objectEvent')],
        );
        expect(events[0].type).toBe('ObjectEvent');
      },
      30_000,
    );

    it(
      'EQ_action filter → only events with that action (PRD user story #4)',
      async () => {
        const events = await expectEventUals(
          `/api/epcis/events?MATCH_anyEPC=${encodeURIComponent(EPC.frame)}&EQ_action=ADD`,
          [getCapturedUal('objectEvent')],
        );
        expect(events[0].action).toBe('ADD');
      },
      30_000,
    );

    it(
      'EQ_disposition filter with shorthand → normalized to full URI (PRD user story #6)',
      async () => {
        const events = await expectEventUals(
          `/api/epcis/events?MATCH_anyEPC=${encodeURIComponent(EPC.frame)}&EQ_disposition=in_progress`,
          [getCapturedUal('objectEvent')],
        );
        expect(events[0].disposition).toBe('https://ref.gs1.org/cbv/Disp-in_progress');
      },
      30_000,
    );

    it(
      'EQ_readPoint filter → events at that read point (PRD user story #7)',
      async () => {
        const events = await expectEventUals(
          `/api/epcis/events?MATCH_anyEPC=${encodeURIComponent(EPC.frame)}&EQ_readPoint=${encodeURIComponent(LOCATION.receiving)}`,
          [getCapturedUal('objectEvent')],
        );
        const rp = events[0].readPoint as { id: string } | undefined;
        expect(rp?.id).toBe(LOCATION.receiving);
      },
      30_000,
    );
  });

  // =================================================================
  // Category 10: HTTP Method Validation
  // =================================================================

  describe('Category 10: HTTP Method Validation', () => {
    it('GET /api/epcis/capture → 404', async () => {
      const res = await authedFetch('GET', '/api/epcis/capture');
      expect(res.status).toBe(404);
    });

    it('POST /api/epcis/events → 404', async () => {
      const res = await authedFetch('POST', '/api/epcis/events');
      expect(res.status).toBe(404);
    });

    it('PUT /api/epcis/capture → 404', async () => {
      const res = await fetch(`${BASE_URL}/api/epcis/capture`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN}`,
        },
        body: '{}',
      });
      expect(res.status).toBe(404);
    });

    it('DELETE /api/epcis/events → 404', async () => {
      const res = await fetch(`${BASE_URL}/api/epcis/events`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(404);
    });
  });

  // =================================================================
  // Category 11: Capture with publishOptions
  // =================================================================

  describe('Category 11: Capture with publishOptions', () => {
    it(
      'accessPolicy: "public" → 200',
      async () => {
        const doc = makeValidDoc([makeObjectEvent({ epcList: [makeEpc('pub-policy')] })]);
        const res = await authedFetch('POST', '/api/epcis/capture', {
          epcisDocument: doc,
          publishOptions: { accessPolicy: 'public' },
        });
        expect(res.status).toBe(200);
      },
      120_000,
    );

    it(
      'accessPolicy: "ownerOnly" → 200',
      async () => {
        const doc = makeValidDoc([makeObjectEvent({ epcList: [makeEpc('owner-policy')] })]);
        const res = await authedFetch('POST', '/api/epcis/capture', {
          epcisDocument: doc,
          publishOptions: { accessPolicy: 'ownerOnly' },
        });
        expect(res.status).toBe(200);
      },
      120_000,
    );

    it(
      'no publishOptions (default) → 200',
      async () => {
        const doc = makeValidDoc([makeObjectEvent({ epcList: [makeEpc('no-policy')] })]);
        const res = await authedFetch('POST', '/api/epcis/capture', { epcisDocument: doc });
        expect(res.status).toBe(200);
      },
      120_000,
    );
  });

  // =================================================================
  // Category 12: Response Shape Validation
  // =================================================================

  describe('Category 12: Response Shape Validation', () => {
    beforeAll(async () => {
      await ensureHappyPathCaptures();
    });

    it(
      'capture response has correct shape',
      async () => {
        const doc = makeValidDoc([makeObjectEvent({ epcList: [makeEpc('shape-capture')] })]);
        const res = await authedFetch('POST', '/api/epcis/capture', { epcisDocument: doc });
        expect(res.status).toBe(200);
        const data = await res.json();

        expect(typeof data.ual).toBe('string');
        expect(typeof data.kcId).toBe('string');
        expect(typeof data.status).toBe('string');
        expect(typeof data.eventCount).toBe('number');
        expect(typeof data.receivedAt).toBe('string');
        expect(Number.isNaN(Date.parse(data.receivedAt))).toBe(false);
      },
      120_000,
    );

    it(
      'events response is a standard EPCISQueryDocument (PRD user story #12)',
      async () => {
        const doc = await fetchQueryDoc(`/api/epcis/events?epc=${encodeURIComponent(EPC.frame)}`);

        // EPCISQueryDocument envelope
        expect(doc.type).toBe('EPCISQueryDocument');
        expect(doc.schemaVersion).toBe('2.0');
        expect(Array.isArray(doc['@context'])).toBe(true);

        // queryResults structure
        const epcisBody = doc.epcisBody as Record<string, unknown>;
        expect(epcisBody).toBeDefined();
        const qr = epcisBody.queryResults as Record<string, unknown>;
        expect(qr.queryName).toBe('SimpleEventQuery');
        const rb = qr.resultsBody as Record<string, unknown>;
        expect(Array.isArray(rb.eventList)).toBe(true);
      },
      30_000,
    );

    it(
      'daemon returns EPCISQueryDocument directly (not wrapped in { body })',
      async () => {
        // PRD says the HTTP response body IS the EPCISQueryDocument.
        // This test surfaces if the daemon is wrapping it in { body: ... }.
        const res = await authedFetch(
          'GET',
          `/api/epcis/events?MATCH_anyEPC=${encodeURIComponent(EPC.frame)}&eventType=ObjectEvent`,
        );
        expect(res.status).toBe(200);
        const data = await res.json();
        // Should have type directly on data, not nested under data.body
        expect(data.body).toBeUndefined();
        expect(data.type).toBe('EPCISQueryDocument');
      },
      30_000,
    );

    it(
      'events are proper EPCIS event objects (PRD user story #13)',
      async () => {
        const events = await expectEventUals(
          `/api/epcis/events?epc=${encodeURIComponent(EPC.frame)}`,
          [getCapturedUal('objectEvent')],
        );

        const event = events[0];
        expect(event).toMatchObject({
          type: 'ObjectEvent',
          eventTime: '2024-03-01T08:00:00.000Z',
          epcList: [EPC.frame],
          action: 'ADD',
          bizStep: 'https://ref.gs1.org/cbv/BizStep-receiving',
          disposition: 'https://ref.gs1.org/cbv/Disp-in_progress',
          readPoint: { id: LOCATION.receiving },
          bizLocation: { id: LOCATION.receiving },
        });
        expect(event).not.toHaveProperty('parentID');
        expect(event).not.toHaveProperty('childEPCs');
        expect(event).not.toHaveProperty('inputEPCList');
        expect(event).not.toHaveProperty('outputEPCList');

        for (const [, val] of Object.entries(event)) {
          expect(val).not.toBe('');
        }
      },
      30_000,
    );

    it(
      'each event includes dkg:ual for provenance (PRD user story #14)',
      async () => {
        const doc = await fetchQueryDoc(
          `/api/epcis/events?MATCH_anyEPC=${encodeURIComponent(EPC.frame)}`,
        );
        const events = extractEventList(doc);
        expect(eventUals(events)).toEqual([
          getCapturedUal('objectEvent'),
          getCapturedUal('transformationEvent'),
        ].sort());

        // dkg:ual namespaced field
        for (const event of events) {
          expect(event['dkg:ual']).toBeDefined();
          expect(typeof event['dkg:ual']).toBe('string');
        }

        // DKG context in @context array
        const contexts = doc['@context'] as unknown[];
        const hasDkgContext = contexts.some(
          (c) => typeof c === 'object' && c !== null && (c as Record<string, unknown>).dkg === 'http://dkg.io/ontology/',
        );
        expect(hasDkgContext).toBe(true);
      },
      30_000,
    );

    it('error responses have error string', async () => {
      // Use invalid date range to trigger a 400 error
      const res = await authedFetch(
        'GET',
        '/api/epcis/events?epc=test&from=2024-12-31T00:00:00Z&to=2024-01-01T00:00:00Z',
      );
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(typeof data.error).toBe('string');
    });
  });

  // =================================================================
  // Category 13: Multi-Filter Combination
  // =================================================================

  describe('Category 13: Multi-Filter Combination', () => {
    beforeAll(async () => {
      await ensureHappyPathCaptures();
    });

    it(
      'epc + bizStep → only event matching BOTH (AND semantics)',
      async () => {
        const events = await expectEventUals(
          `/api/epcis/events?epc=${encodeURIComponent(EPC.frame)}&bizStep=receiving`,
          [getCapturedUal('objectEvent')],
        );
        // Frame is in ObjectEvent epcList + AggregationEvent? No, frame is only in ObjectEvent epcList.
        // MATCH_epc searches epcList + childEPCs. Frame isn't a child anywhere.
        // Only the ObjectEvent has frame in epcList AND bizStep receiving.
        expect(events.length).toBe(1);
        expect(events[0].type).toBe('ObjectEvent');
      },
      30_000,
    );

    it(
      'anyEPC + narrow date range → excludes events outside range',
      async () => {
        // Narrow range covering only ObjectEvent time (08:00), not TransformationEvent (12:00)
        // PRD user story #19: LT_eventTime uses strict <
        const events = await expectEventUals(
          `/api/epcis/events?epc=${encodeURIComponent(EPC.frame)}&fullTrace=true&from=2024-03-01T07:00:00Z&to=2024-03-01T09:00:00Z`,
          [getCapturedUal('objectEvent')],
        );
        expect(events.length).toBe(1);
        expect(events[0].type).toBe('ObjectEvent');
      },
      30_000,
    );

    it(
      'bizStep + bizLocation → only event at that step AND location',
      async () => {
        const events = await expectEventUals(
          `/api/epcis/events?MATCH_anyEPC=${encodeURIComponent(EPC.frame)}&bizStep=receiving&bizLocation=${encodeURIComponent(LOCATION.receiving)}`,
          [getCapturedUal('objectEvent')],
        );
        expect(String(events[0].bizStep)).toContain('receiving');
        const loc = events[0].bizLocation as { id: string } | undefined;
        expect(loc?.id).toBe(LOCATION.receiving);
      },
      30_000,
    );

    it(
      'epc + fullTrace=true → finds events where EPC appears in ANY of 5 fields',
      async () => {
        const events = await expectEventUals(
          `/api/epcis/events?epc=${encodeURIComponent(EPC.frame)}&fullTrace=true`,
          [getCapturedUal('objectEvent'), getCapturedUal('transformationEvent')],
        );
        // Frame is in ObjectEvent epcList + TransformationEvent inputEPCList
        expect(events.length).toBe(2);
      },
      30_000,
    );
  });

  // =================================================================
  // Category 14: Concurrent Requests
  // =================================================================

  describe('Category 14: Concurrent Requests', () => {
    beforeAll(async () => {
      await ensureHappyPathCaptures();
    });

    it(
      '5 concurrent captures with different EPCs → all succeed with unique UALs',
      async () => {
        const promises = Array.from({ length: 5 }, (_, i) => {
          const doc = makeValidDoc([makeObjectEvent({ epcList: [makeEpc(`concurrent-${i}`)] })]);
          return authedFetch('POST', '/api/epcis/capture', { epcisDocument: doc });
        });

        const responses = await Promise.all(promises);
        const results = await Promise.all(responses.map((r) => r.json()));

        for (const res of responses) {
          expect(res.status).toBe(200);
        }

        const uals = results.map((r: Record<string, unknown>) => r.ual);
        const uniqueUals = new Set(uals);
        expect(uniqueUals.size).toBe(5);
      },
      180_000,
    );

    it(
      '10 concurrent queries → all return valid JSON',
      async () => {
        const promises = Array.from({ length: 10 }, () =>
          authedFetch('GET', `/api/epcis/events?MATCH_anyEPC=${encodeURIComponent(EPC.frame)}`),
        );

        const responses = await Promise.all(promises);

        for (const res of responses) {
          expect(res.status).toBe(200);
          const data = await res.json();
          const events = extractEventList(data);
          expect(eventUals(events)).toEqual([
            getCapturedUal('objectEvent'),
            getCapturedUal('transformationEvent'),
          ].sort());
        }
      },
      30_000,
    );

    it(
      'mixed capture + query → all requests return 200',
      async () => {
        const captureDoc = makeValidDoc([
          makeObjectEvent({ epcList: [makeEpc('mixed-concurrent')] }),
        ]);
        const promises = [
          authedFetch('POST', '/api/epcis/capture', { epcisDocument: captureDoc }),
          authedFetch('GET', `/api/epcis/events?epc=${encodeURIComponent(EPC.frame)}`),
          authedFetch('GET', `/api/epcis/events?MATCH_anyEPC=${encodeURIComponent(EPC.bicycle)}`),
        ];

        const responses = await Promise.all(promises);

        for (const res of responses) {
          expect(res.status).toBe(200);
        }
      },
      120_000,
    );
  });
});
