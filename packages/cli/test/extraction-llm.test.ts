import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { extractWithLlm } from '../src/extraction/llm-extractor.js';
import { parseNTriples } from '../src/extraction/parse-ntriples.js';
import { DOCUMENT_KG_PROMPT } from '../src/extraction/llm-provider.js';
import { openaiProvider } from '../src/extraction/providers/openai.js';
import { anthropicProvider } from '../src/extraction/providers/anthropic.js';
import type { LlmConfig } from '../src/config.js';

describe('LlmProvider — DEFAULT_MODEL on the interface', () => {
  it('each provider exposes its DEFAULT_MODEL via the LlmProvider interface', () => {
    expect(openaiProvider.defaultModel).toBe('gpt-5-nano');
    expect(anthropicProvider.defaultModel).toBe('claude-sonnet-4-6');
  });
});

function makeConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    apiKey: 'sk-test-key',
    ...overrides,
  };
}

const sampleInput = {
  markdown: '# Doc\n\nHello world.',
  agentDid: 'did:example:agent',
  documentIri: 'urn:dkg:doc:1',
};

describe('extractWithLlm — OpenAI provider', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    warnSpy.mockRestore();
  });

  it('fail-soft: missing apiKey returns empty and warns with [openai] prefix', async () => {
    const result = await extractWithLlm(sampleInput, makeConfig({ apiKey: '' }));
    expect(result.triples).toEqual([]);
    expect(result.model).toBe('gpt-5-nano');
    expect(warnSpy).toHaveBeenCalled();
    const message = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(message).toMatch(/^\[openai\]/m);
  });

  it('default (reasoning-model) request body matches the pinned OpenAI chat-completions shape', async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        captured.url = String(url);
        captured.init = init;
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: 'NONE' } }],
            usage: { total_tokens: 7 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );

    const result = await extractWithLlm(sampleInput, makeConfig());

    expect(result.triples).toEqual([]);
    expect(result.model).toBe('gpt-5-nano');
    expect(result.tokensUsed).toBe(7);

    expect(captured.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(captured.init?.method).toBe('POST');
    const headers = captured.init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-test-key');
    expect(headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(String(captured.init?.body));
    expect(body).toEqual({
      model: 'gpt-5-nano',
      messages: [
        { role: 'system', content: DOCUMENT_KG_PROMPT },
        {
          role: 'user',
          content: 'Document URI: urn:dkg:doc:1\n\n# Doc\n\nHello world.',
        },
      ],
      max_completion_tokens: 16000,
      reasoning_effort: 'low',
    });
    // Pin: reasoning-model body MUST NOT include the legacy keys.
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('temperature');
    // System prompt: pin load-bearing phrases without snapshotting verbatim.
    expect(body.messages[0].content).toContain('knowledge graph extraction engine');
    expect(body.messages[0].content).toContain('RDF N-Triples');
    expect(body.messages[0].content).toContain('output exactly: NONE');
  });

  it('reasoning-model honors caller-supplied maxTokens override for max_completion_tokens', async () => {
    const captured: { init?: RequestInit } = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        captured.init = init;
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: 'NONE' } }],
            usage: { total_tokens: 5 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );

    const result = await extractWithLlm(
      { ...sampleInput, maxTokens: 8192 },
      makeConfig({ provider: 'openai' }),
    );

    expect(result.model).toBe('gpt-5-nano');
    const body = JSON.parse(String(captured.init?.body));
    expect(body.max_completion_tokens).toBe(8192);
    expect(body.reasoning_effort).toBe('low');
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('temperature');
  });

  it('legacy chat-completions model (gpt-4o-mini) keeps max_tokens + temperature shape', async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        captured.url = String(url);
        captured.init = init;
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: 'NONE' } }],
            usage: { total_tokens: 9 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );

    const result = await extractWithLlm(
      sampleInput,
      makeConfig({ model: 'gpt-4o-mini' }),
    );

    expect(result.triples).toEqual([]);
    expect(result.model).toBe('gpt-4o-mini');
    expect(result.tokensUsed).toBe(9);

    const body = JSON.parse(String(captured.init?.body));
    expect(body).toEqual({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: DOCUMENT_KG_PROMPT },
        {
          role: 'user',
          content: 'Document URI: urn:dkg:doc:1\n\n# Doc\n\nHello world.',
        },
      ],
      max_tokens: 4096,
      temperature: 0.1,
    });
    // Pin: legacy body MUST NOT have any reasoning-model keys.
    expect(body).not.toHaveProperty('max_completion_tokens');
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('fail-soft: HTTP 500 returns empty and warns with [openai] prefix', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('upstream boom', { status: 500 })),
    );

    const result = await extractWithLlm(sampleInput, makeConfig());

    expect(result.triples).toEqual([]);
    expect(result.model).toBe('gpt-5-nano');
    const message = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(message).toMatch(/^\[openai\]/m);
    expect(message).toContain('500');
  });

  it('fail-soft: AbortError returns empty and warns with [openai] prefix', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }),
    );

    const result = await extractWithLlm(sampleInput, makeConfig());

    expect(result.triples).toEqual([]);
    expect(result.model).toBe('gpt-5-nano');
    const message = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(message).toMatch(/^\[openai\]/m);
    expect(message).toMatch(/time(d)? ?out|abort/i);
  });

  it('fail-soft: malformed JSON body returns empty and warns with [openai] prefix', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not json at all', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })),
    );

    const result = await extractWithLlm(sampleInput, makeConfig());

    expect(result.triples).toEqual([]);
    expect(result.model).toBe('gpt-5-nano');
    const message = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(message).toMatch(/^\[openai\]/m);
  });
});

describe('parseNTriples — shared module', () => {
  it('parses URI and literal objects, tolerates markdown fences and comments', () => {
    const raw = [
      '```turtle',
      '<urn:dkg:doc:1> <http://schema.org/name> "Alpha" .',
      '# this is a comment',
      '<urn:dkg:doc:1> <http://schema.org/about> <urn:dkg:entity:topic-x> .',
      '<urn:dkg:doc:1> <http://schema.org/description> "Multi\\nline literal"@en .',
      '',
      '```',
    ].join('\n');

    const triples = parseNTriples(raw, 'urn:dkg:doc:1');

    expect(triples).toEqual([
      { subject: 'urn:dkg:doc:1', predicate: 'http://schema.org/name', object: '"Alpha"' },
      { subject: 'urn:dkg:doc:1', predicate: 'http://schema.org/about', object: 'urn:dkg:entity:topic-x' },
      {
        subject: 'urn:dkg:doc:1',
        predicate: 'http://schema.org/description',
        object: '"Multi\\nline literal"@en',
      },
    ]);
  });
});

describe('extractWithLlm — Anthropic provider', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    warnSpy.mockRestore();
  });

  it('happy path: returns parsed triples from /v1/messages 200 with content[0].text', async () => {
    const rawNT = [
      '<urn:dkg:doc:1> <http://schema.org/name> "Alpha" .',
      '<urn:dkg:doc:1> <http://schema.org/about> <urn:dkg:entity:topic-x> .',
    ].join('\n');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            content: [{ type: 'text', text: rawNT }],
            usage: { input_tokens: 11, output_tokens: 22 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    const result = await extractWithLlm(sampleInput, makeConfig({ provider: 'anthropic' }));

    expect(result.model).toBe('claude-sonnet-4-6');
    expect(result.tokensUsed).toBe(33);
    expect(result.triples).toEqual([
      { subject: 'urn:dkg:doc:1', predicate: 'http://schema.org/name', object: '"Alpha"' },
      { subject: 'urn:dkg:doc:1', predicate: 'http://schema.org/about', object: 'urn:dkg:entity:topic-x' },
    ]);
  });

  it('concatenates multiple text blocks and skips non-text blocks', async () => {
    // Anthropic Messages API returns `content` as an array of typed blocks.
    // A response can include thinking/tool_use blocks before/between text
    // blocks, or simply split N-Triples across multiple text blocks.
    // parseResponse MUST concatenate all `type === 'text'` blocks and skip
    // any non-text block (rather than reading only `content[0].text`).
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            content: [
              { type: 'thinking', thinking: 'meta-reasoning' },
              { type: 'text', text: '<urn:dkg:doc:1> <http://schema.org/name> "Alpha" .' },
              { type: 'text', text: '<urn:dkg:doc:1> <http://schema.org/about> <urn:dkg:entity:topic-x> .' },
            ],
            usage: { input_tokens: 5, output_tokens: 10 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    const result = await extractWithLlm(sampleInput, makeConfig({ provider: 'anthropic' }));

    expect(result.triples).toEqual([
      { subject: 'urn:dkg:doc:1', predicate: 'http://schema.org/name', object: '"Alpha"' },
      { subject: 'urn:dkg:doc:1', predicate: 'http://schema.org/about', object: 'urn:dkg:entity:topic-x' },
    ]);
    expect(result.model).toBe('claude-sonnet-4-6');
    expect(result.tokensUsed).toBe(15);
  });

  it('default request body matches the pinned Anthropic /v1/messages shape', async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        captured.url = String(url);
        captured.init = init;
        return new Response(
          JSON.stringify({
            content: [{ type: 'text', text: 'NONE' }],
            usage: { input_tokens: 3, output_tokens: 4 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );

    const result = await extractWithLlm(sampleInput, makeConfig({ provider: 'anthropic' }));

    expect(result.triples).toEqual([]);
    expect(result.model).toBe('claude-sonnet-4-6');
    expect(result.tokensUsed).toBe(7);

    expect(captured.url).toBe('https://api.anthropic.com/v1/messages');
    expect(captured.init?.method).toBe('POST');
    const headers = captured.init?.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-test-key');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(String(captured.init?.body));
    expect(body).toEqual({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: DOCUMENT_KG_PROMPT,
      messages: [
        {
          role: 'user',
          content: 'Document URI: urn:dkg:doc:1\n\n# Doc\n\nHello world.',
        },
      ],
    });
    // Pin: no temperature field on Anthropic requests.
    expect(body).not.toHaveProperty('temperature');
    // System prompt: pin load-bearing phrases without snapshotting verbatim.
    expect(body.system).toContain('knowledge graph extraction engine');
    expect(body.system).toContain('RDF N-Triples');
    expect(body.system).toContain('output exactly: NONE');
  });

  it('fail-soft: missing apiKey returns empty and warns with [anthropic] prefix', async () => {
    const result = await extractWithLlm(
      sampleInput,
      makeConfig({ provider: 'anthropic', apiKey: '' }),
    );
    expect(result.triples).toEqual([]);
    expect(result.model).toBe('claude-sonnet-4-6');
    const message = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(message).toMatch(/^\[anthropic\]/m);
  });

  it('fail-soft: HTTP 500 returns empty and warns with [anthropic] prefix', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('upstream boom', { status: 500 })),
    );

    const result = await extractWithLlm(
      sampleInput,
      makeConfig({ provider: 'anthropic' }),
    );

    expect(result.triples).toEqual([]);
    expect(result.model).toBe('claude-sonnet-4-6');
    const message = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(message).toMatch(/^\[anthropic\]/m);
    expect(message).toContain('500');
  });

  it('fail-soft: AbortError returns empty and warns with [anthropic] prefix', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }),
    );

    const result = await extractWithLlm(
      sampleInput,
      makeConfig({ provider: 'anthropic' }),
    );

    expect(result.triples).toEqual([]);
    expect(result.model).toBe('claude-sonnet-4-6');
    const message = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(message).toMatch(/^\[anthropic\]/m);
    expect(message).toMatch(/time(d)? ?out|abort/i);
  });

  it('fail-soft: malformed JSON body returns empty and warns with [anthropic] prefix', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not json at all', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })),
    );

    const result = await extractWithLlm(
      sampleInput,
      makeConfig({ provider: 'anthropic' }),
    );

    expect(result.triples).toEqual([]);
    expect(result.model).toBe('claude-sonnet-4-6');
    const message = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(message).toMatch(/^\[anthropic\]/m);
  });
});

describe('extractWithLlm — provider selection', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    warnSpy.mockRestore();
  });

  it('DKG_EXTRACTION_PROVIDER env var overrides LlmConfig.provider', async () => {
    const captured: { url?: string } = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        captured.url = String(url);
        return new Response(
          JSON.stringify({
            content: [{ type: 'text', text: 'NONE' }],
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    vi.stubEnv('DKG_EXTRACTION_PROVIDER', 'anthropic');

    const result = await extractWithLlm(
      sampleInput,
      makeConfig({ provider: 'openai' }),
    );

    // Routed to Anthropic despite config.provider === 'openai'
    expect(captured.url).toBe('https://api.anthropic.com/v1/messages');
    expect(result.model).toBe('claude-sonnet-4-6');
  });

  it('DKG_EXTRACTION_PROVIDER env override drops per-provider model and baseURL', async () => {
    // Operator has OpenAI configured end-to-end (provider + model + baseURL),
    // but DKG_EXTRACTION_PROVIDER=anthropic flips the dispatcher. The
    // OpenAI-specific model + baseURL must NOT leak into the Anthropic
    // request; each provider should use its own defaults.
    const captured: { url?: string; init?: RequestInit } = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        captured.url = String(url);
        captured.init = init;
        return new Response(
          JSON.stringify({
            content: [{ type: 'text', text: 'NONE' }],
            usage: { input_tokens: 2, output_tokens: 3 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    vi.stubEnv('DKG_EXTRACTION_PROVIDER', 'anthropic');

    const result = await extractWithLlm(
      sampleInput,
      makeConfig({
        provider: 'openai',
        model: 'gpt-5-nano',
        baseURL: 'https://api.openai.com/v1',
      }),
    );

    expect(captured.url).toBe('https://api.anthropic.com/v1/messages');
    const body = JSON.parse(String(captured.init?.body));
    expect(body.model).toBe('claude-sonnet-4-6');
    expect(result.model).toBe('claude-sonnet-4-6');
  });

  it('shared-parser parity: identical raw N-Triples yields deep-equal triples from both providers', async () => {
    const rawNT = [
      '<urn:dkg:doc:1> <http://schema.org/name> "Parity Doc" .',
      '<urn:dkg:doc:1> <http://schema.org/author> <urn:dkg:entity:alice> .',
      '<urn:dkg:doc:1> <http://schema.org/datePublished> "2024-01-15" .',
      '<urn:dkg:entity:alice> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://schema.org/Person> .',
      '<urn:dkg:entity:alice> <http://schema.org/name> "Alice"@en .',
      '<urn:dkg:doc:1> <http://schema.org/about> <urn:dkg:entity:topic-x> .',
    ].join('\n');

    // Run via OpenAI response shape.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: rawNT } }],
            usage: { total_tokens: 50 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const openaiResult = await extractWithLlm(sampleInput, makeConfig({ provider: 'openai' }));

    // Reset and run via Anthropic response shape with identical raw text.
    vi.unstubAllGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            content: [{ type: 'text', text: rawNT }],
            usage: { input_tokens: 20, output_tokens: 30 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const anthropicResult = await extractWithLlm(sampleInput, makeConfig({ provider: 'anthropic' }));

    expect(openaiResult.triples).toEqual(anthropicResult.triples);
    expect(openaiResult.triples).toHaveLength(6);
  });

  it('unknown provider value warns and falls back to OpenAI', async () => {
    const captured: { url?: string } = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        captured.url = String(url);
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: 'NONE' } }],
            usage: { total_tokens: 2 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    vi.stubEnv('DKG_EXTRACTION_PROVIDER', 'mystery-vendor');

    const result = await extractWithLlm(sampleInput, makeConfig());

    expect(captured.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(result.model).toBe('gpt-5-nano');
    const message = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(message).toMatch(/Unknown provider "mystery-vendor"/);
    expect(message).toMatch(/falling back to openai/);
  });
});
