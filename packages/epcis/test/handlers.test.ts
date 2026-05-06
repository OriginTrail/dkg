import { describe, it, expect } from 'vitest';
import { handleCapture, handleCaptureAsync } from '../src/handlers.js';
import type { AsyncPublisher, Publisher } from '../src/types.js';
import { VALID_OBJECT_EVENT_DOC, INVALID_DOC, EMPTY_EVENT_LIST_DOC } from './fixtures/bicycle-story.js';

const CONTEXT_GRAPH_ID = 'test-paranet';

function trackingPublisher(overrides?: Partial<Publisher>): Publisher & { calls: Array<{ contextGraphId: string; doc: any; options?: any }> } {
  const calls: Array<{ contextGraphId: string; doc: any; options?: any }> = [];
  return {
    calls,
    publish: overrides?.publish ?? (async (contextGraphId: string, doc: any, options?: any) => {
      calls.push({ contextGraphId, doc, options });
      return { ual: 'did:dkg:test:ual1', kcId: '42', status: 'confirmed' };
    }),
  };
}

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

describe('handleCapture', () => {
  it('validates, publishes, and returns result on success', async () => {
    const publisher = trackingPublisher();
    const result = await handleCapture(
      { epcisDocument: VALID_OBJECT_EVENT_DOC },
      { contextGraphId: CONTEXT_GRAPH_ID, publisher },
    );

    expect(result.status).toBe('confirmed');
    expect(result.ual).toBe('did:dkg:test:ual1');
    expect(result.kcId).toBe('42');
    expect(result.eventCount).toBe(1);
    expect(result.receivedAt).toBeDefined();
    expect(publisher.calls).toHaveLength(1);
  });

  it('returns validation errors for an invalid document', async () => {
    const publisher = trackingPublisher();

    await expect(
      handleCapture({ epcisDocument: INVALID_DOC }, { contextGraphId: CONTEXT_GRAPH_ID, publisher }),
    ).rejects.toThrow(/validation failed/i);

    expect(publisher.calls).toHaveLength(0);
  });

  it('returns validation error for empty eventList', async () => {
    const publisher = trackingPublisher();

    await expect(
      handleCapture({ epcisDocument: EMPTY_EVENT_LIST_DOC }, { contextGraphId: CONTEXT_GRAPH_ID, publisher }),
    ).rejects.toThrow(/validation failed/i);

    expect(publisher.calls).toHaveLength(0);
  });

  it('propagates publish errors', async () => {
    const publisher = trackingPublisher({
      publish: async () => { throw new Error('chain unavailable'); },
    });

    await expect(
      handleCapture({ epcisDocument: VALID_OBJECT_EVENT_DOC }, { contextGraphId: CONTEXT_GRAPH_ID, publisher }),
    ).rejects.toThrow('chain unavailable');
  });

  it('forwards accessPolicy to publisher', async () => {
    const publisher = trackingPublisher();
    await handleCapture(
      { epcisDocument: VALID_OBJECT_EVENT_DOC, publishOptions: { accessPolicy: 'ownerOnly' } },
      { contextGraphId: CONTEXT_GRAPH_ID, publisher },
    );

    expect(publisher.calls).toHaveLength(1);
    expect(publisher.calls[0]?.options?.accessPolicy).toBe('ownerOnly');
  });

  it('wraps bare async EPCIS documents as explicit public content', async () => {
    const publisher = trackingAsyncPublisher();
    await handleCaptureAsync(
      { epcisDocument: VALID_OBJECT_EVENT_DOC },
      { contextGraphId: CONTEXT_GRAPH_ID, publisher },
    );

    expect(publisher.calls).toHaveLength(1);
    expect(publisher.calls[0]?.doc).toEqual({ public: VALID_OBJECT_EVENT_DOC });
  });

  it('accepts async privacy envelope capture and returns captureID', async () => {
    const publisher = trackingAsyncPublisher();
    const result = await handleCaptureAsync(
      {
        epcisDocument: {
          public: VALID_OBJECT_EVENT_DOC,
          private: {
            '@context': 'https://ref.gs1.org/standards/epcis/epcis-context.jsonld',
            type: 'EPCISDocument',
            schemaVersion: '2.0',
            creationDate: '2024-01-01T00:00:00Z',
          },
        },
        publishOptions: { accessPolicy: 'allowList', allowedPeers: ['peer-a'] },
      },
      { contextGraphId: CONTEXT_GRAPH_ID, publisher },
    );

    expect(result.status).toBe('accepted');
    expect(result.captureID).toBe('capture-1');
    expect(result.eventCount).toBe(1);
    expect(publisher.calls[0]?.doc).toEqual({
      public: VALID_OBJECT_EVENT_DOC,
      private: {
        '@context': 'https://ref.gs1.org/standards/epcis/epcis-context.jsonld',
        type: 'EPCISDocument',
        schemaVersion: '2.0',
        creationDate: '2024-01-01T00:00:00Z',
      },
    });
    expect(publisher.calls[0]?.options?.allowedPeers).toEqual(['peer-a']);
  });
});
