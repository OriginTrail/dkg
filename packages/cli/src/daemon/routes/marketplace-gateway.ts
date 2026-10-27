// OT-RFC-27 buyer gateway routes: the OpenAI-compatible surface under
// `/api/marketplace/gateway/v1` (spec §9), reached ONLY through the daemon's
// pre-auth carve-out (`daemon/marketplace-gateway-dispatch.ts`). Every request
// authenticates by a scoped gateway key read from `Authorization: Bearer`
// alone — never the node token, never a query/body/cookie/x-api-key value —
// BEFORE any body byte is read and before any agent call.
//
// Order per request (spec §9.2): key → per-key rps → route (404/405 only
// after the key verified) → per-key in-flight cap → body (size + time capped)
// → field checks → key scope → gateway-wide concurrency slot → agent call
// under a key spend guard → JSON or buffered SSE. The gateway-wide slot is
// taken only AFTER the body is read and the scope checked, so a key's slow
// senders (or a key with no scope at all) hold only that key's own slots and
// can never starve other keys. Every rejection sent before the body is read
// carries `Connection: close`, so an unread body cannot pin the socket. Every
// error carries `x-should-retry` mirroring `dkg.retryable` (false once charged).
//
// Logs carry the keyId and a call/request id only — never the Authorization
// header, a key, a prompt or a completion. Value imports come from the
// agent's pure `gateway-domain` module, never the agent runtime root.

import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  MarketplaceChatCompletionInput,
  MarketplaceChatCompletionResult,
  MarketplaceGatewayModel,
  MarketplaceGatewayQueryResult,
  MarketplaceInvokeResult,
} from '@origintrail-official/dkg-agent';
import {
  MarketplaceSpendRefusedError,
  QUERY_MAX_SPARQL_BYTES,
  canonicalModelId,
  type GatewayKeyRecord,
  type MarketplaceSpendGuard,
  type RecountVerdict,
  type SlidingWindowRateLimiter,
} from '@origintrail-official/dkg-agent/dist/marketplace/gateway-domain.js';
import { corsHeaders } from '../http-utils.js';
import type { MarketplaceGatewayKeyStore } from '../../marketplace-gateway-key-store.js';
import type { ResolvedMarketplaceGatewayConfig } from '../../marketplace-config.js';
import {
  GATEWAY_BUSY_REPLY,
  INTERNAL_ERROR_REPLY,
  MARKETPLACE_UNAVAILABLE_REPLY,
  gatewayErrorBody,
  gatewayRetryHeader,
  mapGatewayError,
  type GatewayErrorReply,
} from './marketplace-gateway-errors.js';

/** The agent surface the gateway drives (the `DKGAgent` mixin methods; type-only, no runtime import). */
export interface MarketplaceGatewayAgent {
  marketplaceChatCompletion(input: MarketplaceChatCompletionInput): Promise<MarketplaceChatCompletionResult>;
  marketplaceGatewayQuery(input: {
    sparql: string;
    maxRows?: number;
    spendGuard?: MarketplaceSpendGuard;
  }): Promise<MarketplaceGatewayQueryResult>;
  marketplaceGatewayModels(): Promise<MarketplaceGatewayModel[]>;
}

export interface MarketplaceGatewayState {
  agent: MarketplaceGatewayAgent;
  store: MarketplaceGatewayKeyStore;
  config: ResolvedMarketplaceGatewayConfig;
  limiter: SlidingWindowRateLimiter;
  /** Gateway requests holding a gateway-wide slot (agent work, after body + scope). */
  inFlight: { count: number };
  /** Requests per key past routing (body read + work); an entry is deleted at 0. */
  perKeyInFlight: Map<string, number>;
  /** One key's cap on `perKeyInFlight` (below `maxConcurrent`, so one key cannot hold every slot). */
  maxConcurrentPerKey: number;
  log: (line: string) => void;
  nowMs: () => number;
  /** Body read deadline (ms). */
  bodyTimeoutMs: number;
}

export const GATEWAY_AUTH_REALM = 'Bearer realm="dkg-marketplace-gateway"';
const MAX_QUERY_ROWS = 10_000;
const CHAT_MAX_TOKENS_LIMIT = 1_000_000;

type RouteKey = 'models' | 'chat' | 'query';
const ROUTES: Record<string, { method: 'GET' | 'POST'; key: RouteKey }> = {
  '/models': { method: 'GET', key: 'models' },
  '/chat/completions': { method: 'POST', key: 'chat' },
  '/query': { method: 'POST', key: 'query' },
};

const UNAUTHORIZED_MESSAGES: Record<string, string> = {
  invalid_api_key: 'Missing or invalid gateway key. Send `Authorization: Bearer dkg_gw_…` (mint one with `dkg marketplace keys mint`).',
  key_revoked: 'This gateway key has been revoked.',
  key_expired: 'This gateway key has expired.',
};

// ─── wire helpers ─────────────────────────────────────────────────────

function jsonText(body: unknown): string {
  return JSON.stringify(body, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
}

function send(
  res: ServerResponse,
  status: number,
  contentType: string,
  text: string,
  corsOrigin: string | null,
  extra: Record<string, string> = {},
): void {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': String(Buffer.byteLength(text)),
    'Cache-Control': 'no-store',
    ...corsHeaders(corsOrigin),
    ...extra,
  });
  res.end(text);
}

function sendJson(res: ServerResponse, status: number, body: unknown, corsOrigin: string | null, extra?: Record<string, string>): void {
  send(res, status, 'application/json; charset=utf-8', jsonText(body), corsOrigin, extra);
}

/** Every gateway error: the §9.6 envelope plus `x-should-retry` mirroring `dkg.retryable`. */
function sendError(
  res: ServerResponse,
  reply: GatewayErrorReply,
  corsOrigin: string | null,
  opts: { chargedWei?: bigint; extra?: Record<string, string> } = {},
): void {
  const body = gatewayErrorBody(reply, opts.chargedWei);
  sendJson(res, reply.status, body, corsOrigin, { ...gatewayRetryHeader(body), ...opts.extra });
}

/** An error before the body was read: the socket closes after the reply. */
function sendEarlyError(
  res: ServerResponse,
  reply: GatewayErrorReply,
  corsOrigin: string | null,
  extra: Record<string, string> = {},
): void {
  sendError(res, reply, corsOrigin, { extra: { Connection: 'close', ...extra } });
}

/**
 * The key from `Authorization: Bearer <key>` ONLY: scheme case-insensitive,
 * exactly one token, surrounding whitespace trimmed. Anything else is
 * `undefined` (→ `invalid_api_key` after the same hash-and-compare work).
 */
export function gatewayBearerKey(headers: IncomingMessage['headers']): string | undefined {
  const raw = headers.authorization;
  if (typeof raw !== 'string') return undefined;
  const match = /^Bearer[ \t]+(\S+)$/i.exec(raw.trim());
  return match ? match[1] : undefined;
}

type BodyOutcome = { ok: true; text: string } | { ok: false; reason: 'too_large' | 'timeout' | 'aborted' };

function readGatewayBody(req: IncomingMessage, maxBytes: number, timeoutMs: number): Promise<BodyOutcome> {
  return new Promise((resolve) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      resolve({ ok: false, reason: 'too_large' });
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const finish = (outcome: BodyOutcome): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onAbort);
      req.off('close', onAbort);
      resolve(outcome);
    };
    const onData = (chunk: Buffer): void => {
      total += chunk.length;
      if (total > maxBytes) finish({ ok: false, reason: 'too_large' });
      else chunks.push(chunk);
    };
    const onEnd = (): void => finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') });
    const onAbort = (): void => finish({ ok: false, reason: 'aborted' });
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs);
    timer.unref?.();
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onAbort);
    req.on('close', onAbort);
  });
}

const badRequest = (code: string, message: string, param: string | null): GatewayErrorReply => ({
  status: 400,
  type: 'invalid_request_error',
  code,
  message,
  param,
});

// ─── request field checks (spec §9.2 step 5) ──────────────────────────

const absent = (value: unknown): boolean => value === undefined || value === null;

function optionalNumberInRange(body: Record<string, unknown>, field: string, max: number): number | undefined | GatewayErrorReply {
  const value = body[field];
  if (absent(value)) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) {
    return badRequest('invalid_parameter', `${field} must be a number between 0 and ${max}`, field);
  }
  return value;
}

const isReply = (value: unknown): value is GatewayErrorReply =>
  typeof value === 'object' && value !== null && 'status' in value && 'code' in value;

interface ChatRequest {
  model: string;
  stream: boolean;
  input: MarketplaceChatCompletionInput;
}

export function parseChatRequest(body: Record<string, unknown>, defaultMaxTokens: number): ChatRequest | GatewayErrorReply {
  if (typeof body.model !== 'string') return badRequest('invalid_model', 'model must be a string', 'model');
  if (body.messages === undefined) return badRequest('invalid_messages', 'messages is required', 'messages');
  if (!absent(body.stream) && typeof body.stream !== 'boolean') {
    return badRequest('invalid_parameter', 'stream must be a boolean', 'stream');
  }
  if (!absent(body.n) && body.n !== 1) {
    return badRequest('unsupported_parameter', 'only n = 1 is supported', 'n');
  }
  if (body.logprobs === true) return badRequest('unsupported_parameter', 'logprobs are not supported', 'logprobs');
  const format = body.response_format;
  if (!absent(format) && !(typeof format === 'object' && !Array.isArray(format)
    && Object.keys(format as object).length === 1 && (format as { type?: unknown }).type === 'text')) {
    return badRequest('unsupported_parameter', 'only response_format { "type": "text" } is supported', 'response_format');
  }
  const maxField = absent(body.max_tokens) ? 'max_completion_tokens' : 'max_tokens';
  const rawMax = body[maxField];
  let maxTokens: number | undefined;
  if (!absent(rawMax)) {
    if (typeof rawMax !== 'number' || !Number.isSafeInteger(rawMax) || rawMax < 1 || rawMax > CHAT_MAX_TOKENS_LIMIT) {
      return badRequest('invalid_parameter', `${maxField} must be an integer 1..${CHAT_MAX_TOKENS_LIMIT}`, maxField);
    }
    maxTokens = rawMax;
  }
  const temperature = optionalNumberInRange(body, 'temperature', 2);
  if (isReply(temperature)) return temperature;
  const topP = optionalNumberInRange(body, 'top_p', 1);
  if (isReply(topP)) return topP;
  const seed = body.seed;
  if (!absent(seed) && (typeof seed !== 'number' || !Number.isSafeInteger(seed))) {
    return badRequest('invalid_parameter', 'seed must be a safe integer', 'seed');
  }
  const stop = body.stop;
  if (!absent(stop) && typeof stop !== 'string'
    && !(Array.isArray(stop) && stop.length <= 4 && stop.every((entry) => typeof entry === 'string'))) {
    return badRequest('invalid_parameter', 'stop must be a string or an array of at most 4 strings', 'stop');
  }
  const model = canonicalModelId(body.model);
  if (model === undefined) return badRequest('invalid_model', 'model is not a valid model id', 'model');
  return {
    model,
    stream: body.stream === true,
    input: {
      model,
      messages: body.messages,
      ...(!absent(body.tools) ? { tools: body.tools } : {}),
      ...(!absent(body.tool_choice) ? { toolChoice: body.tool_choice } : {}),
      ...(!absent(body.parallel_tool_calls) ? { parallelToolCalls: body.parallel_tool_calls } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      defaultMaxTokens,
      ...(temperature !== undefined ? { temperature } : {}),
      ...(topP !== undefined ? { topP } : {}),
      ...(!absent(seed) ? { seed: seed as number } : {}),
      ...(!absent(stop) ? { stop: stop as string | string[] } : {}),
    },
  };
}

export function parseQueryRequest(body: Record<string, unknown>): { sparql: string; maxRows?: number } | GatewayErrorReply {
  if (typeof body.sparql !== 'string' || body.sparql.trim() === '') {
    return badRequest('invalid_sparql', 'sparql must be a non-empty string', 'sparql');
  }
  if (Buffer.byteLength(body.sparql, 'utf8') > QUERY_MAX_SPARQL_BYTES) {
    return badRequest('invalid_sparql', `sparql must be at most ${QUERY_MAX_SPARQL_BYTES} UTF-8 bytes`, 'sparql');
  }
  const maxRows = body.max_rows;
  if (!absent(maxRows)
    && (typeof maxRows !== 'number' || !Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > MAX_QUERY_ROWS)) {
    return badRequest('invalid_parameter', `max_rows must be an integer 1..${MAX_QUERY_ROWS}`, 'max_rows');
  }
  return { sparql: body.sparql, ...(!absent(maxRows) ? { maxRows: maxRows as number } : {}) };
}

// ─── spend guard over the key ledger (spec §10.3) ─────────────────────

interface KeySpendGuard extends MarketplaceSpendGuard {
  /** What `settle` received — the source of `charged_wei`. */
  readonly settled: { costWei: bigint; servedUnits: bigint; delivery: string } | undefined;
  /** Release a hold the agent admitted but never settled (defensive; C settles exactly once). */
  releaseIfUnsettled(): void;
}

function keySpendGuard(state: MarketplaceGatewayState, keyId: string, kind: 'inference' | 'query'): KeySpendGuard {
  const reservationId = `gwres_${randomBytes(12).toString('hex')}`;
  let admitted = false;
  let settled: KeySpendGuard['settled'];
  return {
    admit(worstCaseCostWei: bigint): void {
      const held = state.store.reserve(keyId, reservationId, worstCaseCostWei);
      if (!held.ok) {
        throw new MarketplaceSpendRefusedError(
          'key_budget_exceeded',
          `gateway key ${keyId} has ${held.remainingWei} wei of budget left; this call may cost up to ${worstCaseCostWei} wei`,
          held.remainingWei,
        );
      }
      admitted = true;
    },
    settle(outcome): void {
      if (!admitted || settled) return;
      settled = { ...outcome };
      if (outcome.delivery === 'not-served') {
        state.store.release(reservationId);
        return;
      }
      void state.store.settle(
        reservationId,
        { costWei: outcome.costWei, servedUnits: outcome.servedUnits, kind },
        Math.floor(state.nowMs() / 1000),
      );
    },
    get settled() {
      return settled;
    },
    releaseIfUnsettled(): void {
      if (admitted && !settled) {
        settled = { costWei: 0n, servedUnits: 0n, delivery: 'not-served' };
        state.store.release(reservationId);
        state.log(`[marketplace-gateway] key ${keyId}: the agent never settled reservation ${reservationId}; released`);
      }
    },
  };
}

// ─── response bodies (spec §9.3–§9.5) ─────────────────────────────────

function keyBlock(state: MarketplaceGatewayState, keyId: string): Record<string, string> {
  const record = state.store.ledger().get(keyId);
  return {
    key_id: keyId,
    spent_wei: (record?.usage.spentWei ?? 0n).toString(),
    remaining_wei: state.store.ledger().remainingWei(keyId).toString(),
  };
}

function recountBlock(recount: RecountVerdict): Record<string, unknown> {
  return {
    verdict: recount.verdict,
    reason: recount.reason ?? null,
    recount_units: recount.recountUnits !== undefined ? recount.recountUnits.toString() : null,
  };
}

function dkgCallBlock(
  state: MarketplaceGatewayState,
  keyId: string,
  invoke: MarketplaceInvokeResult,
  metering: Record<string, unknown>,
  recount: RecountVerdict,
): Record<string, unknown> {
  return {
    call_id: invoke.authorization.callId,
    offering_id: invoke.authorization.offeringId,
    seller: {
      identity_id: invoke.seller.identityId.toString(),
      peer_id: invoke.seller.peerId,
      address: invoke.seller.address,
    },
    served_units: invoke.servedUnits.toString(),
    ask_per_unit_wei: invoke.authorization.askPerUnitWei.toString(),
    cost_wei: invoke.costWei.toString(),
    receipt: {
      auth_digest: invoke.receipt.authDigest,
      result_commitment: invoke.receipt.resultCommitment,
      seller_sig: invoke.receipt.sellerSig,
    },
    metering,
    recount: recountBlock(recount),
    key: keyBlock(state, keyId),
  };
}

function chatMeteringBlock(metering: MarketplaceChatCompletionResult['metering']): Record<string, unknown> {
  return {
    basis: metering.basis,
    ...(metering.tokenizer ? { tokenizer_kind: metering.tokenizer.kind, tokenizer_digest: metering.tokenizer.digest } : {}),
    ...(metering.chatTemplate ? { chat_template: metering.chatTemplate.id } : {}),
    prompt_units: String(metering.promptUnits),
    tool_units: String(metering.toolUnits),
    completion_units: String(metering.completionUnits),
    truncated: metering.truncated,
    ...(metering.providerUsage ? { provider_usage: { ...metering.providerUsage } } : {}),
  };
}

const chatCompletionId = (callId: string): string => `chatcmpl-${callId.replace(/^0x/i, '')}`;

function chatUsage(result: MarketplaceChatCompletionResult): Record<string, number> {
  return {
    prompt_tokens: result.usage.promptTokens,
    completion_tokens: result.usage.completionTokens,
    total_tokens: result.usage.totalTokens,
  };
}

export function chatCompletionBody(result: MarketplaceChatCompletionResult, created: number, dkg: Record<string, unknown>): Record<string, unknown> {
  return {
    id: chatCompletionId(result.callId),
    object: 'chat.completion',
    created,
    model: result.model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: result.message.content,
        ...(result.message.tool_calls?.length ? { tool_calls: result.message.tool_calls } : {}),
      },
      finish_reason: result.finishReason,
      logprobs: null,
    }],
    usage: chatUsage(result),
    system_fingerprint: null,
    dkg,
  };
}

/** Buffered SSE (spec §9.4): the call completed and its receipt verified before the first byte. */
export function chatCompletionSse(result: MarketplaceChatCompletionResult, created: number, dkg: Record<string, unknown>): string {
  const base = { id: chatCompletionId(result.callId), object: 'chat.completion.chunk', created, model: result.model };
  const chunk = (choice: Record<string, unknown>) => ({ ...base, choices: [{ index: 0, ...choice }] });
  const events: unknown[] = [chunk({ delta: { role: 'assistant', content: '' }, finish_reason: null })];
  if (result.message.content) events.push(chunk({ delta: { content: result.message.content }, finish_reason: null }));
  const calls = result.message.tool_calls ?? [];
  if (calls.length > 0) {
    events.push(chunk({
      delta: {
        tool_calls: calls.map((call, index) => ({
          index,
          id: call.id,
          type: 'function',
          function: { name: call.function.name, arguments: call.function.arguments },
        })),
      },
      finish_reason: null,
    }));
  }
  events.push(chunk({ delta: {}, finish_reason: result.finishReason }));
  events.push({ ...base, choices: [], usage: chatUsage(result), dkg });
  return `${events.map((event) => `data: ${jsonText(event)}\n\n`).join('')}data: [DONE]\n\n`;
}

export function queryResultBody(result: MarketplaceGatewayQueryResult, dkg: Record<string, unknown>): Record<string, unknown> {
  return {
    object: 'dkg.query.result',
    id: result.callId,
    result: result.result ?? null,
    row_count: result.rowCount,
    aborted: result.aborted ? { reason: result.aborted.reason } : null,
    usage: {
      admission_units: result.metering.admissionUnits,
      delivery_units: result.metering.deliveryUnits,
      total_units: result.metering.servedUnits,
    },
    dkg,
  };
}

// ─── handlers ─────────────────────────────────────────────────────────

async function handleModels(state: MarketplaceGatewayState, res: ServerResponse, record: GatewayKeyRecord, cors: string | null): Promise<void> {
  const models = await state.agent.marketplaceGatewayModels();
  const allowlist = record.scopes.modelAllowlist;
  const data = models
    .filter((model) => allowlist === null || allowlist.includes(model.id))
    .map((model) => ({
      id: model.id,
      object: 'model',
      created: 0,
      owned_by: 'dkg-marketplace',
      ...(model.contextLength !== undefined ? { context_length: Number(model.contextLength) } : {}),
      dkg: {
        offers: model.offers,
        sellers: model.sellers.map((id) => id.toString()),
        min_ask_per_unit_wei: model.minAskPerUnitWei.toString(),
        metering_bases: model.meteringBases,
        tokenizer_kinds: model.tokenizerKinds,
        provenance_classes: model.provenanceClasses,
        tool_transports: model.toolTransports,
        routable: model.routable,
      },
    }));
  sendJson(res, 200, { object: 'list', data }, cors);
}

/** Read + parse the JSON body; on failure the reply is already sent. */
async function readJsonBody(
  state: MarketplaceGatewayState,
  req: IncomingMessage,
  res: ServerResponse,
  cors: string | null,
): Promise<Record<string, unknown> | undefined> {
  const body = await readGatewayBody(req, state.config.maxBodyBytes, state.bodyTimeoutMs);
  if (!body.ok) {
    if (body.reason === 'too_large') {
      sendEarlyError(res, {
        status: 413,
        type: 'invalid_request_error',
        code: 'request_too_large',
        message: `request body exceeds ${state.config.maxBodyBytes} bytes`,
      }, cors);
    } else if (body.reason === 'timeout') {
      sendEarlyError(res, { status: 408, type: 'invalid_request_error', code: 'request_timeout', message: 'request body not received in time' }, cors);
    } else if (!res.writableEnded) {
      res.destroy();
    }
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    sendError(res, badRequest('invalid_json', 'request body is not valid JSON', null), cors);
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    sendError(res, badRequest('invalid_json', 'request body must be a JSON object', null), cors);
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

/**
 * Run `work` under one gateway-wide slot, or answer 503 `gateway_busy`. The
 * slot is held until the WORK completes, not until the client goes away: a
 * disconnect does not cancel the p2p call (§9.4), so releasing on `close`
 * would let a disconnecting client exceed the cap.
 */
async function withGatewaySlot(state: MarketplaceGatewayState, res: ServerResponse, cors: string | null, work: () => Promise<void>): Promise<void> {
  if (state.inFlight.count >= state.config.maxConcurrent) {
    return sendError(res, GATEWAY_BUSY_REPLY, cors, { extra: { 'Retry-After': '1' } });
  }
  state.inFlight.count += 1;
  try {
    await work();
  } finally {
    state.inFlight.count -= 1;
  }
}

function respondAgentError(
  state: MarketplaceGatewayState,
  res: ServerResponse,
  err: unknown,
  guard: KeySpendGuard,
  ctx: { keyId: string; requestId: string; unitsParam: 'max_tokens' | 'max_rows'; cors: string | null },
): void {
  const mapped = mapGatewayError(err, ctx.unitsParam);
  const callId = (err as { invoke?: { authorization?: { callId?: string } } })?.invoke?.authorization?.callId;
  // charged_wei is ALWAYS what this call's guard settled — on the generic 500 too.
  const charged = guard.settled?.costWei ?? 0n;
  const chargedLog = `${callId ? ` call=${callId}` : ''} charged_wei=${charged}`;
  let reply = mapped;
  if (mapped === INTERNAL_ERROR_REPLY) {
    const e = err as { name?: unknown; message?: unknown };
    state.log(
      `[marketplace-gateway] internal error key=${ctx.keyId} request=${ctx.requestId}${chargedLog}: `
      + `${String(e?.name ?? 'Error')}: ${String(e?.message ?? err).slice(0, 200)}`,
    );
    reply = { ...mapped, message: `${mapped.message} (request ${ctx.requestId})` };
  } else if (charged > 0n) {
    state.log(`[marketplace-gateway] charged failure key=${ctx.keyId} request=${ctx.requestId}${chargedLog} code=${reply.code}`);
  }
  // A retry hint only where retrying can help (never once charged, an exhausted budget or quota).
  const retryAfter = reply.retryable && charged === 0n && (reply.status === 429 || reply.status === 503);
  sendError(res, reply, ctx.cors, { chargedWei: charged, extra: retryAfter ? { 'Retry-After': '1' } : {} });
}

async function handleChat(
  state: MarketplaceGatewayState,
  req: IncomingMessage,
  res: ServerResponse,
  record: GatewayKeyRecord,
  ctx: { requestId: string; cors: string | null },
): Promise<void> {
  const body = await readJsonBody(state, req, res, ctx.cors);
  if (!body) return;
  const parsed = parseChatRequest(body, state.config.defaultMaxTokens);
  if (isReply(parsed)) return sendError(res, parsed, ctx.cors);
  // A copy taken at authentication: a revocation lands on the NEXT call.
  const scope = state.store.ledger().checkScope(record, { kind: 'inference', modelId: parsed.model });
  if (!scope.ok) {
    return sendError(res, {
      status: 403, type: 'permission_error', code: 'model_not_allowed', param: 'model',
      message: `this gateway key may not call model ${parsed.model}`,
    }, ctx.cors);
  }
  return withGatewaySlot(state, res, ctx.cors, () => runChat(state, res, record, parsed, ctx));
}

async function runChat(
  state: MarketplaceGatewayState,
  res: ServerResponse,
  record: GatewayKeyRecord,
  parsed: ChatRequest,
  ctx: { requestId: string; cors: string | null },
): Promise<void> {
  const guard = keySpendGuard(state, record.keyId, 'inference');
  let result: MarketplaceChatCompletionResult;
  try {
    result = await state.agent.marketplaceChatCompletion({ ...parsed.input, spendGuard: guard });
  } catch (err) {
    guard.releaseIfUnsettled();
    return respondAgentError(state, res, err, guard, { keyId: record.keyId, unitsParam: 'max_tokens', ...ctx });
  }
  guard.releaseIfUnsettled();
  const created = Math.floor(state.nowMs() / 1000);
  const dkg = dkgCallBlock(state, record.keyId, result.invoke, chatMeteringBlock(result.metering), result.recount);
  if (parsed.stream) {
    // Errors all happen before the first byte, so they stay plain JSON.
    if (res.headersSent || res.writableEnded || res.destroyed) return;
    const text = chatCompletionSse(result, created, dkg);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...corsHeaders(ctx.cors),
    });
    res.end(text);
    return;
  }
  sendJson(res, 200, chatCompletionBody(result, created, dkg), ctx.cors);
}

async function handleQuery(
  state: MarketplaceGatewayState,
  req: IncomingMessage,
  res: ServerResponse,
  record: GatewayKeyRecord,
  ctx: { requestId: string; cors: string | null },
): Promise<void> {
  const body = await readJsonBody(state, req, res, ctx.cors);
  if (!body) return;
  const parsed = parseQueryRequest(body);
  if (isReply(parsed)) return sendError(res, parsed, ctx.cors);
  const scope = state.store.ledger().checkScope(record, { kind: 'query' });
  if (!scope.ok) {
    return sendError(res, {
      status: 403, type: 'permission_error', code: 'query_not_allowed',
      message: 'this gateway key may not run SPARQL queries',
    }, ctx.cors);
  }
  return withGatewaySlot(state, res, ctx.cors, () => runQuery(state, res, record, parsed, ctx));
}

async function runQuery(
  state: MarketplaceGatewayState,
  res: ServerResponse,
  record: GatewayKeyRecord,
  parsed: { sparql: string; maxRows?: number },
  ctx: { requestId: string; cors: string | null },
): Promise<void> {
  const guard = keySpendGuard(state, record.keyId, 'query');
  let result: MarketplaceGatewayQueryResult;
  try {
    result = await state.agent.marketplaceGatewayQuery({ ...parsed, spendGuard: guard });
  } catch (err) {
    guard.releaseIfUnsettled();
    return respondAgentError(state, res, err, guard, { keyId: record.keyId, unitsParam: 'max_rows', ...ctx });
  }
  guard.releaseIfUnsettled();
  const metering = {
    schedule_digest: result.metering.scheduleDigest,
    admission_units: String(result.metering.admissionUnits),
    delivery_units: String(result.metering.deliveryUnits),
  };
  sendJson(res, 200, queryResultBody(result, dkgCallBlock(state, record.keyId, result.invoke, metering, result.recount)), ctx.cors);
}

/**
 * One gateway request. `subpath` is the pathname below the gateway base
 * (`''`, `/models`, …). Always ends `res` (or destroys it for a client that
 * went away mid-body).
 */
export async function handleMarketplaceGatewayRequest(
  state: MarketplaceGatewayState,
  req: IncomingMessage,
  res: ServerResponse,
  subpath: string,
  cors: string | null,
): Promise<void> {
  if (!state.store.available) {
    // Fail closed: a malformed key file disables the gateway, never the boot.
    return sendEarlyError(res, MARKETPLACE_UNAVAILABLE_REPLY, cors);
  }
  // S3/S10/S11: the key, from the Authorization header alone, before any body byte or agent call.
  const verdict = state.store.ledger().authenticate(gatewayBearerKey(req.headers), Math.floor(state.nowMs() / 1000));
  if (!verdict.ok) {
    return sendEarlyError(res, {
      status: 401, type: 'authentication_error', code: verdict.code, message: UNAUTHORIZED_MESSAGES[verdict.code],
    }, cors, { 'WWW-Authenticate': GATEWAY_AUTH_REALM });
  }
  const record = verdict.record;
  if (!state.limiter.tryAcquire(record.keyId, record.scopes.rps, state.nowMs())) {
    return sendEarlyError(res, {
      status: 429, type: 'rate_limit_error', code: 'rate_limit_exceeded', retryable: true,
      message: `gateway key ${record.keyId} is limited to ${record.scopes.rps} requests per second`,
    }, cors, { 'Retry-After': '1' });
  }
  const route = Object.prototype.hasOwnProperty.call(ROUTES, subpath) ? ROUTES[subpath] : undefined;
  if (!route) {
    return sendEarlyError(res, { status: 404, type: 'invalid_request_error', code: 'unknown_url', message: 'Unknown gateway URL.' }, cors);
  }
  if (req.method !== route.method) {
    return sendEarlyError(res, {
      status: 405, type: 'invalid_request_error', code: 'method_not_allowed',
      message: `${subpath} accepts ${route.method} only`,
    }, cors, { Allow: route.method });
  }
  // Per-key in-flight cap BEFORE any body byte: it bounds one key's slow
  // senders and long calls to that key's own share, whatever its scope.
  const held = state.perKeyInFlight.get(record.keyId) ?? 0;
  if (held >= state.maxConcurrentPerKey) {
    return sendEarlyError(res, {
      status: 429, type: 'rate_limit_error', code: 'rate_limit_exceeded', retryable: true,
      message: `gateway key ${record.keyId} already has ${held} requests in flight (limit ${state.maxConcurrentPerKey})`,
    }, cors, { 'Retry-After': '1' });
  }
  state.perKeyInFlight.set(record.keyId, held + 1);
  const ctx = { requestId: `gwreq_${randomBytes(8).toString('hex')}`, cors };
  try {
    if (route.key === 'models') await withGatewaySlot(state, res, cors, () => handleModels(state, res, record, cors));
    else if (route.key === 'chat') await handleChat(state, req, res, record, ctx);
    else await handleQuery(state, req, res, record, ctx);
  } catch (err) {
    // Faults outside the agent call (e.g. the models listing): mapped, never leaked.
    const reply = mapGatewayError(err, route.key === 'query' ? 'max_rows' : 'max_tokens');
    if (reply === INTERNAL_ERROR_REPLY) {
      const e = err as { name?: unknown; message?: unknown };
      state.log(`[marketplace-gateway] internal error key=${record.keyId} request=${ctx.requestId}: ${String(e?.name ?? 'Error')}: ${String(e?.message ?? err).slice(0, 200)}`);
      sendError(res, { ...reply, message: `${reply.message} (request ${ctx.requestId})` }, cors);
    } else {
      sendError(res, reply, cors);
    }
  } finally {
    const left = (state.perKeyInFlight.get(record.keyId) ?? 1) - 1;
    if (left > 0) state.perKeyInFlight.set(record.keyId, left);
    else state.perKeyInFlight.delete(record.keyId);
  }
}
