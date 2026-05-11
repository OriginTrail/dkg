import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { ApiClient } from '../src/api-client.js';

const PORT = 8901;

interface FetchCall {
  url: string;
  opts: RequestInit;
}

function trackingFetch(response: {
  ok: boolean;
  status: number;
  statusText?: string;
  body: unknown;
  headers?: Record<string, string>;
}): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const headers = new Headers(response.headers ?? {});
  const fn = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), opts: init as RequestInit });
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText ?? (response.ok ? 'OK' : `HTTP ${response.status}`),
      json: () => Promise.resolve(response.body),
      text: () => Promise.resolve(JSON.stringify(response.body)),
      headers,
    } as unknown as Response;
  };
  return { fetch: fn as typeof globalThis.fetch, calls };
}

describe('ApiClient EPCIS methods', () => {
  let client: ApiClient;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    client = new ApiClient(PORT, 'test-token');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('captureEpcis', () => {
    it('POSTs to /api/epcis/capture with full body', async () => {
      const responseBody = { captureID: 'cap-1', receivedAt: '2026-05-05T00:00:00Z', eventCount: 1, status: 'accepted' };
      const { fetch, calls } = trackingFetch({ ok: true, status: 202, body: responseBody });
      globalThis.fetch = fetch;

      const result = await client.captureEpcis({
        contextGraphId: 'cg-1',
        subGraphName: 'research',
        epcisDocument: { type: 'EPCISDocument' },
        publishOptions: { accessPolicy: 'allowList', allowedPeers: ['peer-A', 'peer-B'] },
      });

      expect(result).toEqual(responseBody);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(`http://127.0.0.1:${PORT}/api/epcis/capture`);
      expect(calls[0].opts.method).toBe('POST');
      const body = JSON.parse(calls[0].opts.body as string);
      expect(body).toEqual({
        contextGraphId: 'cg-1',
        subGraphName: 'research',
        epcisDocument: { type: 'EPCISDocument' },
        publishOptions: { accessPolicy: 'allowList', allowedPeers: ['peer-A', 'peer-B'] },
      });
    });

    it('preserves Bearer auth header on capture', async () => {
      const { fetch, calls } = trackingFetch({ ok: true, status: 202, body: {} });
      globalThis.fetch = fetch;
      await client.captureEpcis({ epcisDocument: {} });
      expect((calls[0].opts.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
    });

    it('throws ApiClient.httpError with httpStatus + responseBody on 503', async () => {
      const { fetch } = trackingFetch({ ok: false, status: 503, body: { error: 'PublisherDisabled', message: 'no publisher' } });
      globalThis.fetch = fetch;
      let thrown: any;
      try {
        await client.captureEpcis({ epcisDocument: {} });
      } catch (err) {
        thrown = err;
      }
      expect(thrown.httpStatus).toBe(503);
      expect(thrown.responseBody).toEqual({ error: 'PublisherDisabled', message: 'no publisher' });
      expect(thrown.message).toBe('PublisherDisabled');
    });

    it('throws with httpStatus 400 on validation failure', async () => {
      const { fetch } = trackingFetch({ ok: false, status: 400, body: { error: 'InvalidContent', message: 'Invalid contextGraphId' } });
      globalThis.fetch = fetch;
      let thrown: any;
      try {
        await client.captureEpcis({ epcisDocument: {} });
      } catch (err) {
        thrown = err;
      }
      expect(thrown.httpStatus).toBe(400);
      expect(thrown.message).toBe('InvalidContent');
    });
  });

  describe('getEpcisCapture', () => {
    it('GETs /api/epcis/capture/:id with URL-encoded captureID', async () => {
      const responseBody = {
        captureID: 'cap with spaces',
        state: 'finalized',
        receivedAt: '2026-05-05T00:00:00Z',
        finalizedAt: '2026-05-05T00:00:30Z',
        error: null,
      };
      const { fetch, calls } = trackingFetch({ ok: true, status: 200, body: responseBody });
      globalThis.fetch = fetch;
      const result = await client.getEpcisCapture('cap with spaces');
      expect(result).toEqual(responseBody);
      expect(calls[0].url).toBe(`http://127.0.0.1:${PORT}/api/epcis/capture/cap%20with%20spaces`);
    });

    it('throws with httpStatus 404 on unknown capture', async () => {
      const { fetch } = trackingFetch({ ok: false, status: 404, body: { error: 'CaptureNotFound' } });
      globalThis.fetch = fetch;
      let thrown: any;
      try {
        await client.getEpcisCapture('nope');
      } catch (err) {
        thrown = err;
      }
      expect(thrown.httpStatus).toBe(404);
    });
  });

  describe('queryEpcisEvents', () => {
    it('builds query string from filter params and threads them through', async () => {
      const responseBody = {
        '@context': [],
        type: 'EPCISQueryDocument',
        schemaVersion: '2.0',
        epcisBody: { queryResults: { queryName: 'SimpleEventQuery', resultsBody: { eventList: [] } } },
      };
      const { fetch, calls } = trackingFetch({ ok: true, status: 200, body: responseBody });
      globalThis.fetch = fetch;

      const result = await client.queryEpcisEvents({
        contextGraphId: 'cg-1',
        subGraphName: 'research',
        finalized: false,
        epc: 'urn:epc:id:sgtin:1.2.3',
        bizStep: 'https://ref.gs1.org/cbv/BizStep-receiving',
        from: '2026-05-01T00:00:00Z',
        to: '2026-05-31T00:00:00Z',
        eventType: 'ObjectEvent',
        action: 'ADD',
        perPage: 50,
        nextPageToken: 'b2Zmc2V0OjUw',
      });

      expect(result.body).toEqual(responseBody);
      expect(result.nextPageUrl).toBeNull();

      const url = new URL(calls[0].url);
      expect(url.pathname).toBe('/api/epcis/events');
      const params = url.searchParams;
      expect(params.get('contextGraphId')).toBe('cg-1');
      expect(params.get('subGraphName')).toBe('research');
      expect(params.get('finalized')).toBe('false');
      expect(params.get('epc')).toBe('urn:epc:id:sgtin:1.2.3');
      expect(params.get('bizStep')).toBe('https://ref.gs1.org/cbv/BizStep-receiving');
      expect(params.get('eventType')).toBe('ObjectEvent');
      expect(params.get('action')).toBe('ADD');
      expect(params.get('perPage')).toBe('50');
      expect(params.get('nextPageToken')).toBe('b2Zmc2V0OjUw');
    });

    it('omits undefined params from the URL', async () => {
      const { fetch, calls } = trackingFetch({ ok: true, status: 200, body: {} });
      globalThis.fetch = fetch;
      await client.queryEpcisEvents({ contextGraphId: 'cg-1' });
      const url = new URL(calls[0].url);
      expect(url.searchParams.has('subGraphName')).toBe(false);
      expect(url.searchParams.has('finalized')).toBe(false);
      expect(url.searchParams.has('perPage')).toBe(false);
      expect(url.searchParams.get('contextGraphId')).toBe('cg-1');
    });

    it('parses Link: rel="next" into nextPageUrl (relative path form)', async () => {
      const linkValue = '</api/epcis/events?contextGraphId=cg-1&perPage=10&nextPageToken=b2Zmc2V0OjEw>; rel="next"';
      const { fetch } = trackingFetch({
        ok: true,
        status: 200,
        body: {},
        headers: { Link: linkValue },
      });
      globalThis.fetch = fetch;
      const result = await client.queryEpcisEvents({ contextGraphId: 'cg-1', perPage: 10 });
      expect(result.nextPageUrl).toBe(
        '/api/epcis/events?contextGraphId=cg-1&perPage=10&nextPageToken=b2Zmc2V0OjEw',
      );
    });

    it('parses Link: rel="next" with multiple rels and extracts next', async () => {
      const linkValue =
        '</api/epcis/events?prev=1>; rel="prev", </api/epcis/events?next=1>; rel="next"';
      const { fetch } = trackingFetch({
        ok: true,
        status: 200,
        body: {},
        headers: { Link: linkValue },
      });
      globalThis.fetch = fetch;
      const result = await client.queryEpcisEvents({});
      expect(result.nextPageUrl).toBe('/api/epcis/events?next=1');
    });

    it('handles absolute Link URLs by extracting path+query', async () => {
      const linkValue =
        '<http://daemon.example/api/epcis/events?p=1>; rel="next"';
      const { fetch } = trackingFetch({
        ok: true,
        status: 200,
        body: {},
        headers: { Link: linkValue },
      });
      globalThis.fetch = fetch;
      const result = await client.queryEpcisEvents({});
      expect(result.nextPageUrl).toBe('/api/epcis/events?p=1');
    });

    it('returns nextPageUrl: null when Link header is absent', async () => {
      const { fetch } = trackingFetch({ ok: true, status: 200, body: {} });
      globalThis.fetch = fetch;
      const result = await client.queryEpcisEvents({});
      expect(result.nextPageUrl).toBeNull();
    });

    it('queryEpcisEventsByPath re-issues the exact path verbatim', async () => {
      const { fetch, calls } = trackingFetch({ ok: true, status: 200, body: {} });
      globalThis.fetch = fetch;
      const path = '/api/epcis/events?contextGraphId=cg-1&perPage=10&nextPageToken=b2Zmc2V0OjEw';
      await client.queryEpcisEventsByPath(path);
      expect(calls[0].url).toBe(`http://127.0.0.1:${PORT}${path}`);
    });
  });
});
