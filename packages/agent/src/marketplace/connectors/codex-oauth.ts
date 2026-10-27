/**
 * Connector "codex-oauth" — upstream-claimed resale of the operator's OWN
 * Codex subscription over OAuth (port of the fork's `connector-codex-oauth.ts`).
 *
 * SCOPE: reselling a personal subscription to third parties breaches upstream
 * terms, so a codex-oauth offering needs `acknowledgeSubscriptionScope: true`,
 * a non-empty `allowedBuyers` (other buyers are refused `BUYER_NOT_ALLOWED`)
 * and publishes `mkt:access "restricted"` — enforced at mount.
 *
 * Credentials live only in the auth file (`{ tokens: { access_token,
 * refresh_token, account_id, id_token }, last_refresh }`, 0600 under a 0700
 * `.secrets/`), read at call time. The connector refreshes proactively when
 * the access-token JWT expires within 5 minutes and once on an upstream
 * 401/403. Refresh is SINGLE-FLIGHT per auth file: refresh tokens rotate
 * (single use), so two parallel refreshes would burn the token family. The
 * refreshed store is written back atomically (0600). Failure details redact
 * every token value before truncation.
 *
 * Metering never trusts upstream usage (reasoning tokens are invisible in the
 * delivered bytes): the executor counts the delivered text with the pinned
 * `tiktoken-o200k-v1` engine and bounds it with `boundCompletion` — the
 * backend rejects `max_output_tokens`, so none is sent.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { writeFileAtomic0600 } from '../atomic-file.js';
import type { MarketplaceConnectorConfig } from '../config.js';
import { CODEX_DEFAULT_BASE, CODEX_OAUTH_CLIENT_ID, CODEX_TOKEN_URL, defaultCodexAuthFile } from './codex-constants.js';
import {
  classifyStatus,
  classifyTransportError,
  failure,
  parseUpstreamBaseUrl,
  readCappedText,
  redactThenTruncate,
  resolveTimeoutMs,
  upstreamFetch,
  UPSTREAM_BODY_CAP_BYTES,
} from './http.js';
import type { ChatConnector, ConnectorChatOutcome, ConnectorChatRequest } from './types.js';
import { MarketplaceConnectorMountError } from './types.js';

type CodexConfig = Extract<MarketplaceConnectorConfig, { kind: 'codex-oauth' }>;

const DEFAULT_TIMEOUT_MS = 180_000;
const REFRESH_TIMEOUT_MS = 30_000;
const REFRESH_AHEAD_MS = 300_000;
const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const;

interface CodexTokens {
  access_token: string;
  refresh_token: string;
  account_id: string;
  id_token?: string;
}

interface AuthStore {
  tokens: CodexTokens;
  last_refresh?: string;
  [key: string]: unknown;
}

/** Read + shape-check the auth store. Errors never quote file content. */
function readAuth(authFile: string): AuthStore {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(authFile, 'utf8'));
  } catch {
    throw new Error(`auth file ${authFile} is missing or not JSON (run the codex-oauth login)`);
  }
  const tokens = (parsed as { tokens?: Record<string, unknown> } | null)?.tokens;
  const str = (v: unknown) => typeof v === 'string' && v.length > 0;
  if (!tokens || !str(tokens.access_token) || !str(tokens.refresh_token) || !str(tokens.account_id)) {
    throw new Error(`auth file ${authFile} holds no subscription tokens (access_token, refresh_token, account_id)`);
  }
  return parsed as AuthStore;
}

function tokenValues(auth: AuthStore | undefined): string[] {
  if (!auth) return [];
  const { access_token, refresh_token, account_id, id_token } = auth.tokens;
  return [access_token, refresh_token, account_id, id_token].filter((v): v is string => typeof v === 'string');
}

/** JWT `exp` (seconds) without verification — a freshness heuristic only. */
function jwtExp(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

/** In-process single-flight refresh per auth file. */
const refreshInFlight = new Map<string, Promise<AuthStore>>();

interface RefreshDeps {
  fetchImpl: typeof fetch;
  tokenUrl: string;
  now: () => number;
}

async function performRefresh(authFile: string, deps: RefreshDeps): Promise<AuthStore> {
  const current = readAuth(authFile);
  const res = await upstreamFetch(deps.fetchImpl, deps.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: CODEX_OAUTH_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: current.tokens.refresh_token,
      scope: 'openid profile email',
    }),
    timeoutMs: REFRESH_TIMEOUT_MS,
  });
  const text = await readCappedText(res);
  if (!res.ok) throw new Error(`token refresh answered HTTP ${res.status}`);
  let fresh: { access_token?: unknown; refresh_token?: unknown; id_token?: unknown };
  try {
    fresh = JSON.parse(text) as typeof fresh;
  } catch {
    throw new Error('token refresh answered a non-JSON body');
  }
  if (typeof fresh.access_token !== 'string' || fresh.access_token.length === 0) {
    throw new Error('token refresh returned no access_token');
  }
  const updated: AuthStore = {
    ...current,
    tokens: {
      ...current.tokens,
      access_token: fresh.access_token,
      ...(typeof fresh.refresh_token === 'string' && fresh.refresh_token ? { refresh_token: fresh.refresh_token } : {}),
      ...(typeof fresh.id_token === 'string' && fresh.id_token ? { id_token: fresh.id_token } : {}),
    },
    last_refresh: new Date(deps.now()).toISOString(),
  };
  writeFileAtomic0600(authFile, `${JSON.stringify(updated, null, 2)}\n`, { dirMode: 0o700 });
  return updated;
}

/**
 * Refresh unless another caller already did: when the file's access token
 * is no longer the one this caller used, the rotation happened elsewhere and
 * the stored tokens are returned as is. Concurrent refreshes share one promise.
 */
async function refreshOnce(authFile: string, usedAccessToken: string | undefined, deps: RefreshDeps): Promise<AuthStore> {
  const pending = refreshInFlight.get(authFile);
  if (pending) return pending;
  const onDisk = readAuth(authFile);
  if (usedAccessToken !== undefined && onDisk.tokens.access_token !== usedAccessToken) return onDisk;
  const promise = performRefresh(authFile, deps).finally(() => refreshInFlight.delete(authFile));
  refreshInFlight.set(authFile, promise);
  return promise;
}

async function freshAuth(authFile: string, deps: RefreshDeps): Promise<AuthStore> {
  const pending = refreshInFlight.get(authFile);
  if (pending) return pending;
  const auth = readAuth(authFile);
  const exp = jwtExp(auth.tokens.access_token);
  if (exp !== null && exp * 1000 < deps.now() + REFRESH_AHEAD_MS) return refreshOnce(authFile, auth.tokens.access_token, deps);
  return auth;
}

interface StreamAccumulation {
  text: string;
  finishReason: string;
  usage?: { promptTokens: number; completionTokens: number };
  failed?: string;
}

function applyEvent(acc: StreamAccumulation, event: Record<string, unknown>): void {
  const type = String(event.type ?? '');
  if (type === 'response.output_text.delta' && typeof event.delta === 'string') acc.text += event.delta;
  if (type === 'response.completed' || type === 'response.incomplete') {
    const response = event.response as {
      usage?: { input_tokens?: unknown; output_tokens?: unknown };
      output?: Array<{ content?: Array<{ type?: unknown; text?: unknown }> }>;
    } | undefined;
    const input = response?.usage?.input_tokens;
    const output = response?.usage?.output_tokens;
    if (typeof input === 'number' && typeof output === 'number' && Number.isSafeInteger(input) && Number.isSafeInteger(output)
      && input >= 0 && output >= 0) {
      acc.usage = { promptTokens: input, completionTokens: output };
    }
    if (type === 'response.incomplete') acc.finishReason = 'length';
    if (!acc.text && Array.isArray(response?.output)) {
      for (const item of response.output) {
        for (const part of item.content ?? []) {
          if (part.type === 'output_text' && typeof part.text === 'string') acc.text += part.text;
        }
      }
    }
  }
  if (type === 'response.failed') {
    const error = (event.response as { error?: unknown } | undefined)?.error;
    acc.failed = `upstream stream reported response.failed: ${JSON.stringify(error ?? '')}`;
  }
}

/** Accumulate the Responses-API SSE stream (bounded to 8 MiB). */
async function accumulateStream(res: Response): Promise<StreamAccumulation> {
  const acc: StreamAccumulation = { text: '', finishReason: 'stop' };
  if (!res.body) return acc;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > UPSTREAM_BODY_CAP_BYTES) {
      await reader.cancel().catch(() => {});
      acc.failed = `upstream stream exceeds ${UPSTREAM_BODY_CAP_BYTES} bytes`;
      return acc;
    }
    buffer += decoder.decode(value, { stream: true });
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        continue;
      }
      applyEvent(acc, event);
      if (acc.failed) {
        await reader.cancel().catch(() => {});
        return acc;
      }
    }
  }
  return acc;
}

export function mountCodexOAuthConnector(
  config: CodexConfig,
  deps: { dataDir?: string; fetch?: typeof fetch; now?: () => number; codexTokenUrl?: string },
): ChatConnector {
  const label = 'connector(codex-oauth)';
  if ((config as { acknowledgeSubscriptionScope?: unknown }).acknowledgeSubscriptionScope !== true) {
    throw new MarketplaceConnectorMountError(
      'CONNECTOR_SCOPE',
      `${label} requires acknowledgeSubscriptionScope: true (a personal subscription must not be resold to third parties)`,
    );
  }
  if (typeof config.upstreamModel !== 'string' || config.upstreamModel.trim() === '' || config.upstreamModel.length > 256) {
    throw new MarketplaceConnectorMountError('CONNECTOR_CONFIG', `${label}.upstreamModel must be a non-empty string`);
  }
  const { base, origin } = parseUpstreamBaseUrl(config.baseUrl ?? CODEX_DEFAULT_BASE, 'https-or-loopback-http', label);
  const authFile = config.authFile ?? (deps.dataDir ? defaultCodexAuthFile(deps.dataDir) : undefined);
  if (!authFile || !isAbsolute(authFile)) {
    throw new MarketplaceConnectorMountError('CONNECTOR_CONFIG', `${label}.authFile must be an absolute path (or the node needs a data dir)`);
  }
  const reasoningEffort = config.reasoningEffort ?? 'low';
  if (!(REASONING_EFFORTS as readonly string[]).includes(reasoningEffort)) {
    throw new MarketplaceConnectorMountError('CONNECTOR_CONFIG', `${label}.reasoningEffort must be minimal, low, medium or high`);
  }
  const timeoutMs = resolveTimeoutMs(config.timeoutMs, DEFAULT_TIMEOUT_MS, label);
  try {
    readAuth(authFile);
  } catch (error) {
    throw new MarketplaceConnectorMountError('CONNECTOR_AUTH_ABSENT', `${label}: ${(error as Error).message}`);
  }
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const refreshDeps: RefreshDeps = { fetchImpl, tokenUrl: deps.codexTokenUrl ?? CODEX_TOKEN_URL, now };

  const send = async (request: ConnectorChatRequest, auth: AuthStore): Promise<Response> =>
    upstreamFetch(fetchImpl, `${base}/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        authorization: `Bearer ${auth.tokens.access_token}`,
        'chatgpt-account-id': auth.tokens.account_id,
        'OpenAI-Beta': 'responses=experimental',
        originator: 'codex_cli_rs',
        session_id: randomUUID(),
      },
      body: JSON.stringify({
        model: request.upstreamModel,
        instructions: 'You are a helpful assistant.',
        // The Responses API rejects role "system" in `input`; its system lane is `developer`.
        input: request.messages.map((message) => ({
          type: 'message',
          role: message.role === 'system' ? 'developer' : message.role,
          content: [{ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: message.content }],
        })),
        store: false,
        stream: true,
        reasoning: { effort: reasoningEffort },
      }),
      timeoutMs,
    });

  return {
    description: {
      kind: 'codex-oauth',
      toolTransport: 'prompt',
      provenanceClass: 'upstream-claimed',
      upstreamModel: config.upstreamModel,
      upstreamOrigin: origin,
      secretConfigured: true,
    },

    async complete(request: ConnectorChatRequest): Promise<ConnectorChatOutcome> {
      let auth: AuthStore;
      try {
        auth = await freshAuth(authFile, refreshDeps);
      } catch (error) {
        return failure('UPSTREAM_AUTH', 0, `auth store unusable: ${(error as Error).message}`);
      }
      let res: Response;
      try {
        res = await send(request, auth);
        if (res.status === 401 || res.status === 403) {
          await res.body?.cancel().catch(() => {});
          const status = res.status;
          try {
            auth = await refreshOnce(authFile, auth.tokens.access_token, refreshDeps);
          } catch (error) {
            return failure('UPSTREAM_AUTH', status, `upstream HTTP ${status}; token refresh failed: ${(error as Error).message}`);
          }
          res = await send(request, auth);
        }
      } catch (error) {
        return classifyTransportError(error);
      }
      if (res.status < 200 || res.status >= 300) {
        let body = '';
        try { body = await readCappedText(res); } catch { /* the status is enough */ }
        return failure(classifyStatus(res.status), res.status,
          `upstream HTTP ${res.status}: ${redactThenTruncate(body, tokenValues(auth))}`);
      }
      let acc: StreamAccumulation;
      try {
        acc = await accumulateStream(res);
      } catch (error) {
        return classifyTransportError(error);
      }
      if (acc.failed) return failure('UPSTREAM_ERROR', 502, redactThenTruncate(acc.failed, tokenValues(auth), 200));
      if (!acc.text) return failure('UPSTREAM_ERROR', 502, 'upstream stream completed with no output_text');
      return {
        ok: true,
        content: acc.text,
        finishReason: acc.finishReason,
        ...(acc.usage ? { providerUsage: acc.usage } : {}),
      };
    },

    async health() {
      const started = now();
      try {
        await freshAuth(authFile, refreshDeps);
        return { ok: true, latencyMs: Math.max(0, now() - started) };
      } catch (error) {
        return { ok: false, latencyMs: Math.max(0, now() - started), detail: `auth store unusable: ${(error as Error).message}` };
      }
    },
  };
}
