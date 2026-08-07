import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import {
  fetchMemorySessionGraphDelta,
  fetchLocalAgentIntegrations,
  importFile,
  persistLocalAgentChatFailure,
  LocalAgentApiError,
  sendHermesLocalChat,
  streamHermesLocalChat,
  streamLocalAgentChat,
  streamOpenClawLocalChat,
  streamPrimeAgentLocalChat,
} from '../src/ui/api.js';
import { resolveLocalAgentConversation } from '../src/ui/components/Shell/PanelRight/selection.js';

let server: Server;
let baseUrl: string;
let originalFetch: typeof globalThis.fetch;

const requestLog: Array<{ url: string; method: string }> = [];

function startTestServer(): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      const url = req.url ?? '/';
      requestLog.push({ url, method: req.method ?? 'GET' });

      if (url.includes('/api/openclaw-channel/stream')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"type":"text_delta","delta":"Hel"}\n\n');
        res.write('data: {"type":"text_delta","delta":"lo"}\n\n');
        res.write('data: {"type":"final","text":"Hello","correlationId":"c1"}\n\n');
        res.end();
        return;
      }

      if (url.includes('/api/hermes-channel/stream')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"type":"text_delta","delta":"Her"}\n\n');
        res.write('data: {"type":"text_delta","delta":"mes"}\n\n');
        res.write('data: {"type":"final","text":"Hermes","correlationId":"h1"}\n\n');
        res.end();
        return;
      }

      if (url.includes('/api/memory/sessions/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          mode: 'delta',
          sessionId: 's1',
          turnId: 't2',
          watermark: {
            baseTurnId: 't1',
            previousTurnId: 't1',
            appliedTurnId: 't2',
            latestTurnId: 't2',
            turnIndex: 2,
            turnCount: 2,
          },
          triples: [],
        }));
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any;
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

beforeAll(async () => {
  baseUrl = await startTestServer();
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    let url = String(input);
    if (url.startsWith('/')) {
      url = baseUrl + url;
    } else {
      url = url.replace(/^https?:\/\/[^/]+/, baseUrl);
    }
    return originalFetch(url, init);
  };
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('ui local-agent stream api', () => {
  it('parses OpenClaw SSE frames and resolves the final payload', async () => {
    requestLog.length = 0;

    const events: string[] = [];
    const res = await streamOpenClawLocalChat('hi', {
      onEvent: (event) => events.push(event.type),
    });

    expect(res.text).toBe('Hello');
    expect(res.correlationId).toBe('c1');
    expect(events).toEqual(['text_delta', 'text_delta', 'final']);
  });

  it('throws when the OpenClaw stream emits an error event', async () => {
    const prevFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      let url = String(input);
      if (url.startsWith('/')) {
        url = baseUrl + url;
      } else {
        url = url.replace(/^https?:\/\/[^/]+/, baseUrl);
      }
      const response = await originalFetch(url, init);
      const encoder = new TextEncoder();
      const errorStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"type":"error","error":"bridge unavailable"}\n\n'));
          controller.close();
        },
      });
      return new Response(errorStream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    };

    try {
      await expect(streamOpenClawLocalChat('hello')).rejects.toThrow('bridge unavailable');
    } finally {
      globalThis.fetch = prevFetch;
    }
  });

  it('preserves a terminal Prime Agent provider-auth code for the UI', async () => {
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(
            'data: {"type":"error","error":"Prime Agent provider authentication failed. Check the configured provider credentials.","code":"PRIME_AGENT_PROVIDER_UNAUTHORIZED","source":"prime-agent-channel","retryable":false,"correlationId":"p-auth"}\n\n',
          ));
          controller.enqueue(encoder.encode(
            'data: {"type":"final","text":"","correlationId":"p-auth","sessionId":"s1"}\n\n',
          ));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as typeof globalThis.fetch;

    try {
      let caught: unknown;
      await streamPrimeAgentLocalChat('hello').catch((err) => { caught = err; });
      expect(caught).toBeInstanceOf(LocalAgentApiError);
      expect(caught).toMatchObject({
        code: 'PRIME_AGENT_PROVIDER_UNAUTHORIZED',
        source: 'prime-agent-channel',
        correlationId: 'p-auth',
        retryable: false,
      });
    } finally {
      globalThis.fetch = prevFetch;
    }
  });

  it('maps the elected Prime session through selection into the generic chat transport', async () => {
    const savedFetch = globalThis.fetch;
    let payload: Record<string, unknown> = {};
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/local-agent-integrations')) {
        return Response.json({
          integrations: [{
            id: 'prime-agent',
            name: 'Prime Agent',
            description: 'Prime Agent framework adapter',
            enabled: true,
            capabilities: { localChat: true, connectFromUi: true },
            runtime: { status: 'ready', ready: true },
            metadata: {
              sessionCount: 2,
              activeSessionId: '019f-session-a',
              activeMemorySessionId: 'prime-agent:dkg-ui:019f-session-a',
            },
          }],
        });
      }
      if (url.includes('/api/prime-agent-channel/health')) {
        return Response.json({
          ok: true,
          sessionCount: 2,
          target: '019f-session-a',
          targetMemorySessionId: 'prime-agent:dkg-ui:019f-session-a',
          sessions: [
            {
              sessionId: '019f-session-a',
              rawSessionId: '019f-session-a',
              memorySessionId: 'prime-agent:dkg-ui:019f-session-a',
            },
            {
              sessionId: '019f-session-b',
              rawSessionId: '019f-session-b',
              memorySessionId: 'prime-agent:dkg-ui:019f-session-b',
            },
          ],
        });
      }
      payload = JSON.parse(String(init?.body ?? '{}'));
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(
            'data: {"type":"final","text":"Prime","correlationId":"p-pinned","sessionId":"019f-session-a"}\n\n',
          ));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as typeof globalThis.fetch;

    try {
      const { integrations } = await fetchLocalAgentIntegrations();
      const prime = integrations.find((integration) => integration.id === 'prime-agent');
      const conversation = resolveLocalAgentConversation({
        integrationId: 'prime-agent',
        sessionId: null,
        defaultSessionId: prime?.defaultSessionId,
      });
      const result = await streamLocalAgentChat('prime-agent', 'hello', {
        sessionId: conversation.sessionId ?? undefined,
        targetSessionId: prime?.liveSessions?.find(
          (session) => session.sessionId === conversation.sessionId,
        )?.rawSessionId,
      });
      expect(result.sessionId).toBe('019f-session-a');
      expect(payload).toMatchObject({ text: 'hello', sessionId: '019f-session-a' });
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('re-elects once when an automatically pinned Prime session has exited', async () => {
    const savedFetch = globalThis.fetch;
    const payloads: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      payloads.push(JSON.parse(String(init?.body ?? '{}')));
      if (payloads.length === 1) {
        return Response.json({
          error: 'No live Prime Agent session stale-session',
          code: 'PRIME_AGENT_NO_SESSION',
          source: 'prime-agent-channel',
        }, { status: 409 });
      }
      const encoder = new TextEncoder();
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(
            'data: {"type":"final","text":"Recovered","correlationId":"p-retry","sessionId":"live-session"}\n\n',
          ));
          controller.close();
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as typeof globalThis.fetch;

    try {
      const result = await streamLocalAgentChat('prime-agent', 'hello', {
        sessionId: 'prime-agent:dkg-ui:stale-session',
        targetSessionId: 'stale-session',
      });
      expect(result).toMatchObject({ text: 'Recovered', sessionId: 'live-session' });
      expect(payloads).toHaveLength(2);
      expect(payloads[0]).toMatchObject({ text: 'hello', sessionId: 'stale-session' });
      expect(payloads[1]).toMatchObject({ text: 'hello' });
      expect(payloads[1].sessionId).toBeUndefined();
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('parses Hermes SSE frames and resolves the final payload', async () => {
    requestLog.length = 0;

    const events: string[] = [];
    const res = await streamHermesLocalChat('hi', {
      sessionId: 'hermes:dkg-ui',
      onEvent: (event) => events.push(event.type),
    });

    expect(res.text).toBe('Hermes');
    expect(res.correlationId).toBe('h1');
    expect(events).toEqual(['text_delta', 'text_delta', 'final']);
    expect(requestLog.some(r => r.url.includes('/api/hermes-channel/stream'))).toBe(true);
  });

  it('includes Hermes daemon details in send and stream errors', async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl = String(url);
      const details = requestUrl.includes('/stream')
        ? 'gateway health does not match /api/hermes-channel'
        : 'bridge returned 502';
      return new Response(
        JSON.stringify({ error: 'Hermes bridge error', details }),
        { status: 502, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof globalThis.fetch;

    try {
      await expect(sendHermesLocalChat('hi')).rejects.toThrow('Hermes bridge error: bridge returned 502');
      await expect(streamHermesLocalChat('hi')).rejects.toThrow('Hermes bridge error: gateway health does not match /api/hermes-channel');
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('preserves structured Hermes stream timeout metadata', async () => {
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(
            'data: {"type":"error","error":"Hermes gateway response timeout","code":"HERMES_GATEWAY_RESPONSE_TIMEOUT","source":"hermes-channel","target":"gateway","details":"Hermes gateway did not produce an agent response","correlationId":"h-timeout","timeoutMs":900000}\n\n',
          ));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as typeof globalThis.fetch;

    try {
      let caught: any;
      await streamHermesLocalChat('hi').catch((err) => { caught = err; });
      expect(caught).toBeInstanceOf(LocalAgentApiError);
      expect(caught.message).toBe('Hermes gateway response timeout: Hermes gateway did not produce an agent response');
      expect(caught.code).toBe('HERMES_GATEWAY_RESPONSE_TIMEOUT');
      expect(caught.source).toBe('hermes-channel');
      expect(caught.target).toBe('gateway');
      expect(caught.correlationId).toBe('h-timeout');
      expect(caught.timeoutMs).toBe(900000);
    } finally {
      globalThis.fetch = prevFetch;
    }
  });

  it('forwards Hermes profile through the generic local-agent chat transport', async () => {
    const savedFetch = globalThis.fetch;
    let payload: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      payload = JSON.parse(String(init?.body ?? '{}'));
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"type":"final","text":"Hermes","correlationId":"h-profile"}\n\n'));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as typeof globalThis.fetch;

    try {
      const result = await streamLocalAgentChat('hermes', 'hello', {
        sessionId: 'hermes:dkg-ui:profile-dkg-smoke',
        profile: 'dkg-smoke',
      });

      expect(result.text).toBe('Hermes');
      expect(payload).toMatchObject({
        text: 'hello',
        sessionId: 'hermes:dkg-ui:profile-dkg-smoke',
        profile: 'dkg-smoke',
      });
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('normalizes Hermes delta/text SSE frames into local-agent text deltas', async () => {
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"type":"delta","text":"Her","correlationId":"h2"}\n\n'));
          controller.enqueue(encoder.encode('data: {"type":"delta","text":"mes","correlationId":"h2"}\n\n'));
          controller.enqueue(encoder.encode('data: {"type":"final","text":"Hermes","correlationId":"h2","sessionId":"bridge-session","turnId":"bridge-turn"}\n\n'));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as typeof globalThis.fetch;

    const events: Array<{ type: string; delta?: string }> = [];
    try {
      const res = await streamHermesLocalChat('hi', {
        onEvent: (event) => events.push(event),
      });

      expect(res.text).toBe('Hermes');
      expect(res.correlationId).toBe('h2');
      expect(res.sessionId).toBe('bridge-session');
      expect(res.turnId).toBe('bridge-turn');
      expect(events).toMatchObject([
        { type: 'text_delta', delta: 'Her' },
        { type: 'text_delta', delta: 'mes' },
        { type: 'final', sessionId: 'bridge-session', turnId: 'bridge-turn' },
      ]);
    } finally {
      globalThis.fetch = prevFetch;
    }
  });

  it('requests session graph delta with turn watermark query params', async () => {
    requestLog.length = 0;

    const res = await fetchMemorySessionGraphDelta('s1', 't2', { baseTurnId: 't1' });
    expect(res.mode).toBe('delta');
    expect(requestLog.some(r => r.url.includes('/api/memory/sessions/s1/graph-delta?turnId=t2&baseTurnId=t1'))).toBe(true);
  });

  it('forwards attachment refs through the generic local-agent chat transport', async () => {
    const fetchCalls: [string | URL | Request, RequestInit | undefined][] = [];
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push([url, init]);
      return new Response(
        JSON.stringify({ text: 'Attached response', correlationId: 'c3' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof globalThis.fetch;

    const attachments = [{
      id: 'att-1',
      fileName: 'notes.md',
      contextGraphId: 'project-1',
      assertionName: 'assert-1',
      assertionUri: 'urn:dkg:assertion:1',
      fileHash: 'abc123',
      detectedContentType: 'text/markdown',
      extractionStatus: 'completed' as const,
      tripleCount: 12,
    }];

    try {
      const result = await streamLocalAgentChat('openclaw', 'hello', {
        attachments,
      });

      expect(result.text).toBe('Attached response');
      const payload = JSON.parse(String(fetchCalls[0]?.[1]?.body));
      expect(payload.attachmentRefs).toEqual(attachments);
      expect(payload.text).toBe('hello');
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('forwards skipped import results separately from generic context entries', async () => {
    const fetchCalls: [string | URL | Request, RequestInit | undefined][] = [];
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push([url, init]);
      return new Response(
        JSON.stringify({ text: 'Context response', correlationId: 'c4' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof globalThis.fetch;

    const attachmentImportResults = [{
      id: 'att-1',
      fileName: 'notes.epub',
      contextGraphId: 'project-1',
      assertionName: 'import-1',
      assertionUri: 'urn:dkg:assertion:1',
      fileHash: 'abc123',
      detectedContentType: 'application/epub+zip',
      extractionStatus: 'skipped' as const,
      pipelineUsed: null,
      tripleCount: 0,
    }];

    try {
      const result = await streamLocalAgentChat('openclaw', '', {
        attachmentImportResults,
        contextGraphId: 'project-1',
        persistUserMessage: 'Attachment import result: notes.epub.',
      });

      expect(result.text).toBe('Context response');
      const payload = JSON.parse(String(fetchCalls[0]?.[1]?.body));
      expect(payload.text).toBe('');
      expect(payload.persistUserMessage).toBe('Attachment import result: notes.epub.');
      expect(payload.attachmentImportResults).toEqual(attachmentImportResults);
      expect(payload.contextGraphId).toBe('project-1');
      expect(payload).not.toHaveProperty('attachmentRefs');
      expect(payload).not.toHaveProperty('contextEntries');
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('forwards skipped import results through Hermes without attachment refs', async () => {
    const fetchCalls: [string | URL | Request, RequestInit | undefined][] = [];
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push([url, init]);
      return new Response(
        JSON.stringify({ text: 'Hermes context response', correlationId: 'h-context' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof globalThis.fetch;

    const attachmentImportResults = [{
      id: 'att-1',
      fileName: 'deck.pptx',
      contextGraphId: 'project-1',
      assertionName: 'deck',
      assertionUri: 'urn:dkg:assertion:deck',
      fileHash: 'sha256:deck',
      detectedContentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      extractionStatus: 'skipped' as const,
      pipelineUsed: null,
      tripleCount: 0,
    }];

    try {
      const result = await streamLocalAgentChat('hermes', '', {
        sessionId: 'hermes:dkg-ui',
        attachmentImportResults,
        contextGraphId: 'project-1',
        persistUserMessage: 'Attachment import result: deck.pptx.',
      });

      expect(result.text).toBe('Hermes context response');
      expect(String(fetchCalls[0]?.[0])).toBe('/api/hermes-channel/stream');
      const payload = JSON.parse(String(fetchCalls[0]?.[1]?.body));
      expect(payload.text).toBe('');
      expect(payload.persistUserMessage).toBe('Attachment import result: deck.pptx.');
      expect(payload.attachmentImportResults).toEqual(attachmentImportResults);
      expect(payload.contextGraphId).toBe('project-1');
      expect(payload).not.toHaveProperty('attachmentRefs');
      expect(payload).not.toHaveProperty('contextEntries');
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('adds a best-effort content type when importing chat attachments with empty browser MIME types', async () => {
    const savedFetch = globalThis.fetch;
    let postedContentType: FormDataEntryValue | null = null;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body as FormData;
      postedContentType = body.get('contentType');
      return new Response(
        JSON.stringify({
          assertionUri: 'urn:dkg:assertion:deck',
          fileHash: 'sha256:deck',
          detectedContentType: String(postedContentType),
          extraction: { status: 'skipped', tripleCount: 0, pipelineUsed: null },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof globalThis.fetch;

    try {
      const result = await importFile(
        'deck',
        'project-1',
        new File(['slides'], 'deck.pptx', { type: 'application/octet-stream' }),
      );

      expect(postedContentType).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation');
      expect(result.detectedContentType).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation');
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('forwards durable turn metadata through the Hermes local-agent chat transport', async () => {
    const fetchCalls: [string | URL | Request, RequestInit | undefined][] = [];
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push([url, init]);
      return new Response(
        JSON.stringify({ text: 'Hermes response', correlationId: 'h3' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof globalThis.fetch;

    const attachments = [{
      id: 'att-1',
      fileName: 'notes.md',
      contextGraphId: 'project-1',
      assertionName: 'assert-1',
      assertionUri: 'urn:dkg:assertion:1',
      fileHash: 'abc123',
      detectedContentType: 'text/markdown',
      extractionStatus: 'completed' as const,
      tripleCount: 12,
    }];
    const contextEntries = [{
      key: 'project',
      label: 'Project',
      value: 'project-1',
    }];

    try {
      const result = await streamLocalAgentChat('hermes', 'hello', {
        correlationId: 'corr-1',
        sessionId: 'hermes:dkg-ui',
        profile: 'dkg-smoke',
        attachments,
        contextEntries,
        contextGraphId: 'project-1',
      });

      expect(result.text).toBe('Hermes response');
      expect(String(fetchCalls[0]?.[0])).toBe('/api/hermes-channel/stream');
      const payload = JSON.parse(String(fetchCalls[0]?.[1]?.body));
      expect(payload.correlationId).toBe('corr-1');
      expect(payload.sessionId).toBe('hermes:dkg-ui');
      expect(payload.profile).toBe('dkg-smoke');
      expect(payload.attachmentRefs).toEqual(attachments);
      expect(payload.contextEntries).toEqual(contextEntries);
      expect(payload.contextGraphId).toBe('project-1');
      expect(payload.text).toBe('hello');
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('persists failed Hermes local-agent turns through the durable turn endpoint', async () => {
    const fetchCalls: [string | URL | Request, RequestInit | undefined][] = [];
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push([url, init]);
      return new Response(
        JSON.stringify({ ok: true, turnId: 'corr-timeout' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof globalThis.fetch;

    try {
      const result = await persistLocalAgentChatFailure('hermes', {
        sessionId: 'hermes:dkg-ui:profile-dkg-smoke',
        correlationId: 'corr-timeout',
        userMessage: 'slow question',
        failureReason: 'Hermes took too long to respond.',
        profile: 'dkg-smoke',
        contextGraphId: 'project-1',
      });

      expect(result.turnId).toBe('corr-timeout');
      expect(String(fetchCalls[0]?.[0])).toBe('/api/hermes-channel/persist-turn');
      const payload = JSON.parse(String(fetchCalls[0]?.[1]?.body));
      expect(payload).toMatchObject({
        sessionId: 'hermes:dkg-ui:profile-dkg-smoke',
        userMessage: 'slow question',
        assistantReply: '',
        correlationId: 'corr-timeout',
        persistenceState: 'failed',
        failureReason: 'Hermes took too long to respond.',
        profile: 'dkg-smoke',
        contextGraphId: 'project-1',
      });
      expect(payload).not.toHaveProperty('turnId');
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('requires an explicit Hermes session id when persisting failed turns', async () => {
    await expect(persistLocalAgentChatFailure('hermes', {
      correlationId: 'corr-timeout',
      userMessage: 'slow question',
      failureReason: 'Hermes took too long to respond.',
      profile: 'dkg-smoke',
    })).rejects.toThrow('Missing Hermes session id');
  });
});
