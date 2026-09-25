import { vi } from 'vitest';

/**
 * A stand-in for the node's event stream (`GET /api/events`) in dashboard
 * tests.
 *
 * `stubNodeEventStream()` replaces the global `fetch`. A request whose path is
 * `/api/events` (whatever its query string) is recorded and answered with a
 * stream the test writes to. Every other request goes to `fallback`, which
 * defaults to the `fetch` in place before the stub. Restore it with
 * `vi.unstubAllGlobals()`.
 */

const EVENTS_PATH = '/api/events';

// Taken before any test fakes timers: settling needs a real macrotask.
const realSetTimeout = globalThis.setTimeout.bind(globalThis);

/** Resolve after the page has handled everything the stream delivered so far. */
function settle(): Promise<void> {
  return new Promise((resolve) => { realSetTimeout(resolve, 0); });
}

/** The `fetch` that answers every request other than the event stream. */
export type FetchFallback = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface EventStreamRequest {
  /** The URL exactly as the page passed it to `fetch`. */
  url: string;
  /** The request headers, with lower-case names. */
  headers: Record<string, string>;
  /** The request's cache mode. */
  cache: RequestCache | undefined;
}

export interface EventStreamConnection {
  readonly request: EventStreamRequest;
  /** True once the page has aborted the request. */
  readonly aborted: boolean;
  /** Write raw text to the response, then let the page handle it. */
  write(text: string): Promise<void>;
  /** Write one named event in the daemon's format, then let the page handle it. */
  emit(type: string, data: unknown): Promise<void>;
  /** End the response, as the daemon does when it closes the stream. */
  end(): Promise<void>;
  /** Fail the response mid-stream, as when the connection drops. */
  fail(): Promise<void>;
}

export interface FakeNodeEventStream {
  /** Every request for the stream, oldest first, including refused ones. */
  readonly requests: EventStreamRequest[];
  /** The streams handed to the page, oldest first. */
  readonly connections: EventStreamConnection[];
  /** The most recent stream. Throws when the page has not opened one. */
  latest(): EventStreamConnection;
  /** Answer the next request with `response` instead of a stream. */
  respondNextWith(response: Response): void;
  /** Reject the next request, as `fetch` does on a network error. */
  failNext(): void;
  /** Resolve after the page has handled everything delivered so far. */
  settle(): Promise<void>;
}

export function stubNodeEventStream(fallback: FetchFallback = globalThis.fetch): FakeNodeEventStream {
  const requests: EventStreamRequest[] = [];
  const connections: EventStreamConnection[] = [];
  const answers: Array<Response | Error> = [];
  const encoder = new TextEncoder();

  function open(request: EventStreamRequest, signal: AbortSignal | undefined): Response {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let aborted = false;
    const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
    signal?.addEventListener('abort', () => {
      aborted = true;
      controller.error(new DOMException('The operation was aborted.', 'AbortError'));
    });
    const write = async (text: string) => {
      controller.enqueue(encoder.encode(text));
      await settle();
    };
    connections.push({
      request,
      get aborted() { return aborted; },
      write,
      emit: (type, data) => write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`),
      end: async () => {
        controller.close();
        await settle();
      },
      fail: async () => {
        controller.error(new TypeError('network error'));
        await settle();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
    });
  }

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url, 'http://localhost').pathname !== EVENTS_PATH) return fallback(input, init);
    const headers: Record<string, string> = {};
    // happy-dom's Headers keeps the name's case when iterating.
    for (const [name, value] of new Headers(init?.headers)) headers[name.toLowerCase()] = value;
    const request: EventStreamRequest = { url, headers, cache: init?.cache };
    requests.push(request);
    const answer = answers.shift();
    if (answer instanceof Error) throw answer;
    return answer ?? open(request, init?.signal ?? undefined);
  });

  return {
    requests,
    connections,
    latest() {
      const connection = connections.at(-1);
      if (!connection) throw new Error('the page has not opened the event stream');
      return connection;
    },
    respondNextWith(response) { answers.push(response); },
    failNext() { answers.push(new TypeError('Failed to fetch')); },
    settle,
  };
}
