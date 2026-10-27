/**
 * Connector "openai-compatible" — upstream-claimed resale of any OpenAI chat
 * completions API (OpenAI, vLLM, the devnet llm-stub, …). Port of the fork's
 * `connector-openai.ts` with the review fixes:
 *
 *  - the API key is read from the secret env file at CALL time and redacted
 *    from every failure detail (redact the whole body first, then cut);
 *  - sampler fields are sent only when the request carries them (the fork's
 *    forced `temperature: 0` is dropped — reasoning models reject it), and the
 *    max-tokens field name is configurable (`max_completion_tokens`);
 *  - `tool_calls` of absent / null / `[]` means no tool calls (vLLM sends `[]`
 *    on every plain reply); tool fields go upstream only for `native`;
 *  - mount makes NO upstream call: an upstream outage must not unpublish an offer.
 */
import { normalizeToolCalls, type ChatToolCall } from '@origintrail-official/dkg-marketplace';
import {
  classifyStatus,
  classifyTransportError,
  failure,
  parseUpstreamBaseUrl,
  readCappedText,
  redactThenTruncate,
  resolveTimeoutMs,
  upstreamFetch,
  usageCount,
} from './http.js';
import { checkSecretEnvFile, DEFAULT_SECRET_ENV_KEY, readSecretEnvValue } from './secret-env.js';
import type { MarketplaceConnectorConfig } from '../config.js';
import type { ChatConnector, ConnectorChatOutcome, ConnectorChatRequest } from './types.js';
import { MarketplaceConnectorMountError } from './types.js';

type OpenAiCompatibleConfig = Extract<MarketplaceConnectorConfig, { kind: 'openai-compatible' }>;

const DEFAULT_TIMEOUT_MS = 120_000;
const HEALTH_TIMEOUT_MS = 10_000;
const CONTEXT_EXCEEDED_PATTERN = /context_length_exceeded|maximum context length/i;

interface ParsedReply {
  content: string;
  toolCalls?: ChatToolCall[];
  finishReason: string;
  providerUsage?: { promptTokens: number; completionTokens: number };
}

/** Parse an OpenAI chat-completions JSON reply into a connector outcome body, or `{ detail }` on a malformed reply. */
export function parseOpenAiChatReply(text: string): ParsedReply | { detail: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { detail: 'upstream returned a non-JSON body' };
  }
  const choice = (parsed as { choices?: unknown[] } | null)?.choices?.[0] as
    | { message?: { content?: unknown; tool_calls?: unknown }; finish_reason?: unknown }
    | undefined;
  const message = choice?.message;
  if (!message || typeof message !== 'object') return { detail: 'upstream reply has no choices[0].message' };
  const rawContent = message.content;
  if (rawContent !== null && rawContent !== undefined && typeof rawContent !== 'string') {
    return { detail: 'upstream choices[0].message.content is not a string' };
  }
  let toolCalls: ChatToolCall[] | undefined;
  const rawCalls = message.tool_calls;
  if (rawCalls !== undefined && rawCalls !== null && !(Array.isArray(rawCalls) && rawCalls.length === 0)) {
    const normalized = normalizeToolCalls(rawCalls, 'upstream tool_calls');
    if (!normalized.ok) return { detail: normalized.detail };
    toolCalls = normalized.value;
  }
  const usage = (parsed as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } }).usage;
  const promptTokens = usageCount(usage?.prompt_tokens);
  const completionTokens = usageCount(usage?.completion_tokens);
  return {
    content: rawContent ?? '',
    ...(toolCalls ? { toolCalls } : {}),
    finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : 'stop',
    ...(promptTokens !== undefined && completionTokens !== undefined
      ? { providerUsage: { promptTokens, completionTokens } }
      : {}),
  };
}

export function mountOpenAiCompatibleConnector(
  config: OpenAiCompatibleConfig,
  deps: { fetch?: typeof fetch; now?: () => number },
): ChatConnector {
  const label = 'connector(openai-compatible)';
  const { base, origin } = parseUpstreamBaseUrl(config.baseUrl, 'http-or-https', label);
  if (typeof config.upstreamModel !== 'string' || config.upstreamModel.trim() === '' || config.upstreamModel.length > 256) {
    throw new MarketplaceConnectorMountError('CONNECTOR_CONFIG', `${label}.upstreamModel must be a non-empty string`);
  }
  const secretKey = config.secretEnvKey ?? DEFAULT_SECRET_ENV_KEY;
  if (config.secretEnvFile !== undefined) checkSecretEnvFile(config.secretEnvFile, secretKey, label);
  const toolTransport = config.toolTransport ?? 'native';
  if (!['native', 'prompt', 'none'].includes(toolTransport)) {
    throw new MarketplaceConnectorMountError('CONNECTOR_CONFIG', `${label}.toolTransport must be native, prompt or none`);
  }
  const maxTokensField = config.maxTokensField ?? 'max_tokens';
  if (maxTokensField !== 'max_tokens' && maxTokensField !== 'max_completion_tokens') {
    throw new MarketplaceConnectorMountError('CONNECTOR_CONFIG', `${label}.maxTokensField must be max_tokens or max_completion_tokens`);
  }
  if (config.contextLength !== undefined && config.contextLength <= 0n) {
    throw new MarketplaceConnectorMountError('CONNECTOR_CONFIG', `${label}.contextLength must be positive`);
  }
  const timeoutMs = resolveTimeoutMs(config.timeoutMs, DEFAULT_TIMEOUT_MS, label);
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;

  const authHeaders = (): { headers: Record<string, string>; secret?: string } | { error: string } => {
    if (config.secretEnvFile === undefined) return { headers: {} };
    try {
      const secret = readSecretEnvValue(config.secretEnvFile, secretKey);
      return { headers: { authorization: `Bearer ${secret}` }, secret };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'secretEnvFile is unreadable' };
    }
  };

  return {
    description: {
      kind: 'openai-compatible',
      toolTransport,
      provenanceClass: 'upstream-claimed',
      upstreamModel: config.upstreamModel,
      upstreamOrigin: origin,
      ...(config.contextLength !== undefined ? { contextLength: config.contextLength } : {}),
      secretConfigured: config.secretEnvFile !== undefined,
    },

    async complete(request: ConnectorChatRequest): Promise<ConnectorChatOutcome> {
      const auth = authHeaders();
      if ('error' in auth) return failure('UPSTREAM_AUTH', 0, `upstream secret unavailable: ${auth.error}`);
      const native = toolTransport === 'native';
      const body = {
        model: request.upstreamModel,
        messages: request.messages,
        [maxTokensField]: request.maxTokens,
        stream: false,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.topP !== undefined ? { top_p: request.topP } : {}),
        ...(request.seed !== undefined ? { seed: request.seed } : {}),
        ...(request.stop !== undefined ? { stop: request.stop } : {}),
        ...(native && request.tools ? { tools: request.tools } : {}),
        ...(native && request.toolChoice !== undefined ? { tool_choice: request.toolChoice } : {}),
        ...(native && request.parallelToolCalls !== undefined ? { parallel_tool_calls: request.parallelToolCalls } : {}),
      };
      let text: string;
      let status: number;
      try {
        const res = await upstreamFetch(fetchImpl, `${base}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json', ...auth.headers },
          body: JSON.stringify(body),
          timeoutMs,
        });
        status = res.status;
        text = await readCappedText(res);
      } catch (error) {
        return classifyTransportError(error);
      }
      if (status < 200 || status >= 300) {
        const snippet = redactThenTruncate(text, [auth.secret]);
        const code = status === 400 && CONTEXT_EXCEEDED_PATTERN.test(text) ? 'CONTEXT_EXCEEDED' : classifyStatus(status);
        return failure(code, status, `upstream HTTP ${status}: ${snippet}`);
      }
      const reply = parseOpenAiChatReply(text);
      if ('detail' in reply) return failure('UPSTREAM_ERROR', status, reply.detail);
      return { ok: true, ...reply };
    },

    async health() {
      const started = now();
      const auth = authHeaders();
      if ('error' in auth) return { ok: false, latencyMs: 0, detail: `upstream secret unavailable: ${auth.error}` };
      try {
        const res = await upstreamFetch(fetchImpl, `${base}/models`, {
          method: 'GET',
          headers: { accept: 'application/json', ...auth.headers },
          timeoutMs: HEALTH_TIMEOUT_MS,
        });
        const text = await readCappedText(res);
        const latencyMs = Math.max(0, now() - started);
        if (res.ok) return { ok: true, latencyMs };
        return { ok: false, latencyMs, detail: `upstream HTTP ${res.status}: ${redactThenTruncate(text, [auth.secret])}` };
      } catch (error) {
        return { ok: false, latencyMs: Math.max(0, now() - started), detail: classifyTransportError(error).detail };
      }
    },
  };
}
