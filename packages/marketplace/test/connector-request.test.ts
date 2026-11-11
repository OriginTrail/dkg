// SPDX-License-Identifier: Apache-2.0
/**
 * How the OpenAI-compatible backend is sent a call's output limit and
 * temperature: by its host (OpenAI's own API gets `max_completion_tokens` and
 * no temperature, which its reasoning models need; any other backend
 * `max_tokens` and 0, as in 10.1.0) or by the service's settings; the
 * reasoning effort a call with tools carries, when the settings name one; and
 * what a refusal says: the backend's own words, on one line, cut short, never a key,
 * and the status it answered, which a backend that did not answer has none of.
 * `fetch` is stubbed, so no request leaves the process.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UpstreamError, backendMessageOf, connectorOf, requestShapeOf, resolveSellerConfig } from '../src/index.js';

const OK = { choices: [{ message: { role: 'assistant', content: 'synthetic answer' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } };
const CALL = { messages: [{ role: 'user' as const, content: 'q' }], maxTokens: 7 };
// Test values only; neither is a credential anywhere.
const TEST_KEY = ['test', 'backend', 'value', '1234'].join('-');
const OTHER_BEARER = ['unrelated', 'token', '5678'].join('-');

/** `fetch` answering `body` with `status`; each request's URL and body are kept. */
function stubFetch(status: number, body: unknown): Array<{ url: string; body: Record<string, unknown> }> {
  const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }));
  return seen;
}

/** What a backend's refusal with an HTTP status fails with: an `UpstreamError`, its message and its status each checked. */
const upstream = (message: string, status: number) => ({ name: 'UpstreamError', message, status });

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TEST_BACKEND_KEY;
});

describe("a backend's output limit and temperature", () => {
  it("are max_completion_tokens and none for OpenAI's own API, as its reasoning models need", async () => {
    const seen = stubFetch(200, OK);
    await connectorOf({ kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-sol' }).complete(CALL);
    expect(seen[0]!.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(seen[0]!.body).toEqual({ model: 'gpt-5.6-sol', messages: CALL.messages, max_completion_tokens: 7, stream: false });
  });

  it('are max_tokens and 0 for any other backend, as in 10.1.0: a local Ollama, say', async () => {
    const seen = stubFetch(200, OK);
    await connectorOf({ kind: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3' }).complete(CALL);
    expect(seen[0]!.body).toEqual({ model: 'llama3', messages: CALL.messages, max_tokens: 7, temperature: 0, stream: false });
    expect(Object.keys(seen[0]!.body)).toEqual(['model', 'messages', 'max_tokens', 'temperature', 'stream']);
  });

  it("are the service's own when its settings name them, over its host's", async () => {
    const seen = stubFetch(200, OK);
    await connectorOf({ kind: 'openai', baseUrl: 'http://127.0.0.1:8080/v1', model: 'm', maxTokensField: 'max_completion_tokens', temperature: null }).complete(CALL);
    expect(seen[0]!.body).toEqual({ model: 'm', messages: CALL.messages, max_completion_tokens: 7, stream: false });
    await connectorOf({ kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', maxTokensField: 'max_tokens', temperature: 0.7 }).complete(CALL);
    expect(seen[1]!.body).toEqual({ model: 'gpt-4.1-mini', messages: CALL.messages, max_tokens: 7, temperature: 0.7, stream: false });
    // The host is OpenAI's own only when it is exactly that host, in any case.
    expect(requestShapeOf({ baseUrl: 'https://API.OpenAI.com/v1' })).toEqual({ maxTokensField: 'max_completion_tokens', temperature: null });
    expect(requestShapeOf({ baseUrl: 'https://api.openai.com.example.org/v1' })).toEqual({ maxTokensField: 'max_tokens', temperature: 0 });
    expect(requestShapeOf({ baseUrl: 'https://api.openai.com/v1', temperature: 0 })).toEqual({ maxTokensField: 'max_completion_tokens', temperature: 0 });
  });

  it('are checked in the seller settings', () => {
    const service = { model: 'urn:test:model:a', pricePerUnit: '1000', backend: { kind: 'openai' as const, baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-sol' } };
    const resolved = resolveSellerConfig({ seller: { enabled: true, services: [{ ...service, backend: { ...service.backend, maxTokensField: 'max_completion_tokens', temperature: null } }] } });
    expect(resolved!.services[0]!.backend).toMatchObject({ maxTokensField: 'max_completion_tokens', temperature: null });
    for (const [backend, message] of [
      [{ maxTokensField: 'max_output_tokens' }, /maxTokensField must be max_tokens or max_completion_tokens/],
      [{ temperature: 3 }, /temperature must be a number from 0 to 2, or null/],
      [{ temperature: '0' }, /temperature must be a number from 0 to 2, or null/],
    ] as const) {
      expect(() => resolveSellerConfig({ seller: { enabled: true, services: [{ ...service, backend: { ...service.backend, ...backend } as never }] } })).toThrow(message);
    }
  });
});

describe("a backend's reasoning effort with tools", () => {
  const TOOLS = [{ type: 'function' as const, function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }];
  const SOL = { kind: 'openai' as const, baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-sol' };

  it('is sent as the settings name it with a call that carries tools, and with no other', async () => {
    const seen = stubFetch(200, OK);
    const backend = connectorOf({ ...SOL, reasoningEffortWithTools: 'none' });
    await backend.complete({ ...CALL, tools: TOOLS, toolChoice: 'auto' });
    expect(seen[0]!.body).toEqual({
      model: 'gpt-5.6-sol', messages: CALL.messages, max_completion_tokens: 7, stream: false, tools: TOOLS, tool_choice: 'auto', reasoning_effort: 'none',
    });
    await backend.complete(CALL);
    expect(seen[1]!.body).toEqual({ model: 'gpt-5.6-sol', messages: CALL.messages, max_completion_tokens: 7, stream: false });
  });

  it('is not sent when the settings name none, so the model keeps its own', async () => {
    const seen = stubFetch(200, OK);
    await connectorOf(SOL).complete({ ...CALL, tools: TOOLS });
    expect(seen[0]!.body).toEqual({ model: 'gpt-5.6-sol', messages: CALL.messages, max_completion_tokens: 7, stream: false, tools: TOOLS });
  });

  it('is checked in the seller settings', () => {
    const service = { model: 'urn:test:model:a', pricePerUnit: '1000', backend: SOL };
    const resolved = resolveSellerConfig({ seller: { enabled: true, services: [{ ...service, backend: { ...SOL, reasoningEffortWithTools: 'none' } }] } });
    expect(resolved!.services[0]!.backend).toMatchObject({ reasoningEffortWithTools: 'none' });
    for (const effort of ['', 'None', 'very high', 'x'.repeat(17), 3, null]) {
      expect(() => resolveSellerConfig({ seller: { enabled: true, services: [{ ...service, backend: { ...SOL, reasoningEffortWithTools: effort } as never }] } }))
        .toThrow(/reasoningEffortWithTools must be a reasoning effort, such as none or low/);
    }
  });
});

describe("a backend's refusal", () => {
  it("says its status and the backend's own words", async () => {
    stubFetch(400, { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", type: 'invalid_request_error' } });
    await expect(connectorOf({ kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-sol', maxTokensField: 'max_tokens' }).complete(CALL))
      .rejects.toMatchObject(upstream("the backend answered 400: Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", 400));
  });

  it('carries the status the backend answered, and none when it did not answer, timed out, or answered with nothing to serve', async () => {
    const backend = connectorOf({ kind: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'm', timeoutMs: 20 });
    for (const status of [404, 408, 413, 422, 429, 503]) {
      stubFetch(status, { error: { message: 'synthetic refusal' } });
      await expect(backend.complete(CALL)).rejects.toMatchObject(upstream(`the backend answered ${status}: synthetic refusal`, status));
    }
    const statusOf = (err: unknown) => (err instanceof UpstreamError ? err.status : 'not an UpstreamError');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const down = await backend.complete(CALL).catch((e: unknown) => e);
    expect(down).toMatchObject({ message: 'the backend did not answer: fetch failed' });
    expect(statusOf(down)).toBeUndefined();
    // A backend that never answers is stopped at the time limit.
    vi.stubGlobal('fetch', vi.fn((_url: string | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason)))));
    const late = await backend.complete(CALL).catch((e: unknown) => e);
    expect(late).toMatchObject({ message: expect.stringMatching(/^the backend did not answer: .*timeout/i) });
    expect(statusOf(late)).toBeUndefined();
    stubFetch(200, { choices: OK.choices });
    const empty = await backend.complete(CALL).catch((e: unknown) => e);
    expect(empty).toMatchObject({ message: 'the backend answered without token counts' });
    expect(statusOf(empty)).toBeUndefined();
  });

  it('never says the key, nor anything shaped as one, and says only its status when the backend says nothing that reads', async () => {
    process.env.TEST_BACKEND_KEY = TEST_KEY;
    stubFetch(401, { error: { message: `Incorrect API key provided: sk-proj-abcd1234****wxyz. Sent: ${TEST_KEY}. Forwarded: Authorization: Bearer ${OTHER_BEARER}` } });
    const err = await connectorOf({ kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'm', apiKeyEnv: 'TEST_BACKEND_KEY' }).complete(CALL).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).status).toBe(401);
    // Each by its own rule: the key itself, anything shaped as an API key, and any bearer token.
    expect((err as Error).message).toBe('the backend answered 401: Incorrect API key provided: [redacted] Sent: [redacted]. Forwarded: Authorization: Bearer [redacted]');
    for (const secret of [TEST_KEY, 'sk-proj', OTHER_BEARER]) expect((err as Error).message).not.toContain(secret);
    stubFetch(502, '<html>bad gateway</html>');
    await expect(connectorOf({ kind: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'm' }).complete(CALL)).rejects.toMatchObject(upstream('the backend answered 502', 502));
  });

  it('is on one line and cut short, from an OpenAI error or a bare one', () => {
    const long = backendMessageOf({ error: { message: 'x'.repeat(500) } }, undefined)!;
    expect(long).toHaveLength(200);
    expect(long.endsWith('…')).toBe(true);
    // Ollama's shape: the error as text.
    expect(backendMessageOf({ error: "model 'llama3' not found" }, undefined)).toBe("model 'llama3' not found");
    expect(backendMessageOf({ error: { message: 'line one\n\tline two' } }, undefined)).toBe('line one line two');
    for (const none of [null, '<html>502</html>', { error: { message: '' } }, { error: { code: 7 } }, { detail: 'x' }]) {
      expect(backendMessageOf(none, undefined)).toBeUndefined();
    }
  });
});
