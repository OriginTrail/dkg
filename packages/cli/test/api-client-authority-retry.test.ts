import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, DaemonOutcomeUnknownError } from '../src/api-client.js';

const READ_ANSWER = { error: 'temporarily unavailable', code: 'CONTEXT_GRAPH_READ_AUTHORITY_UNAVAILABLE', retryable: true };
const PUBLISH_ANSWER = { error: 'authority changed', code: 'CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE', retryable: true };
const OK = { result: { type: 'bindings', bindings: [] } };

interface Scripted { status: number; body: unknown; retryAfter?: string }
const unavailable = (retryAfter?: string, body: unknown = READ_ANSWER): Scripted => ({ status: 503, body, retryAfter });
const served: Scripted = { status: 200, body: OK };

describe('ApiClient: the retryable authority 503', () => {
  const originalFetch = globalThis.fetch;
  const client = new ApiClient(9200, 'token');

  /** Answer each request with the next of `answers` (the last repeats); note what came when. */
  function script(answers: Scripted[]) {
    const started = Date.now();
    const requests: Array<{ path: string; at: number; body: unknown; signal?: AbortSignal | null }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const answer = answers[Math.min(requests.length, answers.length - 1)]!;
      requests.push({ path: new URL(String(url)).pathname, at: Date.now() - started, body: init?.body, signal: init?.signal });
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: answer.retryAfter === undefined ? {} : { 'Retry-After': answer.retryAfter },
      });
    }) as typeof fetch;
    return requests;
  }

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  it('sends a query again no sooner than Retry-After asks, and returns what it then gets', async () => {
    const requests = script([unavailable('3'), unavailable('3'), served]);

    const answer = client.query('SELECT * WHERE { ?s ?p ?o }', 'graph');
    await vi.advanceTimersByTimeAsync(2_999);
    expect(requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3_001);

    await expect(answer).resolves.toEqual(OK);
    expect(requests.map(request => request.at)).toEqual([0, 3_000, 6_000]);
    expect(new Set(requests.map(request => request.body)).size).toBe(1);
  });

  it('backs off on its own when the answer carries no Retry-After, and does the same for a GET', async () => {
    const requests = script([unavailable(), unavailable(), served]);

    const answer = client.queryAssertion('asset', { contextGraphId: 'graph' });
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(answer).resolves.toEqual(OK);
    expect(requests.map(request => request.at)).toEqual([0, 1_000, 3_000]);
  });

  it('stops at its bound and reports the last answer as it came', async () => {
    const requests = script([unavailable('1')]);

    const answer = client.query('SELECT * WHERE { ?s ?p ?o }', 'graph');
    const refused = expect(answer).rejects.toMatchObject({
      httpStatus: 503, responseBody: READ_ANSWER, message: READ_ANSWER.error,
    });
    await vi.advanceTimersByTimeAsync(60_000);

    await refused;
    expect(requests.map(request => request.at)).toEqual([0, 1_000, 3_000, 7_000, 15_000]);
  });

  it('does not wait out a Retry-After longer than its bound', async () => {
    const requests = script([unavailable('120'), served]);

    await expect(client.query('SELECT * WHERE { ?s ?p ?o }', 'graph')).rejects.toMatchObject({ httpStatus: 503 });
    expect(requests).toHaveLength(1);
  });

  it('does not wait past the request deadline: the answer it holds is reported instead', async () => {
    const short = new ApiClient(9200, 'token', { readTimeoutMs: 3_500 });
    const requests = script([unavailable('3')]);

    await expect(short.queryAssertion('asset', { contextGraphId: 'graph' })).rejects.toMatchObject({ httpStatus: 503 });
    expect(requests).toHaveLength(1);
  });

  it('runs every attempt under the one deadline of the request', async () => {
    const requests = script([unavailable(), served]);

    const answer = client.query('SELECT * WHERE { ?s ?p ?o }', 'graph');
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(answer).resolves.toEqual(OK);
    expect(requests[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(requests[1]!.signal).toBe(requests[0]!.signal);
  });

  it.each([
    ['a busy store', { status: 503, body: { error: 'busy', code: 'STORE_SCHEDULER_BUSY', retryable: true }, retryAfter: '1' }],
    ['the code without the retryable mark', { status: 503, body: { error: 'x', code: READ_ANSWER.code }, retryAfter: '1' }],
    ['the same body under another status', { status: 500, body: READ_ANSWER }],
    ['a refusal', { status: 403, body: { error: 'Not authorized' } }],
    ['a 503 that is not JSON', { status: 503, body: 'Service Unavailable' }],
  ] as Array<[string, Scripted]>)('does not repeat %s', async (_label, answer) => {
    const requests = script([answer, served]);

    await expect(client.query('SELECT * WHERE { ?s ?p ?o }', 'graph')).rejects.toMatchObject({ httpStatus: answer.status });
    expect(requests).toHaveLength(1);
  });

  it('repeats a subscribe, whose own authority check answers under the other code', async () => {
    const requests = script([unavailable('3', PUBLISH_ANSWER), { status: 200, body: { subscribed: 'graph' } }]);

    const answer = client.subscribeToContextGraph('graph');
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(answer).resolves.toEqual({ subscribed: 'graph' });
    expect(requests).toHaveLength(2);
  });

  it('repeats a synchronous publish on the answer of its own authority check, after its Retry-After', async () => {
    const published = { kaId: '1', status: 'confirmed' };
    const requests = script([unavailable('1', PUBLISH_ANSWER), { status: 200, body: published }]);

    const answer = client.knowledgeAssetPublish('graph', 'asset');
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(answer).resolves.toEqual(published);
    expect(requests.map(request => request.path)).toEqual([
      '/api/knowledge-assets/asset/vm/publish', '/api/knowledge-assets/asset/vm/publish',
    ]);
    expect(requests.map(request => request.at)).toEqual([0, 1_000]);
  });

  it('does not repeat a synchronous publish on a read failure rethrown from within the request', async () => {
    const requests = script([unavailable('3'), served]);

    await expect(client.knowledgeAssetPublish('graph', 'asset')).rejects.toMatchObject({
      httpStatus: 503, responseBody: READ_ANSWER,
    });
    expect(requests).toHaveLength(1);
  });

  it('does not repeat a write that names no repeat, on either code', async () => {
    for (const body of [READ_ANSWER, PUBLISH_ANSWER]) {
      const requests = script([unavailable('1', body), served]);

      await expect(client.knowledgeAssetShare('graph', 'asset'))
        .rejects.toMatchObject({ httpStatus: 503, responseBody: body });
      expect(requests).toHaveLength(1);
    }
  });

  it('keeps the outcome-unknown report of a publish whose repeat goes unanswered', async () => {
    const short = new ApiClient(9200, 'token', { longTimeoutMs: 2_500, readTimeoutMs: 100 });
    let asked = 0;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      asked += 1;
      if (asked === 1) return new Response(JSON.stringify(PUBLISH_ANSWER), { status: 503 });
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    }) as typeof fetch;
    vi.useRealTimers();

    await expect(short.knowledgeAssetPublish('graph', 'asset')).rejects.toBeInstanceOf(DaemonOutcomeUnknownError);
    expect(asked).toBe(2);
  });
});
