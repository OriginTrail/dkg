import { describe, expect, it, vi } from 'vitest';
import {
  localModelEndpointUrls,
  probeLocalModelEndpoint,
} from '../src/model-endpoint.js';

describe('local model endpoint probing', () => {
  it('derives standard and reverse-proxy-prefixed probe URLs', () => {
    expect(localModelEndpointUrls(
      'http://127.0.0.1:11434/v1/chat/completions?token=ignored#fragment',
    )).toEqual({
      models: 'http://127.0.0.1:11434/v1/models',
      health: 'http://127.0.0.1:11434/health',
    });
    expect(localModelEndpointUrls(
      'http://localhost:9000/proxy/v1/chat/completions?token=ignored',
    )).toEqual({
      models: 'http://localhost:9000/proxy/v1/models',
      health: 'http://localhost:9000/proxy/health',
    });
  });

  it('accepts an Ollama-compatible non-empty model list without probing health', async () => {
    const fetcher = vi.fn(async () => Response.json({
      object: 'list',
      data: [{ id: 'qwen3:8b', object: 'model', owned_by: 'library' }],
    }));

    await expect(probeLocalModelEndpoint({
      chatCompletionsUrl: 'http://127.0.0.1:11434/v1/chat/completions',
      fetch: fetcher as typeof fetch,
    })).resolves.toEqual({
      status: 'ready',
      reachable: true,
      provider: 'openai-models',
      endpoint: 'http://127.0.0.1:11434/v1/models',
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('accepts llama.cpp model metadata only after it is loaded', async () => {
    const fetcher = vi.fn(async () => Response.json({
      object: 'list',
      data: [{ id: 'local-model', meta: { n_ctx_train: 32_768 } }],
    }));

    await expect(probeLocalModelEndpoint({
      chatCompletionsUrl: 'http://127.0.0.1:8080/v1/chat/completions',
      fetch: fetcher as typeof fetch,
    })).resolves.toMatchObject({
      status: 'ready',
      provider: 'openai-models',
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('keeps a loading llama.cpp server not-ready when health is unavailable', async () => {
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
      chatCompletionsUrl: 'http://127.0.0.1:8080/v1/chat/completions',
      fetch: fetcher as typeof fetch,
    })).resolves.toEqual({
      status: 'not-ready',
      reachable: true,
      error: expect.stringContaining('llama.cpp models are still loading'),
    });
    expect(fetcher.mock.calls.map(([input]) => new URL(String(input)).pathname))
      .toEqual(['/v1/models', '/health']);
  });

  it('uses llama.cpp health as a fallback for a loading model list', async () => {
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
      chatCompletionsUrl: 'http://127.0.0.1:8080/v1/chat/completions',
      fetch: fetcher as typeof fetch,
    })).resolves.toEqual({
      status: 'ready',
      reachable: true,
      provider: 'llama.cpp-health',
      endpoint: 'http://127.0.0.1:8080/health',
    });
  });

  it('reports offline only when neither probe reaches the server', async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });

    await expect(probeLocalModelEndpoint({
      chatCompletionsUrl: 'http://127.0.0.1:8080/v1/chat/completions',
      fetch: fetcher as typeof fetch,
    })).resolves.toEqual({
      status: 'offline',
      reachable: false,
      error: expect.stringContaining('Local LLM server is offline'),
    });
  });
});
