import { describe, expect, it, vi } from 'vitest';
import { probeLocalModelEndpoint } from '../src/model-endpoint.js';

const DEFAULT_OPTIONS = {
  chatCompletionsUrl: 'http://127.0.0.1:8080/v1/chat/completions',
  model: 'local-model',
} as const;

describe('local model endpoint probing', () => {
  it('probes standard and reverse-proxy-prefixed backend paths privately', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v1/models')) return new Response('not found', { status: 404 });
      return Response.json({ status: 'ok' });
    });

    await expect(probeLocalModelEndpoint({
      ...DEFAULT_OPTIONS,
      chatCompletionsUrl: 'http://127.0.0.1:8080/v1/chat/completions?ignored=yes',
      strategy: { kind: 'llama.cpp' },
      fetch: fetcher as typeof fetch,
    })).resolves.toEqual({ status: 'ready' });
    await expect(probeLocalModelEndpoint({
      ...DEFAULT_OPTIONS,
      chatCompletionsUrl: 'http://localhost:9000/proxy/v1/chat/completions#ignored',
      strategy: { kind: 'llama.cpp' },
      fetch: fetcher as typeof fetch,
    })).resolves.toEqual({ status: 'ready' });

    expect(fetcher.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
      '/v1/models',
      '/health',
      '/proxy/v1/models',
      '/proxy/health',
    ]);
  });

  it('accepts only the configured Ollama model and its :latest alias', async () => {
    const fetcher = vi.fn(async () => Response.json({
      object: 'list',
      data: [{ id: 'qwen3:latest', object: 'model', owned_by: 'library' }],
    }));

    await expect(probeLocalModelEndpoint({
      ...DEFAULT_OPTIONS,
      chatCompletionsUrl: 'http://127.0.0.1:11434/v1/chat/completions',
      model: 'qwen3',
      strategy: { kind: 'ollama' },
      fetch: fetcher as typeof fetch,
    })).resolves.toEqual({ status: 'ready' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('preserves the Ollama model-list contract under the legacy auto strategy', async () => {
    const fetcher = vi.fn(async () => Response.json({
      object: 'list',
      data: [{ id: 'local-model' }],
    }));

    await expect(probeLocalModelEndpoint({
      ...DEFAULT_OPTIONS,
      fetch: fetcher as typeof fetch,
    })).resolves.toEqual({ status: 'ready' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('preserves loaded llama.cpp metadata under the legacy auto strategy', async () => {
    const fetcher = vi.fn(async () => Response.json({
      object: 'list',
      data: [{ id: 'local-model', meta: { n_ctx_train: 32_768 } }],
    }));

    await expect(probeLocalModelEndpoint({
      ...DEFAULT_OPTIONS,
      fetch: fetcher as typeof fetch,
    })).resolves.toEqual({ status: 'ready' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('preserves the llama.cpp health fallback under the legacy auto strategy', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v1/models')) return new Response('not found', { status: 404 });
      return Response.json({ status: 'ok' });
    });

    await expect(probeLocalModelEndpoint({
      ...DEFAULT_OPTIONS,
      fetch: fetcher as typeof fetch,
    })).resolves.toEqual({ status: 'ready' });
    expect(fetcher.mock.calls.map(([input]) => new URL(String(input)).pathname))
      .toEqual(['/v1/models', '/health']);
  });

  it('rejects a non-empty model list that omits the configured model', async () => {
    const fetcher = vi.fn(async () => Response.json({
      object: 'list',
      data: [{ id: 'llama3.2', object: 'model', owned_by: 'library' }],
    }));

    await expect(probeLocalModelEndpoint({
      ...DEFAULT_OPTIONS,
      chatCompletionsUrl: 'http://127.0.0.1:11434/v1/chat/completions',
      model: 'qwen3:8b',
      strategy: { kind: 'ollama' },
      fetch: fetcher as typeof fetch,
    })).resolves.toEqual({
      status: 'not-ready',
      error: expect.stringContaining("Configured model 'qwen3:8b' is not listed"),
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('accepts the configured llama.cpp model only after loaded metadata appears', async () => {
    const fetcher = vi.fn(async () => Response.json({
      object: 'list',
      data: [
        { id: 'other-model', meta: { n_ctx_train: 32_768 } },
        { id: 'local-model', meta: { n_ctx_train: 32_768 } },
      ],
    }));

    await expect(probeLocalModelEndpoint({
      ...DEFAULT_OPTIONS,
      strategy: { kind: 'llama.cpp' },
      fetch: fetcher as typeof fetch,
    })).resolves.toEqual({ status: 'ready' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('keeps a loading llama.cpp model not-ready when health is unavailable', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v1/models')) {
        return Response.json({
          object: 'list',
          data: [{ id: 'local-model', meta: null }],
        });
      }
      return new Response('loading model', { status: 503 });
    });

    await expect(probeLocalModelEndpoint({
      ...DEFAULT_OPTIONS,
      strategy: { kind: 'llama.cpp' },
      fetch: fetcher as typeof fetch,
    })).resolves.toEqual({
      status: 'not-ready',
      error: expect.stringContaining('does not report the configured model as loaded'),
    });
    expect(fetcher.mock.calls.map(([input]) => new URL(String(input)).pathname))
      .toEqual(['/v1/models', '/health']);
  });

  it('accepts a loading llama.cpp model only after strict health becomes ready', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v1/models')) {
        return Response.json({
          object: 'list',
          data: [{ id: 'local-model', meta: null }],
        });
      }
      return Response.json({ status: 'ok' });
    });

    await expect(probeLocalModelEndpoint({
      ...DEFAULT_OPTIONS,
      strategy: { kind: 'llama.cpp' },
      fetch: fetcher as typeof fetch,
    })).resolves.toEqual({ status: 'ready' });
    expect(fetcher.mock.calls.map(([input]) => new URL(String(input)).pathname))
      .toEqual(['/v1/models', '/health']);
  });

  it('uses a strict llama.cpp health response as the legacy fallback', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v1/models')) return new Response('not found', { status: 404 });
      return Response.json({ status: 'ok' });
    });

    await expect(probeLocalModelEndpoint({
      ...DEFAULT_OPTIONS,
      strategy: { kind: 'llama.cpp' },
      fetch: fetcher as typeof fetch,
    })).resolves.toEqual({ status: 'ready' });
  });

  it('does not treat a generic string health status as llama.cpp detection', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v1/models')) return new Response('not found', { status: 404 });
      return Response.json({ status: 'loading' });
    });

    await expect(probeLocalModelEndpoint({
      ...DEFAULT_OPTIONS,
      strategy: { kind: 'llama.cpp' },
      fetch: fetcher as typeof fetch,
    })).resolves.toEqual({
      status: 'incompatible',
      error: expect.stringContaining('No compatible local LLM server was detected'),
    });
  });

  it('recognizes llama.cpp documented 503 response while a model is loading', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v1/models')) return new Response('not found', { status: 404 });
      return Response.json({
        error: { code: 503, message: 'Loading model', type: 'unavailable_error' },
      }, { status: 503 });
    });

    await expect(probeLocalModelEndpoint({
      ...DEFAULT_OPTIONS,
      strategy: { kind: 'llama.cpp' },
      fetch: fetcher as typeof fetch,
    })).resolves.toEqual({
      status: 'not-ready',
      error: expect.stringContaining('Loading model'),
    });
  });

  it('does not treat an arbitrary string health status as llama.cpp detection', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v1/models')) return new Response('not found', { status: 404 });
      return Response.json({ status: 'healthy' });
    });

    await expect(probeLocalModelEndpoint({
      ...DEFAULT_OPTIONS,
      strategy: { kind: 'llama.cpp' },
      fetch: fetcher as typeof fetch,
    })).resolves.toEqual({
      status: 'incompatible',
      error: expect.stringContaining('No compatible local LLM server was detected'),
    });
  });

  it('classifies an invalid health response as an incompatible HTTP service', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v1/models')) return new Response('not found', { status: 404 });
      return new Response('<html>ok</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    });

    await expect(probeLocalModelEndpoint({
      ...DEFAULT_OPTIONS,
      strategy: { kind: 'llama.cpp' },
      fetch: fetcher as typeof fetch,
    })).resolves.toEqual({
      status: 'incompatible',
      error: expect.stringContaining('No compatible local LLM server was detected'),
    });
  });

  it('does not detect an unrelated HTTP service that returns 404 for both probes', async () => {
    const fetcher = vi.fn(async () => new Response('not found', { status: 404 }));

    await expect(probeLocalModelEndpoint({
      ...DEFAULT_OPTIONS,
      fetch: fetcher as typeof fetch,
    })).resolves.toEqual({
      status: 'incompatible',
      error: expect.stringContaining('No compatible local LLM server was detected'),
    });
    expect(fetcher.mock.calls.map(([input]) => new URL(String(input)).pathname))
      .toEqual(['/v1/models', '/health']);
  });

  it('returns structured offline availability for a malformed endpoint URL', async () => {
    const fetcher = vi.fn();
    await expect(probeLocalModelEndpoint({
      ...DEFAULT_OPTIONS,
      chatCompletionsUrl: 'not-a-url',
      fetch: fetcher as typeof fetch,
    })).resolves.toEqual({
      status: 'offline',
      error: expect.stringContaining('endpoint configuration is invalid'),
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reports offline only when neither probe reaches the server', async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });

    await expect(probeLocalModelEndpoint({
      ...DEFAULT_OPTIONS,
      fetch: fetcher as typeof fetch,
    })).resolves.toEqual({
      status: 'offline',
      error: expect.stringContaining('Local LLM server is offline'),
    });
  });
});
