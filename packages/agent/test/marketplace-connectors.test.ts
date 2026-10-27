/**
 * OT-RFC-27 seller chat connectors against local `node:http` upstreams on
 * port 0: openai-compatible (call-time secret, redaction, classification,
 * sampler/max-tokens fields, vLLM `tool_calls: []`), llama.cpp (loopback rule,
 * GGUF digest cache, health, context overflow, boot retry) and codex-oauth
 * (Responses SSE, single-flight refresh, atomic 0600 rewrite, scope gate).
 */
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { ethers } from 'ethers';
import { decodeMarketplaceQuoteResponse, encodeMarketplaceQuoteRequest } from '@origintrail-official/dkg-core';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { offeringIdFor } from '@origintrail-official/dkg-marketplace';
import { mountChatConnector } from '../src/marketplace/connectors/index.js';
import { MarketplaceConnectorMountError } from '../src/marketplace/connectors/types.js';
import { redactThenTruncate } from '../src/marketplace/connectors/http.js';
import { createChatConnectorExecutor } from '../src/marketplace/chat-executor.js';
import {
  SellerConnectorManager,
  mountConnectorOffering,
  type SellerOfferingDeps,
} from '../src/marketplace/seller-offerings.js';
import type { MarketplaceOfferingConfig } from '../src/marketplace/config.js';
import { MarketplaceSellerService, type MarketplaceSellerOffering } from '../src/marketplace/seller-service.js';

const log = { info: () => {}, warn: () => {} };
const TINY_HF_TOKENIZER = JSON.stringify({
  version: '1.0',
  model: { type: 'BPE', vocab: { a: 0, b: 1, c: 2, 'Ġ': 3, ab: 4, abc: 5, 'Ġa': 6 }, merges: ['a b', 'ab c', 'Ġ a'] },
});
const TINY_O200K = ['YQ== 0', 'Yg== 1', 'Yw== 2', 'IA== 3', 'YWI= 4', 'YWJj 5', ''].join('\n');

interface Recorded { method: string; url: string; headers: IncomingMessage['headers']; body: string }
type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void | Promise<void>;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function upstream(handler: Handler): Promise<{ base: string; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      void Promise.resolve(handler(req, body, res)).catch(() => res.destroy());
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dkg-mkt-connectors-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const reply = (content: string | null, extra: Record<string, unknown> = {}) => ({
  id: 'chatcmpl-x',
  choices: [{ index: 0, message: { role: 'assistant', content, ...extra }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
});

function secretFile(dir: string, content: string, mode = 0o600): string {
  const file = join(dir, 'upstream.env');
  writeFileSync(file, content, { mode });
  chmodSync(file, mode);
  return file;
}

const request = { upstreamModel: 'gpt-x', messages: [{ role: 'user', content: 'hi there' }], maxTokens: 16 };

describe('openai-compatible connector', () => {
  it('serves a reply, reads the key at CALL time, and sends sampler fields only when set', async () => {
    const { base, requests } = await upstream((_req, _body, res) => json(res, 200, reply('hello back')));
    const dir = tmp();
    const file = secretFile(dir, '# upstream key\n\nOPENAI_API_KEY=sk-first\n');
    const connector = await mountChatConnector(
      { kind: 'openai-compatible', baseUrl: `${base}/v1/`, upstreamModel: 'gpt-x', secretEnvFile: file, maxTokensField: 'max_completion_tokens' },
      { log },
    );
    expect(connector.description).toMatchObject({
      kind: 'openai-compatible', toolTransport: 'native', provenanceClass: 'upstream-claimed',
      upstreamOrigin: base, secretConfigured: true,
    });
    const first = await connector.complete(request);
    expect(first).toEqual({ ok: true, content: 'hello back', finishReason: 'stop', providerUsage: { promptTokens: 7, completionTokens: 2 } });
    expect(requests[0].url).toBe('/v1/chat/completions');
    expect(requests[0].headers.authorization).toBe('Bearer sk-first');
    const sent = JSON.parse(requests[0].body) as Record<string, unknown>;
    expect(sent).toEqual({ model: 'gpt-x', messages: request.messages, max_completion_tokens: 16, stream: false });
    expect(sent).not.toHaveProperty('temperature');

    // Rotation needs no restart: the next call reads the new key.
    secretFile(dir, 'OPENAI_API_KEY=sk-rotated\n');
    await connector.complete({ ...request, temperature: 0.2, seed: 7, stop: ['\n'] });
    expect(requests[1].headers.authorization).toBe('Bearer sk-rotated');
    expect(JSON.parse(requests[1].body)).toMatchObject({ temperature: 0.2, seed: 7, stop: ['\n'], max_completion_tokens: 16 });
  });

  it('treats tool_calls [] / null as no tool calls (vLLM) and normalizes real ones', async () => {
    const replies = [
      reply('plain', { tool_calls: [] }),
      reply('plain', { tool_calls: null }),
      reply(null, { tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' }, extra: 1 }] }),
    ];
    const { base } = await upstream((_req, _body, res) => json(res, 200, replies.shift()));
    const connector = await mountChatConnector({ kind: 'openai-compatible', baseUrl: base, upstreamModel: 'm' }, { log });
    expect(await connector.complete(request)).toMatchObject({ ok: true, content: 'plain' });
    expect(await connector.complete(request)).not.toHaveProperty('toolCalls');
    const tools = await connector.complete(request);
    expect(tools).toMatchObject({
      ok: true, content: '', toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
    });
  });

  it('classifies 429 / 401 / 500 / redirect / timeout and never echoes the key', async () => {
    const key = `sk-${'z'.repeat(40)}`;
    let mode = '429';
    const { base } = await upstream(async (req, _body, res) => {
      if (mode === 'redirect') { res.writeHead(302, { location: 'http://127.0.0.1:1/elsewhere' }); res.end(); return; }
      if (mode === 'slow') { await new Promise((r) => setTimeout(r, 1_500)); json(res, 200, reply('late')); return; }
      // Echo the presented bearer so that the key straddles character 160 of the body.
      const echoed = `${'x'.repeat(120)} ${String(req.headers.authorization)} trailing`;
      json(res, mode === '429' ? 429 : mode === '401' ? 401 : 500, { error: { message: echoed } });
    });
    const dir = tmp();
    const connector = await mountChatConnector(
      { kind: 'openai-compatible', baseUrl: base, upstreamModel: 'm', secretEnvFile: secretFile(dir, `OPENAI_API_KEY=${key}\n`), timeoutMs: 1_000 },
      { log },
    );
    const outcomes: Record<string, unknown> = {};
    for (const next of ['429', '401', '500', 'redirect', 'slow']) {
      mode = next;
      outcomes[next] = await connector.complete(request);
    }
    expect(outcomes['429']).toMatchObject({ ok: false, code: 'UPSTREAM_RATE_LIMITED', status: 429 });
    expect(outcomes['401']).toMatchObject({ ok: false, code: 'UPSTREAM_AUTH', status: 401 });
    expect(outcomes['500']).toMatchObject({ ok: false, code: 'UPSTREAM_ERROR', status: 500 });
    expect(outcomes.redirect).toMatchObject({ ok: false, code: 'UPSTREAM_ERROR', status: 0 });
    expect(outcomes.slow).toMatchObject({ ok: false, code: 'UPSTREAM_TIMEOUT', status: 0 });
    for (const outcome of Object.values(outcomes)) {
      const detail = (outcome as { detail: string }).detail;
      expect(detail.length).toBeLessThanOrEqual(240);
      expect(detail).not.toContain('zzzzzzzz');
    }
    expect((outcomes['500'] as { detail: string }).detail).toContain('[redacted]');
    // Truncating first would have left a key prefix at the cut.
    const body = `${'x'.repeat(150)}${key}`;
    expect(redactThenTruncate(body, [key])).not.toContain('sk-z');
  });

  it('refuses a missing, loose-permission, keyless or malformed secret file at mount — naming file and line, never content', async () => {
    const dir = tmp();
    const config = (file: string) => ({ kind: 'openai-compatible' as const, baseUrl: 'http://127.0.0.1:9/v1', upstreamModel: 'm', secretEnvFile: file });
    await expect(mountChatConnector(config(join(dir, 'absent.env')), { log }))
      .rejects.toMatchObject({ name: 'MarketplaceConnectorMountError', code: 'CONNECTOR_SECRET_ABSENT' });
    await expect(mountChatConnector(config(secretFile(dir, 'OPENAI_API_KEY=sk-loose\n', 0o644)), { log }))
      .rejects.toMatchObject({ code: 'CONNECTOR_SECRET_PERMS' });
    await expect(mountChatConnector(config(secretFile(dir, 'OTHER_KEY=v\n')), { log }))
      .rejects.toMatchObject({ code: 'CONNECTOR_SECRET_ABSENT' });
    const malformed = await mountChatConnector(config(secretFile(dir, 'OPENAI_API_KEY=sk-ok\nthis line leaks sk-secret\n')), { log })
      .catch((error: MarketplaceConnectorMountError) => error);
    expect(malformed).toBeInstanceOf(MarketplaceConnectorMountError);
    expect(malformed.message).toContain('line 2');
    expect(malformed.message).not.toContain('sk-');
    await expect(mountChatConnector({ kind: 'openai-compatible', baseUrl: 'ftp://host/v1', upstreamModel: 'm' }, { log }))
      .rejects.toMatchObject({ code: 'CONNECTOR_CONFIG' });
    await expect(mountChatConnector({ kind: 'openai-compatible', baseUrl: 'https://u:p@host/v1', upstreamModel: 'm' }, { log }))
      .rejects.toMatchObject({ code: 'CONNECTOR_CONFIG' });
  });

  it('an unlisted tool returned upstream fails closed in the executor (UPSTREAM_ERROR, no receipt)', async () => {
    const { base } = await upstream((_req, _body, res) => json(res, 200, reply(null, {
      tool_calls: [{ id: 'c', type: 'function', function: { name: 'not_offered', arguments: '{}' } }],
    })));
    const connector = await mountChatConnector({ kind: 'openai-compatible', baseUrl: base, upstreamModel: 'm' }, { log });
    const executor = createChatConnectorExecutor({ connector, modelId: 'm' });
    const payload = {
      schema: 'openai-chat/v1', model: 'm', messages: [{ role: 'user', content: 'go' }], max_tokens: 8,
      tools: [{ type: 'function', function: { name: 'lookup' } }], tool_choice: 'auto',
    };
    await expect(executor.execute(new TextEncoder().encode(JSON.stringify(payload)), { maxUnits: 1_000n }))
      .rejects.toMatchObject({ name: 'MarketplaceExecutionError', code: 'UPSTREAM_ERROR' });
  });
});

function ggufAndTokenizer(dir: string): { ggufPath: string; tokenizerPath: string } {
  const ggufPath = join(dir, 'model.gguf');
  writeFileSync(ggufPath, Buffer.from('GGUF fake weights'));
  const tokenizerPath = join(dir, 'tokenizer.json');
  writeFileSync(tokenizerPath, TINY_HF_TOKENIZER);
  return { ggufPath, tokenizerPath };
}

describe('llamacpp connector', () => {
  it('is loopback-only', async () => {
    const settings = { seed: 1, temperature: '0', ctx: 4096 };
    for (const baseUrl of ['http://10.0.0.1:8080', 'https://127.0.0.1:8080', 'http://127.0.0.1:8080/v1']) {
      await expect(mountChatConnector({ kind: 'llamacpp', baseUrl, ggufPath: '/x.gguf', settings }, { log }))
        .rejects.toMatchObject({ code: 'CONNECTOR_NOT_LOOPBACK' });
    }
  });

  it('pins the GGUF digest (cached by path/size/mtime), probes health, and classifies a context overflow', async () => {
    let mode: 'ok' | 'overflow' = 'ok';
    const { base, requests } = await upstream((req, _body, res) => {
      if (req.url === '/v1/models') return json(res, 200, { data: [{ id: '/models/secret/path/qwen.gguf' }] });
      if (mode === 'overflow') {
        return json(res, 400, { error: { message: 'request (5000 tokens) exceeds the available context size (4096 tokens)' } });
      }
      return json(res, 200, reply('done'));
    });
    const dir = tmp();
    const { ggufPath } = ggufAndTokenizer(dir);
    const hashFile = vi.fn(async () => `sha256:${'ab'.repeat(32)}`);
    const config = { kind: 'llamacpp' as const, baseUrl: base, ggufPath, settings: { seed: 42, temperature: '0.7', ctx: 4096 } };
    const first = await mountChatConnector(config, { log, dataDir: dir, hashFile });
    const second = await mountChatConnector(config, { log, dataDir: dir, hashFile });
    expect(hashFile).toHaveBeenCalledTimes(1);
    expect(second.description.weightsDigest).toBe(first.description.weightsDigest);
    expect(statSync(join(dir, 'marketplace', 'connector-digests.json')).mode & 0o777).toBe(0o600);
    expect(first.description).toMatchObject({
      kind: 'llamacpp', toolTransport: 'prompt', provenanceClass: 'weights-pinned', contextLength: 4096n,
      servingSeed: 42n, servingTemperature: '0.7', secretConfigured: false,
    });

    const ok = await first.complete({ ...request, temperature: 1.9, seed: 3 });
    expect(ok).toMatchObject({ ok: true, content: 'done' });
    const sent = JSON.parse(requests.find((r) => r.url === '/v1/chat/completions')!.body) as Record<string, unknown>;
    // Pinned serving settings win over the request's sampler fields.
    expect(sent).toMatchObject({ model: '/models/secret/path/qwen.gguf', temperature: 0.7, seed: 42, max_tokens: 16 });
    mode = 'overflow';
    expect(await first.complete(request)).toMatchObject({ ok: false, code: 'CONTEXT_EXCEEDED', status: 400 });
  });

  it('fails mount when the server is not healthy or the GGUF is absent', async () => {
    const { base } = await upstream((_req, _body, res) => json(res, 503, { error: 'loading' }));
    const dir = tmp();
    const { ggufPath } = ggufAndTokenizer(dir);
    const settings = { seed: 1, temperature: '0', ctx: 2048 };
    await expect(mountChatConnector({ kind: 'llamacpp', baseUrl: base, ggufPath, settings }, { log }))
      .rejects.toMatchObject({ code: 'CONNECTOR_UNHEALTHY' });
    await expect(mountChatConnector({ kind: 'llamacpp', baseUrl: base, ggufPath: join(dir, 'missing.gguf'), settings }, { log }))
      .rejects.toMatchObject({ code: 'CONNECTOR_GGUF_ABSENT' });
  });

  it('a llama.cpp server that comes up after a failed boot mount is picked up by the backoff retry', async () => {
    const dir = tmp();
    const { ggufPath, tokenizerPath } = ggufAndTokenizer(dir);
    let up = false;
    const fakeFetch = vi.fn(async (url: string | URL | Request) => {
      if (!up) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      const path = new URL(String(url)).pathname;
      return new Response(JSON.stringify(path === '/v1/models' ? { data: [{ id: 'local' }] } : reply('x')), { status: 200 });
    }) as unknown as typeof fetch;
    const served: Array<{ offerings: string[]; unavailable: string[] }> = [];
    const seller = {
      setOfferings(offerings: MarketplaceSellerOffering[], opts: { unavailable?: Iterable<string> } = {}) {
        served.push({ offerings: offerings.map((o) => o.offeringLocalId), unavailable: [...(opts.unavailable ?? [])] });
      },
    } as unknown as MarketplaceSellerService;
    const deps: SellerOfferingDeps = { log, queryFn: async () => ({ result: null }), fetch: fakeFetch, dataDir: dir, hashFile: async () => `sha256:${'cd'.repeat(32)}` };
    const config: MarketplaceOfferingConfig = {
      offeringLocalId: 'local-chat', serviceType: 'inference', unit: 'token', modelId: 'Qwen2.5-7B', askPerUnitWei: 1n,
      connector: { kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8081', ggufPath, settings: { seed: 1, temperature: '0', ctx: 2048 } },
      metering: { tokenizer: { kind: 'hf-bpe-v1', path: tokenizerPath } },
    };
    vi.useFakeTimers();
    const manager = new SellerConnectorManager(seller, deps);
    manager.boot([config]);
    await vi.waitFor(async () => {
      expect((await manager.status())[0]?.state).toBe('failed');
    });
    const failed = (await manager.status())[0];
    expect(failed).toMatchObject({ kind: 'llamacpp', state: 'failed', modelId: 'qwen2.5-7b', upstreamOrigin: 'http://127.0.0.1:8081' });
    expect(served.at(-1)).toEqual({ offerings: [], unavailable: [offeringIdFor('local-chat')] });

    up = true;
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(async () => {
      expect((await manager.status())[0]?.state).toBe('mounted');
    });
    expect(served.at(-1)).toEqual({ offerings: ['local-chat'], unavailable: [] });
    expect(manager.counts()).toEqual({ mounted: 1, failed: 0, mounting: 0 });
    manager.stop();
  });
});

describe('seller quote for a connector offering that is not mounted', () => {
  it('declines CONNECTOR_UNAVAILABLE (an unknown offering stays UNKNOWN_OFFERING)', async () => {
    const wallet = new ethers.Wallet(ethers.hexlify(randomBytes(32)));
    const seller = new MarketplaceSellerService({
      messenger: { register: () => {}, sendReliable: async () => ({ delivered: false }), sendRequestOwned: async () => ({ delivered: false }) } as never,
      chain: new MockChainAdapter('mock:31337', wallet.address),
      receiptSigner: wallet,
      receiptSignerAddress: wallet.address,
      log,
    });
    const manager = new SellerConnectorManager(seller, { log, queryFn: async () => ({ result: null }) });
    manager.boot([
      { offeringLocalId: 'devnet-llm', serviceType: 'inference', unit: 'token', askPerUnitWei: 1n },
      {
        offeringLocalId: 'devnet-chat', serviceType: 'inference', unit: 'token', modelId: 'stub-chat', askPerUnitWei: 1n,
        connector: { kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', upstreamModel: 'm', secretEnvFile: '/nonexistent/x.env' },
      },
    ]);
    const quote = async (localId: string) => decodeMarketplaceQuoteResponse(
      await seller.handleQuote(encodeMarketplaceQuoteRequest({ offeringId: ethers.getBytes(offeringIdFor(localId)) })),
    );
    await vi.waitFor(() => expect(manager.counts().failed).toBe(1));
    expect(await quote('devnet-chat')).toMatchObject({ available: false, declineCode: 'CONNECTOR_UNAVAILABLE' });
    expect(await quote('never-configured')).toMatchObject({ available: false, declineCode: 'UNKNOWN_OFFERING' });
    expect((await quote('devnet-llm')).available).toBe(true);
    expect(seller.listOfferings().map((o) => o.offeringLocalId)).toEqual(['devnet-llm']);
    manager.stop();
  });
});

function jwt(expSeconds: number): string {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64({ exp: expSeconds })}.sig`;
}

function writeAuth(file: string, accessToken: string, mode = 0o600): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify({ tokens: { access_token: accessToken, refresh_token: 'rt-1', account_id: 'acct-1', id_token: 'idt' } }), { mode });
  chmodSync(file, mode);
}

const sse = (events: unknown[]) => `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`;

describe('codex-oauth connector', () => {
  async function codexUpstream(opts: { failFirstWith401?: boolean; stream?: unknown[] } = {}) {
    let tokenRequests = 0;
    let first = true;
    const server = await upstream(async (req, _body, res) => {
      if (req.url === '/oauth/token') {
        tokenRequests += 1;
        await new Promise((r) => setTimeout(r, 30));
        return json(res, 200, { access_token: jwt(Math.floor(Date.now() / 1000) + 3_600), refresh_token: `rt-${tokenRequests + 1}` });
      }
      if (opts.failFirstWith401 && first) {
        first = false;
        return json(res, 401, { error: { message: `bad token ${String(req.headers.authorization)}` } });
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse(opts.stream ?? [
        { type: 'response.output_text.delta', delta: 'hello ' },
        { type: 'response.output_text.delta', delta: 'world' },
        { type: 'response.completed', response: { usage: { input_tokens: 12, output_tokens: 40 } } },
      ]));
    });
    return { ...server, tokenRequests: () => tokenRequests };
  }

  const codexConfig = (base: string, authFile: string) => ({
    kind: 'codex-oauth' as const, upstreamModel: 'gpt-5-codex', baseUrl: base, authFile, acknowledgeSubscriptionScope: true as const,
  });

  it('accumulates the Responses SSE stream and maps system → developer', async () => {
    const up = await codexUpstream();
    const dir = tmp();
    const authFile = join(dir, '.secrets', 'codex-auth.json');
    writeAuth(authFile, jwt(Math.floor(Date.now() / 1000) + 3_600));
    const connector = await mountChatConnector(codexConfig(up.base, authFile), { log, codexTokenUrl: `${up.base}/oauth/token` });
    const outcome = await connector.complete({ ...request, messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }] });
    expect(outcome).toEqual({ ok: true, content: 'hello world', finishReason: 'stop', providerUsage: { promptTokens: 12, completionTokens: 40 } });
    const sent = JSON.parse(up.requests[0].body) as { input: Array<{ role: string }>; max_output_tokens?: unknown };
    expect(sent.input.map((m) => m.role)).toEqual(['developer', 'user']);
    expect(sent).not.toHaveProperty('max_output_tokens');
    expect(up.requests[0].headers['chatgpt-account-id']).toBe('acct-1');
  });

  it('refreshes once on 401 and rewrites the auth file atomically as 0600 (even over a 0644 file), redacting tokens', async () => {
    const up = await codexUpstream({ failFirstWith401: true });
    const dir = tmp();
    const authFile = join(dir, 'codex-auth.json');
    writeAuth(authFile, jwt(Math.floor(Date.now() / 1000) + 3_600), 0o644);
    const connector = await mountChatConnector(codexConfig(up.base, authFile), { log, codexTokenUrl: `${up.base}/oauth/token` });
    expect(await connector.complete(request)).toMatchObject({ ok: true, content: 'hello world' });
    expect(up.tokenRequests()).toBe(1);
    expect(statSync(authFile).mode & 0o777).toBe(0o600);
    const stored = JSON.parse(readFileSync(authFile, 'utf8')) as { tokens: { refresh_token: string; account_id: string } };
    expect(stored.tokens).toMatchObject({ refresh_token: 'rt-2', account_id: 'acct-1' });
  });

  it('refresh is single-flight: 5 concurrent calls with an expired token make exactly 1 token request', async () => {
    const up = await codexUpstream();
    const dir = tmp();
    const authFile = join(dir, 'codex-auth.json');
    writeAuth(authFile, jwt(Math.floor(Date.now() / 1000) + 60)); // expires within 5 minutes
    const connector = await mountChatConnector(codexConfig(up.base, authFile), { log, codexTokenUrl: `${up.base}/oauth/token` });
    const outcomes = await Promise.all(Array.from({ length: 5 }, () => connector.complete(request)));
    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(up.tokenRequests()).toBe(1);
  });

  it('maps response.failed to UPSTREAM_ERROR and refuses mount without the scope ack or an auth file', async () => {
    const up = await codexUpstream({ stream: [{ type: 'response.failed', response: { error: { code: 'server_error' } } }] });
    const dir = tmp();
    const authFile = join(dir, 'codex-auth.json');
    writeAuth(authFile, jwt(Math.floor(Date.now() / 1000) + 3_600));
    const connector = await mountChatConnector(codexConfig(up.base, authFile), { log });
    expect(await connector.complete(request)).toMatchObject({ ok: false, code: 'UPSTREAM_ERROR' });
    await expect(mountChatConnector({ ...codexConfig(up.base, authFile), acknowledgeSubscriptionScope: false as unknown as true }, { log }))
      .rejects.toMatchObject({ code: 'CONNECTOR_SCOPE' });
    await expect(mountChatConnector(codexConfig(up.base, join(dir, 'none.json')), { log }))
      .rejects.toMatchObject({ code: 'CONNECTOR_AUTH_ABSENT' });
    await expect(mountChatConnector(codexConfig('http://10.1.1.1:9', authFile), { log }))
      .rejects.toMatchObject({ code: 'CONNECTOR_CONFIG' });

    // The offering-level gate: codex needs a non-empty allowedBuyers and the o200k pin.
    const tokenizerPath = join(dir, 'o200k.tiktoken');
    writeFileSync(tokenizerPath, TINY_O200K);
    const offering: MarketplaceOfferingConfig = {
      offeringLocalId: 'codex', serviceType: 'inference', unit: 'token', modelId: 'gpt-5-codex', askPerUnitWei: 1n,
      connector: codexConfig(up.base, authFile), metering: { tokenizer: { kind: 'tiktoken-o200k-v1', path: tokenizerPath } },
    };
    const deps: SellerOfferingDeps = { log, queryFn: async () => ({ result: null }) };
    await expect(mountConnectorOffering(offering, deps)).rejects.toMatchObject({ code: 'CONNECTOR_SCOPE', offeringLocalId: 'codex' });
    const mounted = await mountConnectorOffering({ ...offering, allowedBuyers: ['0x00000000000000000000000000000000000000AA'] }, deps);
    expect(mounted.offering).toMatchObject({ access: 'restricted', toolTransport: 'prompt', metering: { basis: 'pinned' } });
    expect([...mounted.offering.allowedBuyers!]).toEqual(['0x00000000000000000000000000000000000000aa']);
  });
});
