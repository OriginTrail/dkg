import { describe, it, expect } from 'vitest';
import { handleCaptureAsync } from '../src/handlers.js';
import { normalizeCaptureEventTypes } from '../src/capture-event-types.js';
import type { AsyncPublisher } from '../src/types.js';
import { VALID_OBJECT_EVENT_DOC, INVALID_DOC, EMPTY_EVENT_LIST_DOC } from './fixtures/bicycle-story.js';

const CONTEXT_GRAPH_ID = 'test-cg';
const NORMALIZED_OBJECT_EVENT_DOC = {
  ...VALID_OBJECT_EVENT_DOC,
  epcisBody: {
    eventList: VALID_OBJECT_EVENT_DOC.epcisBody!.eventList.map((event) => ({
      ...event, '@type': ['https://gs1.github.io/EPCIS/ObjectEvent'],
    })),
  },
};

function trackingAsyncPublisher(): AsyncPublisher & { calls: Array<{ contextGraphId: string; doc: any; options?: any }> } {
  const calls: Array<{ contextGraphId: string; doc: any; options?: any }> = [];
  return {
    calls,
    publishAsync: async (contextGraphId: string, doc: any, options?: any) => {
      calls.push({ contextGraphId, doc, options });
      return { captureID: 'capture-1' };
    },
  };
}

describe('handleCaptureAsync', () => {
  it.each(['ObjectEvent', 'AggregationEvent', 'TransactionEvent', 'TransformationEvent', 'AssociationEvent']
    .flatMap((name) => [name, `https://gs1.github.io/EPCIS/${name}`].map((type) => ({ name, type }))))(
    'normalizes $type while preserving existing explicit types', ({ name, type }) => {
      const document = {
        epcisBody: { eventList: [{ type, '@type': 'urn:example:ExistingType', eventTime: '2024-03-01T08:00:00Z' }] },
      };
      const before = structuredClone(document);
      expect(normalizeCaptureEventTypes(document)).toEqual({
        epcisBody: { eventList: [{ ...document.epcisBody.eventList[0],
          '@type': ['urn:example:ExistingType', `https://gs1.github.io/EPCIS/${name}`],
        }] },
      });
      expect(document).toEqual(before);
    },
  );

  it('preserves explicit extra RDF types when normalizing an envelope fragment', async () => {
    const document = structuredClone(VALID_OBJECT_EVENT_DOC);
    document['@context'] = [document['@context'] as Record<string, unknown>, { type: 'https://example.org/type' }];
    Object.assign(document.epcisBody!.eventList[0]!, {
      '@context': { type: 'https://example.org/eventType' },
      '@type': ['https://example.org/SpecialEvent'],
    });
    const original = structuredClone(document);
    const normalized = normalizeCaptureEventTypes(document);
    expect(normalizeCaptureEventTypes(normalized)).toEqual(normalized);
    expect(normalized).toMatchObject({ epcisBody: { eventList: [{
      '@context': { type: 'https://example.org/eventType' },
      '@type': ['https://example.org/SpecialEvent', 'https://gs1.github.io/EPCIS/ObjectEvent'],
    }] } });
    expect(document).toEqual(original);
  });

  it('preserves extension event types without inventing a standard EPCIS class', async () => {
    const document = structuredClone(VALID_OBJECT_EVENT_DOC);
    document.epcisBody!.eventList[0]!.type = 'https://example.org/Observation';
    const publisher = trackingAsyncPublisher();
    await handleCaptureAsync({ epcisDocument: document }, { contextGraphId: CONTEXT_GRAPH_ID, publisher });
    expect(publisher.calls[0]!.doc).toEqual({ private: document });

  });

  it('preserves a secondary private document fragment without an event list', async () => {
    const privateFragment = {
      '@context': { '@vocab': 'https://gs1.github.io/EPCIS/' },
      epcisBody: { 'https://example.org/privateNote': 'restricted context' },
    };
    const publisher = trackingAsyncPublisher();
    await handleCaptureAsync({ epcisDocument: { public: VALID_OBJECT_EVENT_DOC, private: privateFragment } },
      { contextGraphId: CONTEXT_GRAPH_ID, publisher });
    expect(publisher.calls[0]!.doc).toEqual({ public: NORMALIZED_OBJECT_EVENT_DOC, private: privateFragment });
  });

  it('returns validation errors for an invalid document', async () => {
    const publisher = trackingAsyncPublisher();

    await expect(
      handleCaptureAsync({ epcisDocument: INVALID_DOC }, { contextGraphId: CONTEXT_GRAPH_ID, publisher }),
    ).rejects.toThrow(/validation failed/i);

    expect(publisher.calls).toHaveLength(0);
  });

  it('returns validation error for empty eventList', async () => {
    const publisher = trackingAsyncPublisher();

    await expect(
      handleCaptureAsync({ epcisDocument: EMPTY_EVENT_LIST_DOC }, { contextGraphId: CONTEXT_GRAPH_ID, publisher }),
    ).rejects.toThrow(/validation failed/i);

    expect(publisher.calls).toHaveLength(0);
  });

  it('wraps bare EPCIS documents as private content by default', async () => {
    const publisher = trackingAsyncPublisher();
    const result = await handleCaptureAsync(
      { epcisDocument: VALID_OBJECT_EVENT_DOC },
      { contextGraphId: CONTEXT_GRAPH_ID, publisher },
    );

    expect(result.status).toBe('accepted');
    expect(result.captureID).toBe('capture-1');
    expect(result.eventCount).toBe(1);
    expect(result.receivedAt).toBeDefined();
    expect(publisher.calls).toHaveLength(1);
    expect(publisher.calls[0]?.doc).toEqual({ private: NORMALIZED_OBJECT_EVENT_DOC });
  });

  it('forwards publishOptions when wrapping bare documents as private content', async () => {
    const publisher = trackingAsyncPublisher();
    await handleCaptureAsync(
      {
        epcisDocument: VALID_OBJECT_EVENT_DOC,
        publishOptions: { accessPolicy: 'allowList', allowedPeers: ['peer-a'] },
      },
      { contextGraphId: CONTEXT_GRAPH_ID, publisher },
    );

    expect(publisher.calls).toHaveLength(1);
    expect(publisher.calls[0]?.doc).toEqual({ private: NORMALIZED_OBJECT_EVENT_DOC });
    expect(publisher.calls[0]?.options).toEqual({
      accessPolicy: 'allowList',
      allowedPeers: ['peer-a'],
    });
  });

  it('passes through public and private envelope content', async () => {
    const publisher = trackingAsyncPublisher();
    const privateDoc = {
      '@context': 'https://ref.gs1.org/standards/epcis/epcis-context.jsonld',
      type: 'EPCISDocument',
      schemaVersion: '2.0',
      creationDate: '2024-01-01T00:00:00Z',
    };
    const result = await handleCaptureAsync(
      {
        epcisDocument: {
          public: VALID_OBJECT_EVENT_DOC,
          private: privateDoc,
        },
      },
      { contextGraphId: CONTEXT_GRAPH_ID, publisher },
    );

    expect(result.status).toBe('accepted');
    expect(result.captureID).toBe('capture-1');
    expect(result.eventCount).toBe(1);
    expect(publisher.calls[0]?.doc).toEqual({
      public: NORMALIZED_OBJECT_EVENT_DOC,
      private: privateDoc,
    });
  });

  it('passes through public-only envelope content', async () => {
    const publisher = trackingAsyncPublisher();
    await handleCaptureAsync(
      { epcisDocument: { public: VALID_OBJECT_EVENT_DOC } },
      { contextGraphId: CONTEXT_GRAPH_ID, publisher },
    );

    expect(publisher.calls).toHaveLength(1);
    expect(publisher.calls[0]?.doc).toEqual({ public: NORMALIZED_OBJECT_EVENT_DOC });
  });

  it('passes through private-only envelope content and validates the private document', async () => {
    const publisher = trackingAsyncPublisher();
    await handleCaptureAsync(
      { epcisDocument: { private: VALID_OBJECT_EVENT_DOC } },
      { contextGraphId: CONTEXT_GRAPH_ID, publisher },
    );

    expect(publisher.calls).toHaveLength(1);
    expect(publisher.calls[0]?.doc).toEqual({ private: NORMALIZED_OBJECT_EVENT_DOC });
  });

  it('validates public envelope content when public and private keys are both present', async () => {
    const publisher = trackingAsyncPublisher();

    await expect(
      handleCaptureAsync(
        { epcisDocument: { public: null, private: VALID_OBJECT_EVENT_DOC } },
        { contextGraphId: CONTEXT_GRAPH_ID, publisher },
      ),
    ).rejects.toThrow(/validation failed/i);

    expect(publisher.calls).toHaveLength(0);
  });

  it('rejects envelope-shaped content with neither public nor private payload', async () => {
    const publisher = trackingAsyncPublisher();

    await expect(
      handleCaptureAsync(
        { epcisDocument: { type: 'NotEPCISDocument', schemaVersion: '2.0' } },
        { contextGraphId: CONTEXT_GRAPH_ID, publisher },
      ),
    ).rejects.toThrow(/privacy envelope/i);

    expect(publisher.calls).toHaveLength(0);
  });

  it('uses config.contextGraphId when request omits one (back-compat)', async () => {
    const publisher = trackingAsyncPublisher();
    await handleCaptureAsync(
      { epcisDocument: VALID_OBJECT_EVENT_DOC },
      { contextGraphId: CONTEXT_GRAPH_ID, publisher },
    );

    expect(publisher.calls).toHaveLength(1);
    expect(publisher.calls[0]?.contextGraphId).toBe(CONTEXT_GRAPH_ID);
  });

  it('per-request contextGraphId overrides the config fallback', async () => {
    const publisher = trackingAsyncPublisher();
    await handleCaptureAsync(
      { epcisDocument: VALID_OBJECT_EVENT_DOC, contextGraphId: 'override-cg' },
      { contextGraphId: CONTEXT_GRAPH_ID, publisher },
    );

    expect(publisher.calls).toHaveLength(1);
    expect(publisher.calls[0]?.contextGraphId).toBe('override-cg');
  });

  it('threads subGraphName into the publisher opts', async () => {
    const publisher = trackingAsyncPublisher();
    await handleCaptureAsync(
      { epcisDocument: VALID_OBJECT_EVENT_DOC, subGraphName: 'research' },
      { contextGraphId: CONTEXT_GRAPH_ID, publisher },
    );

    expect(publisher.calls).toHaveLength(1);
    expect(publisher.calls[0]?.options).toEqual({ subGraphName: 'research' });
  });

  it('threads subGraphName alongside publishOptions', async () => {
    const publisher = trackingAsyncPublisher();
    await handleCaptureAsync(
      {
        epcisDocument: VALID_OBJECT_EVENT_DOC,
        subGraphName: 'research',
        publishOptions: { accessPolicy: 'allowList', allowedPeers: ['peer-a'] },
      },
      { contextGraphId: CONTEXT_GRAPH_ID, publisher },
    );

    expect(publisher.calls).toHaveLength(1);
    expect(publisher.calls[0]?.options).toEqual({
      accessPolicy: 'allowList',
      allowedPeers: ['peer-a'],
      subGraphName: 'research',
    });
  });
});
