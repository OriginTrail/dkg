import { describe, it, expect } from 'vitest';
import { handleCaptureAsync } from '../src/handlers.js';
import type { AsyncPublisher } from '../src/types.js';
import { VALID_OBJECT_EVENT_DOC, INVALID_DOC, EMPTY_EVENT_LIST_DOC } from './fixtures/bicycle-story.js';

const CONTEXT_GRAPH_ID = 'test-cg';

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
    expect(publisher.calls[0]?.doc).toEqual({ private: VALID_OBJECT_EVENT_DOC });
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
    expect(publisher.calls[0]?.doc).toEqual({ private: VALID_OBJECT_EVENT_DOC });
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
      public: VALID_OBJECT_EVENT_DOC,
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
    expect(publisher.calls[0]?.doc).toEqual({ public: VALID_OBJECT_EVENT_DOC });
  });

  it('passes through private-only envelope content and validates the private document', async () => {
    const publisher = trackingAsyncPublisher();
    await handleCaptureAsync(
      { epcisDocument: { private: VALID_OBJECT_EVENT_DOC } },
      { contextGraphId: CONTEXT_GRAPH_ID, publisher },
    );

    expect(publisher.calls).toHaveLength(1);
    expect(publisher.calls[0]?.doc).toEqual({ private: VALID_OBJECT_EVENT_DOC });
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
