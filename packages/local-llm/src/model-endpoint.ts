export type LocalModelEndpointProvider = 'openai-models' | 'llama.cpp-health';

export type LocalModelEndpointAvailability =
  | Readonly<{
    status: 'ready';
    reachable: true;
    provider: LocalModelEndpointProvider;
    endpoint: string;
  }>
  | Readonly<{
    status: 'not-ready';
    reachable: true;
    error: string;
  }>
  | Readonly<{
    status: 'offline';
    reachable: false;
    error: string;
  }>;

export interface ProbeLocalModelEndpointOptions {
  chatCompletionsUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

interface LocalModelEndpointUrls {
  readonly models: string;
  readonly health: string;
}

interface ModelListEntry {
  readonly id: string;
  readonly metadataState: 'absent' | 'loading' | 'loaded';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function endpointUrl(
  chatCompletionsUrl: string,
  endpointSuffix: '/v1/models' | '/health',
): string {
  const url = new URL(chatCompletionsUrl);
  const chatSuffix = '/v1/chat/completions';
  const normalizedPath = url.pathname.replace(/\/+$/, '');
  const prefix = normalizedPath.endsWith(chatSuffix)
    ? normalizedPath.slice(0, -chatSuffix.length)
    : '';
  url.pathname = `${prefix}${endpointSuffix}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

/** Derive provider probes while preserving a reverse-proxy path prefix. */
export function localModelEndpointUrls(
  chatCompletionsUrl: string,
): Readonly<LocalModelEndpointUrls> {
  return Object.freeze({
    models: endpointUrl(chatCompletionsUrl, '/v1/models'),
    health: endpointUrl(chatCompletionsUrl, '/health'),
  });
}

function inspectModelList(value: unknown):
  | Readonly<{ status: 'ready' }>
  | Readonly<{ status: 'fallback'; reason: string }> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return Object.freeze({
      status: 'fallback',
      reason: 'OpenAI-compatible models probe returned a non-object response',
    });
  }
  const data = (value as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    return Object.freeze({
      status: 'fallback',
      reason: 'OpenAI-compatible models probe returned no model list',
    });
  }
  const entries = data.flatMap((candidate): ModelListEntry[] => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return [];
    const record = candidate as Record<string, unknown>;
    if (typeof record.id !== 'string' || record.id.trim().length === 0) return [];
    const metadataState = Object.hasOwn(record, 'meta')
      ? record.meta !== null && typeof record.meta === 'object' && !Array.isArray(record.meta)
        ? 'loaded'
        : 'loading'
      : 'absent';
    return [{ id: record.id, metadataState }];
  });
  if (entries.length === 0) {
    return Object.freeze({
      status: 'fallback',
      reason: 'OpenAI-compatible models probe returned no usable model',
    });
  }
  if (entries.some(({ metadataState }) => metadataState !== 'loading')) {
    return Object.freeze({ status: 'ready' });
  }
  return Object.freeze({
    status: 'fallback',
    reason: 'llama.cpp models are still loading',
  });
}

/**
 * Probe an OpenAI-compatible local model server without leaking provider
 * branching into daemon lifecycle code. `/v1/models` is primary for Ollama and
 * loaded llama.cpp models; `/health` remains the bounded llama.cpp fallback.
 */
export async function probeLocalModelEndpoint(
  options: ProbeLocalModelEndpointOptions,
): Promise<LocalModelEndpointAvailability> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 2_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('Local model probe timeout must be a positive integer');
  }
  const urls = localModelEndpointUrls(options.chatCompletionsUrl);
  const attempts: string[] = [];
  let reachable = false;

  try {
    const response = await fetcher(urls.models, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    reachable = true;
    if (response.ok) {
      try {
        const inspection = inspectModelList(await response.json());
        if (inspection.status === 'ready') {
          return Object.freeze({
            status: 'ready',
            reachable: true,
            provider: 'openai-models',
            endpoint: urls.models,
          });
        }
        attempts.push(inspection.reason);
      } catch (error) {
        attempts.push(`OpenAI-compatible models probe returned invalid JSON: ${errorMessage(error)}`);
      }
    } else {
      attempts.push(`OpenAI-compatible models probe returned HTTP ${response.status}`);
    }
  } catch (error) {
    attempts.push(`OpenAI-compatible models probe failed: ${errorMessage(error)}`);
  }

  try {
    const response = await fetcher(urls.health, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    reachable = true;
    if (response.ok) {
      return Object.freeze({
        status: 'ready',
        reachable: true,
        provider: 'llama.cpp-health',
        endpoint: urls.health,
      });
    }
    attempts.push(`llama.cpp health fallback returned HTTP ${response.status}`);
  } catch (error) {
    attempts.push(`llama.cpp health fallback failed: ${errorMessage(error)}`);
  }

  if (reachable) {
    return Object.freeze({
      status: 'not-ready',
      reachable: true,
      error: `Local LLM server is reachable but not ready: ${attempts.join('; ')}`,
    });
  }
  return Object.freeze({
    status: 'offline',
    reachable: false,
    error: `Local LLM server is offline: ${attempts.join('; ')}`,
  });
}
