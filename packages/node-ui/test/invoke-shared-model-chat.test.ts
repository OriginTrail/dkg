// Unit coverage for `invokeSharedModelChat` — the api.ts helper behind the
// Curator Model chat demo (Header → CuratorModelChatModal). The load-bearing
// logic is the response unwrapping:
//   - 2xx → choices[0].message.content
//   - non-2xx → throw Error carrying the OpenAI-shaped error.message (an
//     OBJECT, not a string — the generic post() helper would mangle it)
// so we pin both against a mocked fetch, mirroring the modal/ai-model test's
// fetch-mock style.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invokeSharedModelChat } from '../src/ui/api.js';

const CG = 'shared-model-test-1781437109';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  (globalThis as any).window = { __DKG_TOKEN__: 'test-token' };
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as any).window;
});

describe('invokeSharedModelChat', () => {
  it('POSTs to the member node OpenAI-compatible route with the bearer token and messages', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Hello there, friend!' } }],
      }),
    );
    (globalThis as any).fetch = fetchMock;

    const content = await invokeSharedModelChat(CG, [{ role: 'user', content: 'hi' }], { model: 'gpt-4o-mini' });

    expect(content).toBe('Hello there, friend!');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/context-graph/${CG}/model/v1/chat/completions`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer test-token');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    const sent = JSON.parse(init.body as string);
    expect(sent).toEqual({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] });
  });

  it('omits the model field when none is supplied', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
    );
    (globalThis as any).fetch = fetchMock;

    await invokeSharedModelChat(CG, [{ role: 'user', content: 'hi' }]);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ messages: [{ role: 'user', content: 'hi' }] });
  });

  it('returns an empty string when the completion has no content', async () => {
    (globalThis as any).fetch = vi.fn(async () => jsonResponse(200, { choices: [] }));
    await expect(invokeSharedModelChat(CG, [{ role: 'user', content: 'hi' }])).resolves.toBe('');
  });

  it('throws the OpenAI-shaped error.message on a 403 denial', async () => {
    (globalThis as any).fetch = vi.fn(async () =>
      jsonResponse(403, {
        error: {
          message: 'requester is not a member of this context graph',
          type: 'invalid_request_error',
          code: 'shared_model_denied',
        },
      }),
    );

    await expect(
      invokeSharedModelChat(CG, [{ role: 'user', content: 'hi' }]),
    ).rejects.toThrow('requester is not a member of this context graph');
  });

  it('falls back to an HTTP status message when the error body is unparseable', async () => {
    (globalThis as any).fetch = vi.fn(async () =>
      new Response('not json', { status: 500, headers: { 'content-type': 'text/plain' } }),
    );

    await expect(
      invokeSharedModelChat(CG, [{ role: 'user', content: 'hi' }]),
    ).rejects.toThrow('HTTP 500');
  });
});
