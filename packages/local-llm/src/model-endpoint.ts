export type LocalModelEndpointProbeStrategy =
  | Readonly<{ kind: 'auto' }>
  | Readonly<{ kind: 'ollama' }>
  | Readonly<{ kind: 'llama.cpp' }>;

export type LocalModelEndpointAvailability =
  | Readonly<{
    status: 'ready';
    reachable: true;
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
  model: string;
  strategy?: LocalModelEndpointProbeStrategy;
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

type ModelListInspection =
  | Readonly<{ status: 'ready' }>
  | Readonly<{ status: 'fallback'; reason: string }>
  | Readonly<{ status: 'not-ready'; reason: string }>;

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

function localModelEndpointUrls(chatCompletionsUrl: string): LocalModelEndpointUrls {
  return {
    models: endpointUrl(chatCompletionsUrl, '/v1/models'),
    health: endpointUrl(chatCompletionsUrl, '/health'),
  };
}

function canonicalModelId(value: string): string {
  return value.trim().toLowerCase().replace(/:latest$/, '');
}

function modelIdsMatch(configured: string, listed: string): boolean {
  return canonicalModelId(configured) === canonicalModelId(listed);
}

function parseModelList(value: unknown): ModelListEntry[] | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const data = (value as { data?: unknown }).data;
  if (!Array.isArray(data)) return undefined;
  return data.flatMap((candidate): ModelListEntry[] => {
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
}

function inspectModelList(
  value: unknown,
  configuredModel: string,
  strategy: LocalModelEndpointProbeStrategy,
): ModelListInspection {
  const entries = parseModelList(value);
  if (!entries) {
    return {
      status: 'not-ready',
      reason: 'OpenAI-compatible models probe returned no valid model list',
    };
  }
  const matching = entries.filter(({ id }) => modelIdsMatch(configuredModel, id));
  if (matching.length === 0) {
    return {
      status: 'not-ready',
      reason: `Configured model '${configuredModel}' is not listed by the local endpoint`,
    };
  }

  if (strategy.kind === 'ollama') return { status: 'ready' };
  if (strategy.kind === 'llama.cpp') {
    return matching.some(({ metadataState }) => metadataState === 'loaded')
      ? { status: 'ready' }
      : {
        status: 'fallback',
        reason: 'llama.cpp model metadata does not report the configured model as loaded',
      };
  }

  // Auto preserves the provider-neutral model-list contract while recognizing
  // llama.cpp's explicit loading marker. Callers that know the backend can
  // select a strategy and avoid response-shape provider detection entirely.
  return matching.some(({ metadataState }) => metadataState !== 'loading')
    ? { status: 'ready' }
    : { status: 'fallback', reason: 'llama.cpp model is still loading' };
}

function offline(error: string): LocalModelEndpointAvailability {
  return Object.freeze({ status: 'offline', reachable: false, error });
}

function notReady(attempts: readonly string[]): LocalModelEndpointAvailability {
  return Object.freeze({
    status: 'not-ready',
    reachable: true,
    error: `Local LLM server is reachable but not ready: ${attempts.join('; ')}`,
  });
}

/**
 * Probe the exact configured model through an explicit backend strategy.
 * `auto` preserves legacy llama.cpp and Ollama configuration; callers that know
 * their backend can select its strategy without exposing endpoint details.
 */
export async function probeLocalModelEndpoint(
  options: ProbeLocalModelEndpointOptions,
): Promise<LocalModelEndpointAvailability> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 2_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('Local model probe timeout must be a positive integer');
  }
  const configuredModel = options.model.trim();
  if (!configuredModel) {
    return offline('Local LLM endpoint configuration is invalid: model must be non-empty');
  }
  const strategy = options.strategy ?? { kind: 'auto' };
  let urls: LocalModelEndpointUrls;
  try {
    urls = localModelEndpointUrls(options.chatCompletionsUrl);
  } catch (error) {
    return offline(`Local LLM endpoint configuration is invalid: ${errorMessage(error)}`);
  }

  const attempts: string[] = [];
  let reachable = false;
  let useHealthFallback = strategy.kind !== 'ollama';

  try {
    const response = await fetcher(urls.models, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    reachable = true;
    if (response.ok) {
      try {
        const inspection = inspectModelList(await response.json(), configuredModel, strategy);
        if (inspection.status === 'ready') {
          return Object.freeze({ status: 'ready', reachable: true });
        }
        attempts.push(inspection.reason);
        if (inspection.status === 'not-ready') return notReady(attempts);
      } catch (error) {
        attempts.push(`OpenAI-compatible models probe returned invalid JSON: ${errorMessage(error)}`);
        return notReady(attempts);
      }
    } else {
      attempts.push(`OpenAI-compatible models probe returned HTTP ${response.status}`);
      useHealthFallback = useHealthFallback && [404, 405, 501].includes(response.status);
    }
  } catch (error) {
    attempts.push(`OpenAI-compatible models probe failed: ${errorMessage(error)}`);
  }

  if (!useHealthFallback) {
    return reachable ? notReady(attempts) : offline(`Local LLM server is offline: ${attempts.join('; ')}`);
  }

  try {
    const response = await fetcher(urls.health, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    reachable = true;
    if (response.ok) {
      try {
        const payload = await response.json() as { status?: unknown };
        if (
          typeof payload === 'object'
          && payload !== null
          && !Array.isArray(payload)
          && payload.status === 'ok'
        ) {
          return Object.freeze({ status: 'ready', reachable: true });
        }
        attempts.push('llama.cpp health fallback did not return {"status":"ok"}');
      } catch (error) {
        attempts.push(`llama.cpp health fallback returned invalid JSON: ${errorMessage(error)}`);
      }
    } else {
      attempts.push(`llama.cpp health fallback returned HTTP ${response.status}`);
    }
  } catch (error) {
    attempts.push(`llama.cpp health fallback failed: ${errorMessage(error)}`);
  }

  return reachable
    ? notReady(attempts)
    : offline(`Local LLM server is offline: ${attempts.join('; ')}`);
}
