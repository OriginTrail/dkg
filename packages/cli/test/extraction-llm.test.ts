import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { extractWithLlm } from '../src/extraction/llm-extractor.js';
import { parseNTriples } from '../src/extraction/parse-ntriples.js';
import type { LlmConfig } from '../src/config.js';

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
    expect(result.model).toBe('gpt-4o-mini');
    expect(warnSpy).toHaveBeenCalled();
    const message = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(message).toMatch(/^\[openai\]/m);
  });

  it('default request body matches the pinned OpenAI chat-completions shape', async () => {
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
    expect(result.model).toBe('gpt-4o-mini');
    expect(result.tokensUsed).toBe(7);

    expect(captured.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(captured.init?.method).toBe('POST');
    const headers = captured.init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-test-key');
    expect(headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(String(captured.init?.body));
    expect(body).toEqual({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: body.messages[0].content },
        {
          role: 'user',
          content: 'Document URI: urn:dkg:doc:1\n\n# Doc\n\nHello world.',
        },
      ],
      max_tokens: 4096,
      temperature: 0.1,
    });
    // System prompt: pin load-bearing phrases without snapshotting verbatim.
    expect(body.messages[0].content).toContain('knowledge graph extraction engine');
    expect(body.messages[0].content).toContain('RDF N-Triples');
    expect(body.messages[0].content).toContain('output exactly: NONE');
  });

  it('fail-soft: HTTP 500 returns empty and warns with [openai] prefix', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('upstream boom', { status: 500 })),
    );

    const result = await extractWithLlm(sampleInput, makeConfig());

    expect(result.triples).toEqual([]);
    expect(result.model).toBe('gpt-4o-mini');
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
    expect(result.model).toBe('gpt-4o-mini');
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
    expect(result.model).toBe('gpt-4o-mini');
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
      system: body.system,
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
});
