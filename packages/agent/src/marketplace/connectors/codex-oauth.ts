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
 * refreshed store is written back atomically (0600); mount refuses an auth
 * file whose directory the node cannot write, and a write that still fails
 * keeps the rotated set in memory (the file then holds a spent token).
 * Failure details redact every token value before truncation.
 *
 * One deadline (`timeoutMs`, default 180 s) bounds the WHOLE call — refreshes,
 * the 401 retry and the streamed body — so it stays under the buyer's 200 s
 * chat serve timeout. A stream must end in `response.completed` or
 * `response.incomplete`; a stream that closes without one (or reports an
 * `error` event) is `UPSTREAM_ERROR`, never a partial reply. The Responses
 * API has no `stop`, so the caller's stop sequences are applied here.
 *
 * Metering never trusts upstream usage (reasoning tokens are invisible in the
 * delivered bytes): the executor counts the delivered text with the pinned
 * `tiktoken-o200k-v1` engine and bounds it with `boundCompletion` — the
 * backend rejects `max_output_tokens`, so none is sent.
 */
import { randomUUID } from 'node:crypto';
import { accessSync, constants as fsConstants, readFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { writeFileAtomic0600 } from '../atomic-file.js';
import type { MarketplaceConnectorConfig } from '../config.js';
import type { MarketplaceLogger } from '../seller-service.js';
import { CODEX_DEFAULT_BASE, CODEX_OAUTH_CLIENT_ID, CODEX_TOKEN_URL, defaultCodexAuthFile } from './codex-constants.js';
import {
  classifyStatus,
  classifyTransportError,
  failure,
  parseUpstreamBaseUrl,
  readCappedText,
  redactThenTruncate,
  resolveTimeoutMs,
  untilAborted,
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

/**
 * Refreshed token sets that could not be written back. The refresh already
 * rotated the refresh token upstream, so the file holds a SPENT one
 * (`diskRefreshToken`): the in-memory set wins until a write-back succeeds or
 * the file changes underneath (a new login).
 */
const unpersisted = new Map<string, { store: AuthStore; diskRefreshToken: string }>();

interface RefreshDeps {
  fetchImpl: typeof fetch;
  tokenUrl: string;
  now: () => number;
  log?: MarketplaceLogger;
}

/** Atomic 0600 write-back; the failure's code (never content) when it fails. */
function persistAuth(authFile: string, store: AuthStore): string | undefined {
  try {
    writeFileAtomic0600(authFile, `${JSON.stringify(store, null, 2)}\n`, { dirMode: 0o700 });
    return undefined;
  } catch (error) {
    return String((error as { code?: unknown }).code ?? (error as Error).name ?? 'write failed');
  }
}

/** The current token set: the file, or the in-memory set while the file holds a spent refresh token. */
function loadAuth(authFile: string, log?: MarketplaceLogger): AuthStore {
  const held = unpersisted.get(authFile);
  if (!held) return readAuth(authFile);
  let onDisk: AuthStore | undefined;
  try {
    onDisk = readAuth(authFile);
  } catch {
    // Missing or unreadable: the held set stands in (and is written back below).
  }
  if (onDisk && onDisk.tokens.refresh_token !== held.diskRefreshToken) {
    unpersisted.delete(authFile); // a new login replaced the file
    return onDisk;
  }
  if (persistAuth(authFile, held.store) === undefined) {
    unpersisted.delete(authFile);
    log?.info(`[marketplace] codex-oauth: the refreshed tokens held in memory are now written back to ${authFile}`);
  }
  return held.store;
}

async function performRefresh(authFile: string, deps: RefreshDeps): Promise<AuthStore> {
  const current = loadAuth(authFile, deps.log);
  const diskRefreshToken = unpersisted.get(authFile)?.diskRefreshToken ?? current.tokens.refresh_token;
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
  const writeFault = persistAuth(authFile, updated);
  if (writeFault === undefined) {
    unpersisted.delete(authFile);
  } else {
    // Never drop the rotated set: the old refresh token is already spent upstream.
    unpersisted.set(authFile, { store: updated, diskRefreshToken });
    deps.log?.warn(
      `[marketplace] codex-oauth: refreshed tokens could not be written back to ${authFile} (${writeFault}); `
      + 'serving from memory — the file now holds a spent refresh token: fix the write fault (or re-run the login) before this node restarts',
    );
  }
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
  const onDisk = loadAuth(authFile, deps.log);
  if (usedAccessToken !== undefined && onDisk.tokens.access_token !== usedAccessToken) return onDisk;
  const promise = performRefresh(authFile, deps).finally(() => refreshInFlight.delete(authFile));
  refreshInFlight.set(authFile, promise);
  return promise;
}

async function freshAuth(authFile: string, deps: RefreshDeps): Promise<AuthStore> {
  const pending = refreshInFlight.get(authFile);
  if (pending) return pending;
  const auth = loadAuth(authFile, deps.log);
  const exp = jwtExp(auth.tokens.access_token);
  if (exp !== null && exp * 1000 < deps.now() + REFRESH_AHEAD_MS) return refreshOnce(authFile, auth.tokens.access_token, deps);
  return auth;
}

interface StreamAccumulation {
  text: string;
  finishReason: string;
  usage?: { promptTokens: number; completionTokens: number };
  failed?: string;
  /** A `response.completed` / `response.incomplete` arrived: the reply is whole. */
  terminated: boolean;
}

function applyEvent(acc: StreamAccumulation, event: Record<string, unknown>): void {
  const type = String(event.type ?? '');
  if (type === 'response.output_text.delta' && typeof event.delta === 'string') acc.text += event.delta;
  if (type === 'response.completed' || type === 'response.incomplete') {
    acc.terminated = true;
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
  if (type === 'error') {
    // The Responses stream's mid-stream error event: the reply is not whole.
    acc.failed = `upstream stream reported error: ${JSON.stringify({ code: event.code ?? null, message: event.message ?? null })}`;
  }
}

/** Cut at the earliest occurrence of any (non-empty) stop sequence, which is excluded — as upstreams do. */
function cutAtStop(text: string, stop: readonly string[] | undefined): { text: string; stopped: boolean } {
  let cut = -1;
  for (const sequence of stop ?? []) {
    if (!sequence) continue;
    const index = text.indexOf(sequence);
    if (index >= 0 && (cut < 0 || index < cut)) cut = index;
  }
  return cut < 0 ? { text, stopped: false } : { text: text.slice(0, cut), stopped: true };
}

/** Accumulate the Responses-API SSE stream (bounded to 8 MiB). */
async function accumulateStream(res: Response): Promise<StreamAccumulation> {
  const acc: StreamAccumulation = { text: '', finishReason: 'stop', terminated: false };
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
  deps: { dataDir?: string; fetch?: typeof fetch; now?: () => number; codexTokenUrl?: string; log?: MarketplaceLogger },
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
  try {
    accessSync(dirname(authFile), fsConstants.W_OK);
  } catch {
    // Refresh tokens rotate on every refresh: a token set that cannot be
    // written back is lost at the next restart (a read-only secret mount).
    throw new MarketplaceConnectorMountError(
      'CONNECTOR_CONFIG',
      `${label}: the auth file's directory is not writable by the node (refreshed tokens must be written back)`,
    );
  }
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const refreshDeps: RefreshDeps = {
    fetchImpl, tokenUrl: deps.codexTokenUrl ?? CODEX_TOKEN_URL, now, ...(deps.log ? { log: deps.log } : {}),
  };

  const send = async (request: ConnectorChatRequest, auth: AuthStore, deadline: AbortSignal): Promise<Response> =>
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
      signal: deadline,
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
      // ONE budget for the whole call (refreshes, the 401 retry, the stream).
      // A shared refresh keeps running for its other waiters past this deadline.
      const deadline = AbortSignal.timeout(timeoutMs);
      let auth: AuthStore;
      try {
        auth = await untilAborted(freshAuth(authFile, refreshDeps), deadline);
      } catch (error) {
        if (deadline.aborted) return classifyTransportError(deadline.reason);
        return failure('UPSTREAM_AUTH', 0, `auth store unusable: ${(error as Error).message}`);
      }
      let res: Response;
      try {
        res = await send(request, auth, deadline);
        if (res.status === 401 || res.status === 403) {
          await res.body?.cancel().catch(() => {});
          const status = res.status;
          try {
            auth = await untilAborted(refreshOnce(authFile, auth.tokens.access_token, refreshDeps), deadline);
          } catch (error) {
            if (deadline.aborted) return classifyTransportError(deadline.reason);
            return failure('UPSTREAM_AUTH', status, `upstream HTTP ${status}; token refresh failed: ${(error as Error).message}`);
          }
          res = await send(request, auth, deadline);
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
      // A partial reply is never billed as complete (no receipt for an upstream fault).
      if (!acc.terminated) return failure('UPSTREAM_ERROR', 502, 'upstream stream closed before response.completed');
      if (!acc.text) return failure('UPSTREAM_ERROR', 502, 'upstream stream completed with no output_text');
      const bounded = cutAtStop(acc.text, request.stop);
      return {
        ok: true,
        content: bounded.text,
        finishReason: bounded.stopped ? 'stop' : acc.finishReason,
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
