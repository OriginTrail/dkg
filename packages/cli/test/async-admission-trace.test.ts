import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it } from 'vitest';
import { asyncAdmissionUsage } from '@origintrail-official/dkg-core';
import {
  admissionStep,
  beginAsyncAdmissionTrace,
  matchAsyncAdmissionRoute,
  noteAdmissionResponse,
} from '../src/daemon/async-admission-trace.js';

const SHARE = '/api/knowledge-assets/albums/swm/share-async';
const PUBLISH = '/api/knowledge-assets/albums/vm/publish-async';

class FakeResponse extends EventEmitter {
  headersSent = false;
  statusCode = 200;
  close(): void {
    this.emit('close');
  }
}

function fakeResponse(): FakeResponse & ServerResponse {
  return new FakeResponse() as FakeResponse & ServerResponse;
}

function manualClock(start = 0) {
  let now = start;
  return { clock: () => now, advance: (ms: number) => { now += ms; } };
}

/** The cumulative outcomes recorded so far. */
function outcomes() {
  return asyncAdmissionUsage.take().http.map((e) => `${e.route}/${e.phase}/${e.status}/${e.code}:${e.count}`);
}

describe('matchAsyncAdmissionRoute', () => {
  it.each([
    ['POST', SHARE, 'share_async'],
    ['POST', PUBLISH, 'publish_async'],
    ['POST', '/api/knowledge-assets/albums/swm/share-async/', 'share_async'], // trailing slash
    ['POST', '/api/knowledge-assets//albums//vm//publish-async', 'publish_async'], // empty segments
    ['POST', '/api/knowledge-assets/my%20albums/vm/publish-async', 'publish_async'], // encoded name
    ['POST', '/api/knowledge-assets/albums/vm/publish-async/extra/segments', 'publish_async'], // the route ignores extras
  ] as const)('matches %s %s', (method, pathname, route) => {
    expect(matchAsyncAdmissionRoute(method, pathname)).toBe(route);
  });

  it.each([
    ['GET', SHARE],
    ['PUT', PUBLISH],
    ['DELETE', PUBLISH],
    [undefined, PUBLISH],
    ['POST', '/api/knowledge-assets'],
    ['POST', '/api/knowledge-assets/'],
    ['POST', '/api/knowledge-assets/albums/swm/share'], // the synchronous verbs
    ['POST', '/api/knowledge-assets/albums/vm/publish'],
    ['POST', '/api/knowledge-assets/albums/wm/share-async'], // a verb on the wrong layer
    ['POST', '/api/knowledge-assets/albums/swm/publish-async'],
    ['POST', '/api/knowledge-assets/albums/vm/share-async'],
    ['POST', '/api/knowledge-assets/swm/share-async'], // a name is required
    ['POST', '/api/knowledge-assets/albums/vm/publish-async-extra'],
    ['POST', '/api/knowledge-assetsX/albums/vm/publish-async'],
    ['POST', '/api/assertion/albums/promote-async'],
    ['POST', '/api/knowledge-assets/%E0%A4%A/vm/publish-async'], // malformed percent-encoding
  ] as const)('does not match %s %s', (method, pathname) => {
    expect(matchAsyncAdmissionRoute(method, pathname)).toBeNull();
  });
});

describe('async admission trace', () => {
  beforeEach(() => {
    asyncAdmissionUsage.reset();
  });

  it('records one outcome when a traced response closes, with the latency to the answer', () => {
    const { clock, advance } = manualClock(1_000);
    const res = fakeResponse();
    beginAsyncAdmissionTrace('POST', PUBLISH, res, clock);
    advance(250);
    noteAdmissionResponse(res, 202, JSON.stringify({ jobId: 'j1' }));
    advance(5_000); // the client takes a while to drain the body: not part of the latency
    res.close();

    const snapshot = asyncAdmissionUsage.take();
    expect(snapshot.http).toEqual([
      { route: 'publish_async', phase: 'enqueue', status: 202, code: '-', count: 1 },
    ]);
    expect(snapshot.httpLatency.publish_async.n).toBe(1);
    expect(snapshot.httpLatency.publish_async.maxMs).toBe(250);
  });

  it('labels the latency per route', () => {
    const { clock, advance } = manualClock();
    const share = fakeResponse();
    beginAsyncAdmissionTrace('POST', SHARE, share, clock);
    advance(120);
    noteAdmissionResponse(share, 200, '{}');
    share.close();

    const snapshot = asyncAdmissionUsage.take();
    expect(snapshot.httpLatency.share_async.n).toBe(1);
    expect(snapshot.httpLatency.share_async.maxMs).toBe(120);
    expect(snapshot.httpLatency.publish_async.n).toBe(0);
  });

  it('ignores requests that are not async admission', () => {
    const res = fakeResponse();
    beginAsyncAdmissionTrace('GET', SHARE, res);
    beginAsyncAdmissionTrace('POST', '/api/status', res);
    noteAdmissionResponse(res, 500, '{}');
    res.close();
    expect(res.listenerCount('close')).toBe(0);
    expect(outcomes()).toEqual([]);
  });

  it('runs a step of an untraced request unchanged', async () => {
    const res = fakeResponse();
    await expect(admissionStep(res, 'write_preflight', async () => 'ok')).resolves.toBe('ok');
    const failure = new Error('boom');
    await expect(admissionStep(res, 'enqueue', async () => { throw failure; })).rejects.toBe(failure);
  });

  it('attributes an answer to the step that gave it, and hands the request back after a step that finishes', async () => {
    const res = fakeResponse();
    beginAsyncAdmissionTrace('POST', PUBLISH, res);
    // The step answers itself (a 404 for an unknown graph) and returns normally.
    await admissionStep(res, 'write_preflight', async () => {
      noteAdmissionResponse(res, 404, JSON.stringify({ code: 'context_graph_not_found' }));
      return null;
    });
    // A later answer in the same request does not replace the first.
    noteAdmissionResponse(res, 500, JSON.stringify({ code: 'ignored' }));
    res.close();

    expect(outcomes()).toEqual(['publish_async/write_preflight/404/context_graph_not_found:1']);
  });

  it('puts a request that finished a step back in the phase it was in before', async () => {
    const res = fakeResponse();
    beginAsyncAdmissionTrace('POST', PUBLISH, res);
    await admissionStep(res, 'write_preflight', async () => 'ok');
    await admissionStep(res, 'intent_resolution', async () => 'ok');
    noteAdmissionResponse(res, 400, JSON.stringify({ error: 'bad option' }));
    res.close();

    expect(outcomes()).toEqual(['publish_async/request/400/-:1']);
  });

  it('keeps the phase of a step that threw, so the error is answered inside it', async () => {
    const res = fakeResponse();
    beginAsyncAdmissionTrace('POST', PUBLISH, res);
    await expect(admissionStep(res, 'snapshot_preflight', async () => {
      throw new Error('store busy');
    })).rejects.toThrow('store busy');
    noteAdmissionResponse(res, 503, JSON.stringify({ code: 'STORE_SCHEDULER_BUSY', error: 'busy' }));
    res.close();

    expect(outcomes()).toEqual(['publish_async/snapshot_preflight/503/STORE_SCHEDULER_BUSY:1']);
  });

  it('labels every 2xx answer enqueue, whatever step is current', async () => {
    const res = fakeResponse();
    beginAsyncAdmissionTrace('POST', SHARE, res);
    await expect(admissionStep(res, 'write_preflight', async () => {
      noteAdmissionResponse(res, 200, JSON.stringify({ jobId: 'j' }));
    })).resolves.toBeUndefined();
    res.close();

    expect(outcomes()).toEqual(['share_async/enqueue/200/-:1']);
  });

  it('records a request the client left before any answer as status 0 in the step it was in', async () => {
    const { clock, advance } = manualClock();
    const res = fakeResponse();
    beginAsyncAdmissionTrace('POST', PUBLISH, res, clock);
    const step = admissionStep(res, 'write_preflight', () => new Promise<void>(() => {}));
    void step;
    advance(20_000);
    res.close();

    const snapshot = asyncAdmissionUsage.take();
    expect(snapshot.http).toEqual([
      { route: 'publish_async', phase: 'write_preflight', status: 0, code: 'client_closed', count: 1 },
    ]);
    expect(snapshot.httpLatency.publish_async.maxMs).toBe(20_000);
  });

  it('records an answer sent outside the JSON helper (rate limiting, load shedding) from the status at close', () => {
    const { clock, advance } = manualClock();
    const res = fakeResponse();
    beginAsyncAdmissionTrace('POST', SHARE, res, clock);
    advance(3);
    res.headersSent = true;
    res.statusCode = 429;
    res.close();

    expect(outcomes()).toEqual(['share_async/request/429/-:1']);
  });

  it('labels an unannounced 2xx enqueue', () => {
    const res = fakeResponse();
    beginAsyncAdmissionTrace('POST', SHARE, res);
    res.headersSent = true;
    res.statusCode = 200;
    res.close();
    expect(outcomes()).toEqual(['share_async/enqueue/200/-:1']);
  });

  describe('error code', () => {
    function codeOf(body: string, status = 503): string {
      asyncAdmissionUsage.reset();
      const res = fakeResponse();
      beginAsyncAdmissionTrace('POST', PUBLISH, res);
      noteAdmissionResponse(res, status, body);
      res.close();
      return asyncAdmissionUsage.take().http[0]!.code;
    }

    it('is the code of the error body', () => {
      expect(codeOf(JSON.stringify({ code: 'async_publisher_unavailable', error: 'x' }))).toBe('async_publisher_unavailable');
    });

    it.each([
      ['a body without a code', JSON.stringify({ error: 'x' })],
      ['a body that is not JSON', 'Service Unavailable'],
      ['a null body', 'null'],
      ['a numeric code', JSON.stringify({ code: 503 })],
      ['a code with a space', JSON.stringify({ code: 'not a code' })],
      ['a code that is too long', JSON.stringify({ code: 'x'.repeat(49) })],
      ['a body over 16 KiB', JSON.stringify({ code: 'late', pad: 'x'.repeat(17 * 1024) })],
    ])('is "-" for %s', (_label, body) => {
      expect(codeOf(body)).toBe('-');
    });

    it('is "-" for a success body, which is not parsed', () => {
      expect(codeOf(JSON.stringify({ code: 'accepted' }), 202)).toBe('-');
    });
  });

  it('records exactly once however often the response closes', () => {
    const res = fakeResponse();
    beginAsyncAdmissionTrace('POST', SHARE, res);
    noteAdmissionResponse(res, 200, '{}');
    res.close();
    res.close();
    noteAdmissionResponse(res, 500, '{}'); // after the close: no trace is left to note
    expect(outcomes()).toEqual(['share_async/enqueue/200/-:1']);
  });
});
