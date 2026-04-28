import { createHash, randomUUID } from 'node:crypto';

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
  normalizeOpenClawChatContextEntries,
  pipeOpenClawStream,
  trimTrailingSlashes,
  verifyOpenClawAttachmentRefsProvenance,
  type OpenClawAttachmentRef,
  type OpenClawChatContextEntry,
  type OpenClawStreamReader,
  type OpenClawStreamRequest,
  type OpenClawStreamResponse,
} from './openclaw.js';

export const HERMES_CHANNEL_RESPONSE_TIMEOUT_MS = 180_000;
export const DEFAULT_HERMES_BRIDGE_URL = 'http://127.0.0.1:9202';

export interface HermesChannelTarget {
  name: 'bridge' | 'gateway';
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
  attachmentRefs?: OpenClawAttachmentRef[];
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function optionalTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
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
    return host === 'localhost' || host === '[::1]' || host === '::1' || host.startsWith('127.');
  } catch {
    return false;
  }
}

export function getHermesChannelTargets(config: DkgConfig): HermesChannelTarget[] {
  const storedHermesIntegration = getStoredLocalAgentIntegrations(config).hermes;
  if (storedHermesIntegration?.enabled === false) return [];

  const hermesIntegration = getLocalAgentIntegration(config, 'hermes');
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
  const standaloneBridgeBase = explicitBridgeBase
    ? bridgeLooksLikeGateway
      ? undefined
      : explicitBridgeBase
    : !explicitGatewayBase
      ? DEFAULT_HERMES_BRIDGE_URL
      : undefined;
  const gatewayBase =
    explicitGatewayBase ??
    (bridgeLooksLikeGateway ? explicitBridgeBase : undefined);
  const normalizedGatewayBase = gatewayBase
    ? buildHermesGatewayBase(gatewayBase)
    : undefined;
  const explicitHealthIsGateway =
    !!explicitHealthUrl
    && !!gatewayBase
    && (
      urlBelongsToBase(explicitHealthUrl, gatewayBase)
      || (!!normalizedGatewayBase && urlBelongsToBase(explicitHealthUrl, normalizedGatewayBase))
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
      healthUrl: explicitHealthUrl && !explicitHealthIsGateway
        ? explicitHealthUrl
        : `${standaloneBridgeBase}/health`,
    });
  }

  if (normalizedGatewayBase) {
    pushTarget({
      name: 'gateway',
      inboundUrl: `${normalizedGatewayBase}/send`,
      streamUrl: `${normalizedGatewayBase}/stream`,
      healthUrl: explicitHealthUrl && (explicitHealthIsGateway || !standaloneBridgeBase)
        ? explicitHealthUrl
        : `${normalizedGatewayBase}/health`,
    });
  }

  return targets;
}

export function buildHermesChannelHeaders(
  target: HermesChannelTarget,
  bridgeAuthToken: string | undefined,
  baseHeaders: Record<string, string> = {},
  requestUrl = target.inboundUrl,
): Record<string, string> {
  if (
    target.name !== 'bridge' ||
    !bridgeAuthToken ||
    !isHermesLoopbackUrl(requestUrl)
  ) {
    return baseHeaders;
  }
  return { ...baseHeaders, 'x-dkg-bridge-token': bridgeAuthToken };
}

export function transportPatchFromHermesTarget(
  config: DkgConfig,
  targetName: 'bridge' | 'gateway' | undefined,
): LocalAgentIntegrationTransport | undefined {
  if (!targetName) return undefined;
  const hermesIntegration = getLocalAgentIntegration(config, 'hermes');
  const existingTransport = hermesIntegration?.transport ?? {};
  const explicitHealth = existingTransport.healthUrl
    ? { healthUrl: existingTransport.healthUrl }
    : {};
  const target = getHermesChannelTargets(config).find((item) => item.name === targetName);
  if (!target) return undefined;

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
      if (healthRes.ok && result.ok === true) {
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
  const normalizedContextEntries = normalizeOpenClawChatContextEntries(raw.contextEntries);
  if (raw.contextEntries != null && normalizedContextEntries === undefined) {
    return { error: 'Invalid "contextEntries"' };
  }

  const text = typeof raw.text === 'string' ? raw.text : '';
  if (text.length === 0 && !normalizedAttachmentRefs?.length) {
    return { error: 'Missing "text"' };
  }

  const contextGraphId = optionalTrimmedString(raw.contextGraphId);

  return {
    text,
    correlationId: optionalTrimmedString(raw.correlationId) ?? randomUUID(),
    identity: optionalTrimmedString(raw.identity),
    sessionId: optionalTrimmedString(raw.sessionId),
    profile: optionalTrimmedString(raw.profile),
    attachmentRefs: normalizedAttachmentRefs,
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
  memoryManager: Pick<ChatMemoryManager, 'hasChatTurn'>,
  sessionId: string,
  turnId: string,
): Promise<boolean> {
  return memoryManager.hasChatTurn(sessionId, turnId);
}

export function normalizeHermesPersistTurnPayload(raw: unknown): HermesPersistTurnPayload | { error: string } {
  if (!isPlainRecord(raw)) return { error: 'Invalid JSON body' };

  const sessionId = optionalTrimmedString(raw.sessionId);
  if (!sessionId) return { error: 'Missing required field: sessionId' };

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
    raw.persistenceState === 'failed' || raw.persistenceState === 'pending'
      ? raw.persistenceState
      : 'stored';
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

export async function pipeHermesStream(
  req: OpenClawStreamRequest,
  res: OpenClawStreamResponse,
  reader: OpenClawStreamReader,
): Promise<void> {
  return pipeOpenClawStream(req, res, reader);
}
