import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';

import type { DKGAgent } from '@origintrail-official/dkg-agent';
import type { ChatMemoryManager } from '@origintrail-official/dkg-node-ui';
import type {
  DkgConfig,
  LocalAgentIntegrationTransport,
} from '../config.js';
import type { ExtractionStatusRecord } from '../extraction-status.js';
import {
  getLocalAgentIntegration,
  getStoredLocalAgentIntegrations,
} from './local-agents.js';
import {
  normalizeOpenClawAttachmentRefs,
  normalizeOpenClawAttachmentImportResults,
  dedupeOpenClawAttachmentImportResults,
  normalizeOpenClawChatContextEntriesWithAttachmentImportResults,
  pipeOpenClawStream,
  trimTrailingSlashes,
  verifyOpenClawAttachmentRefsProvenance,
  verifyOpenClawAttachmentImportResultsProvenance,
  type OpenClawAttachmentImportResult,
  type OpenClawAttachmentRef,
  type OpenClawChatContextEntry,
  type OpenClawStreamReader,
  type OpenClawStreamRequest,
  type OpenClawStreamResponse,
} from './openclaw.js';

export const HERMES_CHANNEL_RESPONSE_TIMEOUT_MS = 180_000;
export const DEFAULT_HERMES_BRIDGE_URL = 'http://127.0.0.1:9202';
export const DEFAULT_HERMES_API_SERVER_URL = 'http://127.0.0.1:8642';

export type HermesChannelProtocol = 'hermes-channel' | 'hermes-openai';

export interface HermesChannelTarget {
  name: 'bridge' | 'gateway';
  protocol?: HermesChannelProtocol;
  inboundUrl: string;
  streamUrl?: string;
  healthUrl?: string;
}

export type HermesHealthState = Record<string, unknown> & {
  ok: boolean;
  channel?: string;
  error?: string;
};

export interface HermesChannelHealthReport {
  ok: boolean;
  target?: 'bridge' | 'gateway';
  bridge?: HermesHealthState;
  gateway?: HermesHealthState;
  error?: string;
}

export interface HermesChatPayload {
  text: string;
  correlationId: string;
  identity?: string;
  sessionId?: string;
  profile?: string;
  persistUserMessage?: string;
  attachmentRefs?: OpenClawAttachmentRef[];
  attachmentImportResults?: OpenClawAttachmentImportResult[];
  contextEntries?: OpenClawChatContextEntry[];
  contextGraphId?: string;
  currentAgentAddress?: string;
}

export interface HermesPersistTurnPayload {
  sessionId: string;
  userMessage: string;
  assistantReply: string;
  turnId: string;
  correlationId?: string;
  idempotencyKey?: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown>; result: unknown }>;
  attachmentRefs?: OpenClawAttachmentRef[];
  persistenceState: 'stored' | 'failed' | 'pending';
  failureReason?: string;
  contextGraphId?: string;
  profile?: string;
  metadata?: Record<string, unknown>;
}

export type HermesTurnPersistenceState = HermesPersistTurnPayload['persistenceState'];

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function optionalTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

const HERMES_CHAT_ID_RE = /^[A-Za-z0-9._:-]+$/;

function validateHermesChatIdentifier(value: string, field: string): string | null {
  if (value.length > 512) return `${field} is too long`;
  if (!HERMES_CHAT_ID_RE.test(value)) {
    return `${field} must contain only letters, numbers, dots, underscores, colons, and hyphens`;
  }
  return null;
}

function buildHermesGatewayBase(value: string): string {
  return value.endsWith('/api/hermes-channel')
    ? value
    : `${value}/api/hermes-channel`;
}

function urlBelongsToBase(value: string, base: string): boolean {
  try {
    const parsedValue = new URL(value);
    const parsedBase = new URL(base);
    if (parsedValue.origin !== parsedBase.origin) return false;

    const basePath = trimTrailingSlashes(parsedBase.pathname);
    if (!basePath || basePath === '/') return true;
    return parsedValue.pathname === basePath
      || parsedValue.pathname.startsWith(`${basePath}/`);
  } catch {
    return false;
  }
}

export function isHermesLoopbackUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    return host === 'localhost'
      || host === '[::1]'
      || host === '::1'
      || (isIP(host) === 4 && host.startsWith('127.'));
  } catch {
    return false;
  }
}

export function getHermesChannelTargets(config: DkgConfig): HermesChannelTarget[] {
  const storedHermesIntegration = getStoredLocalAgentIntegrations(config).hermes;
  if (storedHermesIntegration?.enabled === false) return [];

  const hermesIntegration = getLocalAgentIntegration(config, 'hermes');
  const transportKind = hermesIntegration?.transport.kind;
  const explicitBridgeBase = hermesIntegration?.transport.bridgeUrl
    ? trimTrailingSlashes(hermesIntegration.transport.bridgeUrl)
    : undefined;
  const explicitGatewayBase = hermesIntegration?.transport.gatewayUrl
    ? trimTrailingSlashes(hermesIntegration.transport.gatewayUrl)
    : undefined;
  const explicitHealthUrl = hermesIntegration?.transport.healthUrl
    ? trimTrailingSlashes(hermesIntegration.transport.healthUrl)
    : undefined;
  const bridgeLooksLikeGateway =
    explicitBridgeBase?.endsWith('/api/hermes-channel') ?? false;
  const explicitBridgeIsLoopback = isHermesLoopbackUrl(explicitBridgeBase);
  const openAiGatewayBase = transportKind === 'hermes-openai'
    ? explicitGatewayBase ?? DEFAULT_HERMES_API_SERVER_URL
    : undefined;
  const standaloneBridgeUsesExplicitBase = !!explicitBridgeBase
    && explicitBridgeIsLoopback
    && !bridgeLooksLikeGateway;
  const standaloneBridgeBase = standaloneBridgeUsesExplicitBase && explicitBridgeBase
    ? explicitBridgeBase
    : !explicitBridgeBase && !explicitGatewayBase && !bridgeLooksLikeGateway && !openAiGatewayBase
      ? DEFAULT_HERMES_BRIDGE_URL
      : undefined;
  const gatewayBase = transportKind === 'hermes-openai'
    ? undefined
    : explicitGatewayBase ?? (bridgeLooksLikeGateway ? explicitBridgeBase : undefined);
  const normalizedGatewayBase = gatewayBase
    ? buildHermesGatewayBase(gatewayBase)
    : undefined;
  const explicitHealthIsGateway =
    !!explicitHealthUrl
    && (
      (!!normalizedGatewayBase && urlBelongsToBase(explicitHealthUrl, normalizedGatewayBase))
      || (!!openAiGatewayBase && urlBelongsToBase(explicitHealthUrl, openAiGatewayBase))
    );
  const targets: HermesChannelTarget[] = [];
  const seenInboundUrls = new Set<string>();

  const pushTarget = (target: HermesChannelTarget) => {
    if (seenInboundUrls.has(target.inboundUrl)) return;
    seenInboundUrls.add(target.inboundUrl);
    targets.push(target);
  };

  if (standaloneBridgeBase && isHermesLoopbackUrl(standaloneBridgeBase)) {
    pushTarget({
      name: 'bridge',
      inboundUrl: `${standaloneBridgeBase}/send`,
      streamUrl: `${standaloneBridgeBase}/stream`,
      healthUrl: explicitHealthUrl
        && !explicitHealthIsGateway
        && (standaloneBridgeUsesExplicitBase || !explicitBridgeBase)
        ? explicitHealthUrl
        : `${standaloneBridgeBase}/health`,
    });
  }

  if (normalizedGatewayBase) {
    pushTarget({
      name: 'gateway',
      protocol: 'hermes-channel',
      inboundUrl: `${normalizedGatewayBase}/send`,
      streamUrl: `${normalizedGatewayBase}/stream`,
      healthUrl: explicitHealthUrl && explicitHealthIsGateway
        ? explicitHealthUrl
        : `${normalizedGatewayBase}/health`,
    });
  }

  if (openAiGatewayBase) {
    pushTarget({
      name: 'gateway',
      protocol: 'hermes-openai',
      inboundUrl: `${openAiGatewayBase}/v1/chat/completions`,
      streamUrl: `${openAiGatewayBase}/v1/chat/completions`,
      healthUrl: explicitHealthUrl && explicitHealthIsGateway
        ? explicitHealthUrl
        : `${openAiGatewayBase}/health`,
    });
  }

  return targets;
}

export function buildHermesChannelHeaders(
  target: HermesChannelTarget,
  bridgeAuthToken: string | undefined,
  baseHeaders: Record<string, string> = {},
  requestUrl = target.inboundUrl,
  apiServerKey?: string,
): Record<string, string> {
  // Hermes' OpenAI-compatible api_server requires `Authorization: Bearer
  // <API_SERVER_KEY>` on `/v1/chat/completions` since v0.15.0. We only add it
  // when a key is resolved, so older key-less Hermes installs and the
  // unauthenticated `/health` probe keep their current behavior.
  if (target.protocol === 'hermes-openai') {
    return apiServerKey
      ? { ...baseHeaders, Authorization: `Bearer ${apiServerKey}` }
      : baseHeaders;
  }
  if (
    target.name !== 'bridge' ||
    !bridgeAuthToken ||
    !isHermesLoopbackUrl(requestUrl)
  ) {
    return baseHeaders;
  }
  return { ...baseHeaders, 'x-dkg-bridge-token': bridgeAuthToken };
}

/**
 * Resolve the Hermes API server key for the `hermes-openai` UI-chat
 * transport. `.env` (in the stored profile's `hermesHome`) is the source of
 * truth — the same file `dkg hermes setup` provisions and the one Hermes
 * itself reads. Reads are cached by path+mtime so we don't touch disk on
 * every chat request. `DKG_HERMES_API_SERVER_KEY` overrides for remote/WSL
 * gateways whose `.env` is not on the daemon's filesystem. Returns undefined
 * when no key is available (older key-less Hermes → no bearer is sent).
 */
export function resolveHermesApiServerKey(config: DkgConfig): string | undefined {
  const override = optionalTrimmedString(process.env.DKG_HERMES_API_SERVER_KEY);
  if (override) return override;
  // Only the LOOPBACK api_server reads a key from a local `.env`. A remote/WSL
  // `--gateway-url` Hermes keeps its `.env` on another host, so reading the
  // local profile here would forward a stale, unrelated key and make remote
  // chat fail — those setups must use DKG_HERMES_API_SERVER_KEY (handled above).
  if (!hasLoopbackHermesOpenAiTarget(config)) return undefined;
  const integration = getLocalAgentIntegration(config, 'hermes');
  const hermesHome = optionalTrimmedString(
    (integration?.metadata as Record<string, unknown> | undefined)?.hermesHome,
  );
  if (!hermesHome) return undefined;
  return readApiServerKeyFromEnv(join(hermesHome, '.env'));
}

/** True when the active hermes-openai target is a loopback api_server. */
function hasLoopbackHermesOpenAiTarget(config: DkgConfig): boolean {
  const target = getHermesChannelTargets(config).find((t) => t.protocol === 'hermes-openai');
  return !!target && isHermesLoopbackUrl(target.inboundUrl);
}

/**
 * Actionable remediation for a Hermes api_server auth failure, branched on
 * transport: a loopback gateway is fixed by `dkg hermes setup` (which writes
 * the local `.env`); a remote/WSL gateway is fixed by the daemon-side
 * DKG_HERMES_API_SERVER_KEY override, since setup never touches a remote `.env`.
 */
export function hermesApiServerKeyRemediation(config: DkgConfig): string {
  return hasLoopbackHermesOpenAiTarget(config)
    ? 'run "dkg hermes setup" to provision API_SERVER_KEY, then restart "hermes gateway run --replace -v"'
    : 'set DKG_HERMES_API_SERVER_KEY in the daemon environment to the remote Hermes API_SERVER_KEY (setup does not modify a remote .env), then restart the daemon';
}

const apiServerKeyCache = new Map<string, { mtimeMs: number; key: string | undefined }>();

function readApiServerKeyFromEnv(envPath: string): string | undefined {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(envPath).mtimeMs;
  } catch {
    apiServerKeyCache.delete(envPath);
    return undefined;
  }
  const cached = apiServerKeyCache.get(envPath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.key;
  let key: string | undefined;
  try {
    for (const line of readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?API_SERVER_KEY\s*=(.*)$/);
      if (!match) continue;
      const value = parseDotenvValue(match[1]);
      if (value) key = value; // last uncommented assignment wins (dotenv)
    }
  } catch {
    key = undefined;
  }
  apiServerKeyCache.set(envPath, { mtimeMs, key });
  return key;
}

/**
 * Extract a `.env` value the way Hermes (python-dotenv) does: a quoted value
 * keeps everything between the quotes (inline `#` included); an unquoted value
 * is truncated at the first whitespace-preceded `#` (inline comment) and
 * trimmed. Matching this keeps the bearer DKG forwards identical to the key
 * Hermes loads (`API_SERVER_KEY=secret # dev` → `secret`, not `secret # dev`).
 */
function parseDotenvValue(raw: string): string {
  const value = raw.replace(/^\s+/, '');
  if (value[0] === '"' || value[0] === "'") {
    const end = value.indexOf(value[0], 1);
    if (end > 0) return value.slice(1, end);
  }
  const comment = value.match(/\s#/);
  return (comment?.index !== undefined ? value.slice(0, comment.index) : value).trim();
}

export function transportPatchFromHermesTarget(
  config: DkgConfig,
  targetName: 'bridge' | 'gateway' | undefined,
): LocalAgentIntegrationTransport | undefined {
  if (!targetName) return undefined;
  const hermesIntegration = getLocalAgentIntegration(config, 'hermes');
  const existingTransport = hermesIntegration?.transport ?? {};
  const target = getHermesChannelTargets(config).find((item) => item.name === targetName);
  if (!target) return undefined;
  const explicitHealth = existingTransport.healthUrl && target.healthUrl === trimTrailingSlashes(existingTransport.healthUrl)
    ? { healthUrl: existingTransport.healthUrl }
    : existingTransport.healthUrl
      ? { healthUrl: undefined }
      : {};

  if (target.name === 'bridge') {
    const bridgeBase = target.inboundUrl.endsWith('/send')
      ? target.inboundUrl.slice(0, -'/send'.length)
      : target.inboundUrl;
    return {
      kind: 'hermes-channel',
      bridgeUrl: bridgeBase,
      ...(existingTransport.gatewayUrl ? { gatewayUrl: existingTransport.gatewayUrl } : {}),
      ...explicitHealth,
    };
  }

  if (target.protocol === 'hermes-openai') {
    const gatewayUrl = target.inboundUrl.endsWith('/v1/chat/completions')
      ? target.inboundUrl.slice(0, -'/v1/chat/completions'.length)
      : target.inboundUrl;
    return {
      kind: 'hermes-openai',
      ...(existingTransport.bridgeUrl ? { bridgeUrl: existingTransport.bridgeUrl } : {}),
      gatewayUrl,
      ...explicitHealth,
    };
  }

  const gatewayBase = target.inboundUrl.endsWith('/send')
    ? target.inboundUrl.slice(0, -'/send'.length)
    : target.inboundUrl;
  const gatewayUrl = gatewayBase.endsWith('/api/hermes-channel')
    ? gatewayBase.slice(0, -'/api/hermes-channel'.length)
    : gatewayBase;
  return {
    kind: 'hermes-channel',
    ...(existingTransport.bridgeUrl ? { bridgeUrl: existingTransport.bridgeUrl } : {}),
    gatewayUrl,
    ...explicitHealth,
  };
}

export async function probeHermesChannelHealth(
  config: DkgConfig,
  bridgeAuthToken: string | undefined,
  opts: { timeoutMs?: number } = {},
): Promise<HermesChannelHealthReport> {
  const targets = getHermesChannelTargets(config);
  let bridge: HermesHealthState | undefined;
  let gateway: HermesHealthState | undefined;
  let lastError = 'No Hermes channel health endpoint configured';
  const timeoutMs = opts.timeoutMs ?? 5_000;

  for (const target of targets) {
    if (!target.healthUrl) continue;
    if (target.name === 'bridge' && !bridgeAuthToken) {
      bridge = { ok: false, error: 'Bridge auth token unavailable' };
      lastError = 'Bridge auth token unavailable';
      continue;
    }

    try {
      const healthRes = await fetch(target.healthUrl, {
        headers: buildHermesChannelHeaders(target, bridgeAuthToken, { Accept: 'application/json' }, target.healthUrl),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await healthRes.text().catch(() => '');
      let parsed: Record<string, unknown> = {};
      if (body) {
        try {
          parsed = JSON.parse(body) as Record<string, unknown>;
        } catch {
          parsed = { body };
        }
      }
      const result: HermesHealthState = { ok: healthRes.ok, ...parsed };
      if (target.name === 'bridge') bridge = result;
      else gateway = result;
      if (healthRes.ok && (result.ok === true || result.status === 'ok')) {
        return { ok: true, target: target.name, bridge, gateway };
      }
      lastError = typeof result.error === 'string'
        ? result.error
        : healthRes.ok
          ? 'Health endpoint reported not ready'
          : `Health endpoint responded ${healthRes.status}`;
    } catch (err: any) {
      const result = { ok: false, error: err.message };
      if (target.name === 'bridge') bridge = result;
      else gateway = result;
      lastError = err.message;
    }
  }

  // The api_server has refused to start without API_SERVER_KEY since Hermes
  // v0.15.0, so an unreachable hermes-openai target with no key resolvable is
  // overwhelmingly a missing-key problem — surface that instead of a bare
  // "fetch failed" in the Node UI's degraded status.
  if (
    targets.some((t) => t.protocol === 'hermes-openai')
    && !resolveHermesApiServerKey(config)
  ) {
    lastError = `${lastError} — Hermes api_server requires API_SERVER_KEY (Hermes v0.15.0+); ${hermesApiServerKeyRemediation(config)}.`;
  }

  return { ok: false, bridge, gateway, error: lastError };
}

export async function ensureHermesBridgeAvailable(
  target: HermesChannelTarget,
  bridgeAuthToken: string | undefined,
): Promise<{
  ok: boolean;
  status?: number;
  details?: string;
  offline?: boolean;
}> {
  if (target.name !== 'bridge' || !target.healthUrl) return { ok: true };
  if (!bridgeAuthToken) {
    return { ok: false, details: 'Bridge auth token unavailable', offline: true };
  }

  try {
    const healthRes = await fetch(target.healthUrl, {
      headers: buildHermesChannelHeaders(target, bridgeAuthToken, { Accept: 'application/json' }, target.healthUrl),
      signal: AbortSignal.timeout(3_000),
    });
    const body = await healthRes.text().catch(() => '');
    let parsed: Record<string, unknown> = {};
    if (body) {
      try {
        parsed = JSON.parse(body) as Record<string, unknown>;
      } catch {
        parsed = { body };
      }
    }
    if (!healthRes.ok) {
      return {
        ok: false,
        status: healthRes.status,
        details: body || `Bridge health responded ${healthRes.status}`,
        offline: true,
      };
    }
    if (parsed.ok !== true) {
      return {
        ok: false,
        status: healthRes.status,
        details: typeof parsed.error === 'string'
          ? parsed.error
          : 'Bridge health reported not ready',
        offline: true,
      };
    }
    return { ok: true };
  } catch (err: any) {
    return { ok: false, details: err.message, offline: true };
  }
}

export function shouldTryNextHermesTarget(status: number): boolean {
  return status === 404 || status === 405 || (status >= 500 && status < 600);
}

export function normalizeHermesChatPayload(raw: unknown): HermesChatPayload | { error: string } {
  if (!isPlainRecord(raw)) return { error: 'Invalid JSON body' };

  const normalizedAttachmentRefs = normalizeOpenClawAttachmentRefs(raw.attachmentRefs);
  if (raw.attachmentRefs != null && normalizedAttachmentRefs === undefined) {
    return { error: 'Invalid "attachmentRefs"' };
  }
  const normalizedDirectAttachmentImportResults = normalizeOpenClawAttachmentImportResults(raw.attachmentImportResults);
  if (raw.attachmentImportResults != null && normalizedDirectAttachmentImportResults === undefined) {
    return { error: 'Invalid "attachmentImportResults"' };
  }
  const normalizedContextPayload = normalizeOpenClawChatContextEntriesWithAttachmentImportResults(raw.contextEntries);
  if (raw.contextEntries != null && normalizedContextPayload === undefined) {
    return { error: 'Invalid "contextEntries"' };
  }
  const normalizedContextEntries = normalizedContextPayload?.contextEntries;
  const normalizedLegacyAttachmentImportResults = normalizedContextPayload?.attachmentImportResults;
  const normalizedAttachmentImportResults = dedupeOpenClawAttachmentImportResults((
    normalizedDirectAttachmentImportResults != null || normalizedLegacyAttachmentImportResults?.length
  )
    ? [
      ...(normalizedDirectAttachmentImportResults ?? []),
      ...(normalizedLegacyAttachmentImportResults ?? []),
    ]
    : undefined);

  if (raw.text !== undefined && typeof raw.text !== 'string') {
    return { error: 'Invalid "text"' };
  }
  const text = typeof raw.text === 'string' ? raw.text : '';
  if (
    text.length === 0 &&
    !normalizedAttachmentRefs?.length &&
    !normalizedAttachmentImportResults?.length &&
    !normalizedContextEntries?.length
  ) {
    return { error: 'Missing "text"' };
  }

  const contextGraphId = optionalTrimmedString(raw.contextGraphId);
  if (raw.persistUserMessage != null && typeof raw.persistUserMessage !== 'string') {
    return { error: 'Invalid "persistUserMessage"' };
  }

  return {
    text,
    correlationId: optionalTrimmedString(raw.correlationId) ?? randomUUID(),
    identity: optionalTrimmedString(raw.identity),
    sessionId: optionalTrimmedString(raw.sessionId),
    profile: optionalTrimmedString(raw.profile),
    persistUserMessage: typeof raw.persistUserMessage === 'string' && raw.persistUserMessage.trim()
      ? raw.persistUserMessage
      : undefined,
    attachmentRefs: normalizedAttachmentRefs,
    attachmentImportResults: normalizedAttachmentImportResults,
    contextEntries: normalizedContextEntries,
    contextGraphId,
    currentAgentAddress: optionalTrimmedString(raw.currentAgentAddress),
  };
}

export function buildStableHermesTurnId(args: {
  sessionId: string;
  idempotencyKey?: string;
  correlationId?: string;
  profile?: string;
  contextGraphId?: string;
  nonce?: string;
}): string {
  const discriminator = args.idempotencyKey ?? args.correlationId ?? args.nonce;
  if (!discriminator) return `hermes-${randomUUID()}`;

  const hash = createHash('sha256')
    .update(JSON.stringify({
      sessionId: args.sessionId,
      discriminator,
      profile: args.profile ?? '',
      contextGraphId: args.contextGraphId ?? '',
    }))
    .digest('hex')
    .slice(0, 32);
  return `hermes-${hash}`;
}

export function hermesPersistTurnKey(sessionId: string, turnId: string): string {
  return `${sessionId}\n${turnId}`;
}

export async function hasPersistedHermesTurn(
  memoryManager: Pick<ChatMemoryManager, 'hasChatTurn'> & Partial<Pick<ChatMemoryManager, 'getChatTurnPersistenceState'>>,
  sessionId: string,
  turnId: string,
): Promise<boolean> {
  return (await getPersistedHermesTurnState(memoryManager, sessionId, turnId)) === 'stored';
}

export async function getPersistedHermesTurnState(
  memoryManager: Pick<ChatMemoryManager, 'hasChatTurn'> & Partial<Pick<ChatMemoryManager, 'getChatTurnPersistenceState'>>,
  sessionId: string,
  turnId: string,
): Promise<HermesTurnPersistenceState | null> {
  if (typeof memoryManager.getChatTurnPersistenceState === 'function') {
    return await memoryManager.getChatTurnPersistenceState(sessionId, turnId);
  }
  return await memoryManager.hasChatTurn(sessionId, turnId) ? 'stored' : null;
}

export function normalizeHermesPersistTurnPayload(raw: unknown): HermesPersistTurnPayload | { error: string } {
  if (!isPlainRecord(raw)) return { error: 'Invalid JSON body' };

  const sessionId = optionalTrimmedString(raw.sessionId);
  if (!sessionId) return { error: 'Missing required field: sessionId' };
  const sessionIdError = validateHermesChatIdentifier(sessionId, 'sessionId');
  if (sessionIdError) return { error: sessionIdError };

  const userMessage = typeof raw.userMessage === 'string' ? raw.userMessage : '';
  const assistantReply = typeof raw.assistantReply === 'string' ? raw.assistantReply : '';
  if (userMessage.length === 0 && assistantReply.length === 0) {
    return { error: 'Missing required field: userMessage or assistantReply' };
  }

  const normalizedAttachmentRefs = normalizeOpenClawAttachmentRefs(raw.attachmentRefs);
  if (raw.attachmentRefs != null && normalizedAttachmentRefs === undefined) {
    return { error: 'Invalid "attachmentRefs"' };
  }
  const persistenceState =
    raw.persistenceState === undefined
      ? 'stored'
      : raw.persistenceState === 'stored' || raw.persistenceState === 'failed' || raw.persistenceState === 'pending'
        ? raw.persistenceState
        : null;
  if (!persistenceState) return { error: 'Invalid "persistenceState"' };
  const failureReason = optionalTrimmedString(raw.failureReason);
  const toolCalls = Array.isArray(raw.toolCalls)
    ? raw.toolCalls.filter(isPlainRecord).map((toolCall) => ({
        name: optionalTrimmedString(toolCall.name) ?? 'unknown',
        args: isPlainRecord(toolCall.args) ? toolCall.args : {},
        result: toolCall.result,
      }))
    : undefined;
  const contextGraphId = optionalTrimmedString(raw.contextGraphId);
  const profile = optionalTrimmedString(raw.profile);
  const correlationId = optionalTrimmedString(raw.correlationId);
  const idempotencyKey = optionalTrimmedString(raw.idempotencyKey);
  const metadata = isPlainRecord(raw.metadata) ? raw.metadata : undefined;
  const turnId = optionalTrimmedString(raw.turnId) ?? buildStableHermesTurnId({
    sessionId,
    idempotencyKey,
    correlationId,
    profile,
    contextGraphId,
  });
  const turnIdError = validateHermesChatIdentifier(turnId, 'turnId');
  if (turnIdError) return { error: turnIdError };

  return {
    sessionId,
    userMessage,
    assistantReply,
    turnId,
    correlationId,
    idempotencyKey,
    toolCalls,
    attachmentRefs: normalizedAttachmentRefs,
    persistenceState,
    failureReason,
    contextGraphId,
    profile,
    metadata,
  };
}

export async function verifyHermesAttachmentRefsProvenance(
  agent: Pick<DKGAgent, 'store'>,
  extractionStatus: Map<string, ExtractionStatusRecord>,
  attachmentRefs: OpenClawAttachmentRef[] | undefined,
): Promise<OpenClawAttachmentRef[] | undefined> {
  return verifyOpenClawAttachmentRefsProvenance(agent, extractionStatus, attachmentRefs);
}

export async function verifyHermesAttachmentImportResultsProvenance(
  agent: Pick<DKGAgent, 'store'>,
  extractionStatus: Map<string, ExtractionStatusRecord>,
  attachmentImportResults: OpenClawAttachmentImportResult[] | undefined,
): Promise<OpenClawAttachmentImportResult[] | undefined> {
  return verifyOpenClawAttachmentImportResultsProvenance(agent, extractionStatus, attachmentImportResults);
}

export async function pipeHermesStream(
  req: OpenClawStreamRequest,
  res: OpenClawStreamResponse,
  reader: OpenClawStreamReader,
): Promise<void> {
  return pipeOpenClawStream(req, res, reader);
}

export async function runHermesUiSetup(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('Hermes attach cancelled');
  const { runHermesSetup } = await import('@origintrail-official/dkg-adapter-hermes');
  const { loadBundledDkgNodeSkill } = await import('../hermes-setup.js');
  return runHermesSetup({
    start: false,
    verify: false,
    signal,
    invokedBy: 'ui',
    nodeSkillContent: loadBundledDkgNodeSkill(),
  });
}
