/**
 * Daemon-side Prime Agent channel plumbing.
 *
 * Deliberately parallel to `hermes.ts`, and it REUSES the OpenClaw stream and
 * attachment helpers rather than forking them — `hermes.ts` does exactly the
 * same, and three copies of an SSE pump is three places for backpressure bugs
 * to hide.
 *
 * The one structural difference from Hermes: there is no single, statically
 * configured bridge URL. Prime Agent loads extensions per session into the
 * worker that owns that session, so each live session publishes its own
 * loopback bridge into a discovery directory. Target resolution therefore reads
 * that directory instead of reading config.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  isLoopbackBridgeUrl,
  readLiveSessions,
  type PrimeAgentSessionDescriptor as AdapterPrimeAgentSessionDescriptor,
} from '@origintrail-official/dkg-adapter-prime-agent';

export const PRIME_AGENT_CHANNEL_RESPONSE_TIMEOUT_MS = 15 * 60_000;
/**
 * Absolute backstop for the /send and /stream fetches, deliberately far above
 * the bridge's activity-based idle timeout (which equals the response-timeout
 * constant above). The bridge is the authority on turn liveness — its 504
 * preserves partial output — so the daemon-side abort exists only to reap a
 * hung transport that will never deliver that 504. An abort at or below the
 * bridge's window would race it, kill actively-streaming long turns mid-flight,
 * and make the 504-propagation branch unreachable.
 */
export const PRIME_AGENT_CHANNEL_HARD_TIMEOUT_MS = 60 * 60_000;
export const PRIME_AGENT_HEALTH_TIMEOUT_MS = 5_000;
export const PRIME_AGENT_PRE_SEND_TIMEOUT_MS = 3_000;
export const PRIME_AGENT_TRANSPORT_KIND = 'prime-agent-channel';
export const PRIME_AGENT_DKG_SESSION_PREFIX = 'prime-agent:dkg-ui:';

export type PrimeAgentSessionDescriptor = AdapterPrimeAgentSessionDescriptor;

export interface PrimeAgentChannelTarget {
  sessionId: string;
  inboundUrl: string;
  streamUrl: string;
  healthUrl: string;
}

export interface PrimeAgentChannelHealthReport {
  ok: boolean;
  sessionCount: number;
  sessions: PrimeAgentSessionDescriptor[];
  target?: string;
  error?: string;
}

/**
 * Loopback-only. A descriptor file is written by another process, so it is
 * untrusted input: the daemon must never be talked into POSTing a user's chat
 * to an off-box address by a malicious or corrupted descriptor.
 */
export function isPrimeAgentLoopbackUrl(value: string | undefined): boolean {
  return isLoopbackBridgeUrl(value);
}

export function primeAgentSessionsDir(agentDir?: string): string {
  const base = agentDir ?? process.env.PRIME_AGENT_CODING_AGENT_DIR ?? join(homedir(), '.prime', 'agent');
  return join(base, '.dkg-adapter-prime-agent', 'sessions');
}

/**
 * Live sessions, most recently active first (`lastActiveAt`, stamped per turn,
 * falling back to `startedAt`) — a session resumed by Prime Agent's daemon can
 * have a newer descriptor than the one the operator is actually using. The
 * adapter owns descriptor validation, liveness and ordering so setup/verify
 * and daemon routing cannot drift apart.
 */
export function readPrimeAgentSessions(sessionsDir?: string): PrimeAgentSessionDescriptor[] {
  return readLiveSessions(sessionsDir ?? primeAgentSessionsDir());
}

export function targetFromDescriptor(d: PrimeAgentSessionDescriptor): PrimeAgentChannelTarget {
  const base = d.bridgeUrl.replace(/\/$/, '');
  return {
    sessionId: d.sessionId,
    inboundUrl: `${base}/send`,
    streamUrl: `${base}/stream`,
    healthUrl: `${base}/health`,
  };
}

/**
 * Ordered target list, most recently active first. An explicit session id
 * selects exactly one target and a miss yields none — a silent fallback to
 * "some other session" would deliver a user's message to a conversation they
 * were not looking at.
 */
export function getPrimeAgentChannelTargets(opts: {
  sessionsDir?: string;
  sessionId?: string;
  enabled?: boolean;
} = {}): PrimeAgentChannelTarget[] {
  if (opts.enabled === false) return [];
  const sessions = readPrimeAgentSessions(opts.sessionsDir);
  if (opts.sessionId) {
    const match = sessions.find((s) => s.sessionId === opts.sessionId);
    return match ? [targetFromDescriptor(match)] : [];
  }
  return sessions.map(targetFromDescriptor);
}

/** Bridge token is route-scoped and only ever sent to a loopback bridge. */
export function buildPrimeAgentChannelHeaders(
  target: PrimeAgentChannelTarget,
  bridgeAuthToken: string | undefined,
  baseHeaders: Record<string, string> = {},
  requestUrl: string = target.inboundUrl,
): Record<string, string> {
  const headers: Record<string, string> = { ...baseHeaders };
  if (bridgeAuthToken && isPrimeAgentLoopbackUrl(requestUrl)) {
    headers['x-dkg-bridge-token'] = bridgeAuthToken;
  }
  return headers;
}

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = { body: text };
  }
  return { ok: res.ok, status: res.status, body };
}

export async function probePrimeAgentChannelHealth(
  bridgeAuthToken: string | undefined,
  opts: { sessionsDir?: string; timeoutMs?: number } = {},
): Promise<PrimeAgentChannelHealthReport> {
  const sessions = readPrimeAgentSessions(opts.sessionsDir);
  if (sessions.length === 0) {
    // Not an error: the adapter can be correctly installed with no session
    // running. Callers should render this as "idle", not "broken".
    return { ok: false, sessionCount: 0, sessions: [], error: 'no live Prime Agent session' };
  }
  const timeout = opts.timeoutMs ?? PRIME_AGENT_HEALTH_TIMEOUT_MS;
  let lastError: string | undefined;
  for (const descriptor of sessions) {
    const target = targetFromDescriptor(descriptor);
    try {
      const { ok, body } = await fetchJson(
        target.healthUrl,
        {
          method: 'GET',
          headers: buildPrimeAgentChannelHeaders(
            target,
            bridgeAuthToken,
            { Accept: 'application/json' },
            target.healthUrl,
          ),
        },
        timeout,
      );
      const parsed = body as { ok?: boolean; sessionId?: string };
      if (ok && parsed?.ok === true) {
        // Detect a recycled port: the descriptor claims one session, the
        // process answering claims another.
        if (parsed.sessionId && parsed.sessionId !== descriptor.sessionId) {
          lastError = `bridge at ${target.healthUrl} reports session ${parsed.sessionId}, expected ${descriptor.sessionId}`;
          continue;
        }
        return { ok: true, sessionCount: sessions.length, sessions, target: descriptor.sessionId };
      }
      lastError = `health check failed for session ${descriptor.sessionId}`;
    } catch (err) {
      lastError = `health check error for session ${descriptor.sessionId}: ${String(err).slice(0, 120)}`;
    }
  }
  return { ok: false, sessionCount: sessions.length, sessions, ...(lastError ? { error: lastError } : {}) };
}

/** Pre-send gate, mirroring ensureHermesBridgeAvailable. */
export async function ensurePrimeAgentBridgeAvailable(
  target: PrimeAgentChannelTarget,
  bridgeAuthToken: string | undefined,
): Promise<{ ok: boolean; status?: number; details?: string; offline?: boolean }> {
  if (!bridgeAuthToken) {
    return { ok: false, details: 'Bridge auth token unavailable', offline: true };
  }
  try {
    const { ok, status, body } = await fetchJson(
      target.healthUrl,
      {
        method: 'GET',
        headers: buildPrimeAgentChannelHeaders(
          target,
          bridgeAuthToken,
          { Accept: 'application/json' },
          target.healthUrl,
        ),
      },
      PRIME_AGENT_PRE_SEND_TIMEOUT_MS,
    );
    const parsed = body as { ok?: boolean; sessionId?: string };
    if (!ok || parsed?.ok !== true) {
      return { ok: false, status, details: 'bridge did not report ok', offline: true };
    }
    // A recycled port can answer ok:true as some OTHER session; delivering
    // there would silently reroute the chat. Same echo check the probe path
    // applies.
    if (parsed.sessionId && parsed.sessionId !== target.sessionId) {
      return {
        ok: false,
        status,
        details: `bridge reports session ${parsed.sessionId}, expected ${target.sessionId}`,
        offline: true,
      };
    }
    return { ok: true, status };
  } catch (err) {
    return { ok: false, details: String(err).slice(0, 160), offline: true };
  }
}

export interface PrimeAgentChatPayload {
  text: string;
  correlationId: string;
  sessionId?: string;
  contextGraphId?: string;
  identity?: string;
  persistUserMessage?: boolean;
  metadata?: Record<string, unknown>;
}

export type PrimeAgentTurnPersistenceState = 'stored' | 'failed' | 'pending';

export interface PrimeAgentPersistTurnPayload {
  sessionId: string;
  userMessage: string;
  assistantReply: string;
  correlationId?: string;
  turnId?: string;
  persistenceState: PrimeAgentTurnPersistenceState;
  failureReason?: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown>; result: unknown }>;
  metadata?: Record<string, unknown>;
}

export function primeAgentDkgSessionId(sessionId: string): string {
  const trimmed = sessionId.trim();
  return trimmed.startsWith(PRIME_AGENT_DKG_SESSION_PREFIX)
    ? trimmed
    : `${PRIME_AGENT_DKG_SESSION_PREFIX}${trimmed}`;
}

export function primeAgentRawSessionId(sessionId: string): string {
  const trimmed = sessionId.trim();
  return trimmed.startsWith(PRIME_AGENT_DKG_SESSION_PREFIX)
    ? trimmed.slice(PRIME_AGENT_DKG_SESSION_PREFIX.length)
    : trimmed;
}

export function normalizePrimeAgentChatPayload(raw: unknown): PrimeAgentChatPayload | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'Invalid payload' };
  const r = raw as Record<string, unknown>;
  const text = typeof r.text === 'string' ? r.text.trim() : '';
  if (!text) return { error: 'Missing "text"' };
  const correlationId = typeof r.correlationId === 'string' ? r.correlationId.trim() : '';
  if (!correlationId) return { error: 'Missing "correlationId"' };
  if (r.sessionId !== undefined && typeof r.sessionId !== 'string') {
    return { error: 'Invalid "sessionId"' };
  }
  if (r.sessionId !== undefined && !/^[A-Za-z0-9._:-]{1,200}$/.test(r.sessionId as string)) {
    return { error: 'Invalid "sessionId"' };
  }
  return {
    text,
    correlationId,
    ...(typeof r.sessionId === 'string' ? { sessionId: r.sessionId } : {}),
    ...(typeof r.contextGraphId === 'string' ? { contextGraphId: r.contextGraphId } : {}),
    ...(typeof r.identity === 'string' ? { identity: r.identity } : {}),
    ...(typeof r.persistUserMessage === 'boolean' ? { persistUserMessage: r.persistUserMessage } : {}),
    ...(r.metadata && typeof r.metadata === 'object'
      ? { metadata: r.metadata as Record<string, unknown> }
      : {}),
  };
}

export function normalizePrimeAgentPersistTurnPayload(raw: unknown): PrimeAgentPersistTurnPayload | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'Invalid payload' };
  const r = raw as Record<string, unknown>;
  const sessionId = typeof r.sessionId === 'string' ? r.sessionId.trim() : '';
  if (!sessionId) return { error: 'Missing "sessionId"' };
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(sessionId)) return { error: 'Invalid "sessionId"' };
  const userMessage = typeof r.userMessage === 'string' ? r.userMessage : '';
  if (!userMessage.trim()) return { error: 'Missing "userMessage"' };
  const assistantReply = typeof r.assistantReply === 'string' ? r.assistantReply : '';
  const correlationId = typeof r.correlationId === 'string' ? r.correlationId.trim() : '';
  const turnId = typeof r.turnId === 'string' ? r.turnId.trim() : '';
  const persistenceState =
    r.persistenceState === 'failed' || r.persistenceState === 'pending'
      ? r.persistenceState
      : 'stored';
  const failureReason = typeof r.failureReason === 'string' ? r.failureReason.trim() : '';
  const toolCalls = Array.isArray(r.toolCalls)
    ? r.toolCalls.filter((entry): entry is { name: string; args: Record<string, unknown>; result: unknown } =>
        !!entry
        && typeof entry === 'object'
        && typeof (entry as { name?: unknown }).name === 'string'
        && (entry as { name: string }).name.trim().length > 0,
      )
    : undefined;
  return {
    sessionId,
    userMessage,
    assistantReply,
    ...(correlationId ? { correlationId } : {}),
    ...(turnId ? { turnId } : {}),
    persistenceState,
    ...(failureReason ? { failureReason } : {}),
    ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
    ...(r.metadata && typeof r.metadata === 'object' && !Array.isArray(r.metadata)
      ? { metadata: r.metadata as Record<string, unknown> }
      : {}),
  };
}

/**
 * Transport patch for the persisted integration record. Reverse-maps a live
 * target back to config shape, stripping the route suffix the same way
 * `transportPatchFromHermesTarget` does.
 */
export function transportPatchFromPrimeAgentTarget(
  target: PrimeAgentChannelTarget | undefined,
): { kind: string; bridgeUrl?: string; healthUrl?: string } | undefined {
  if (!target) return undefined;
  const base = target.inboundUrl.replace(/\/send$/, '');
  return { kind: PRIME_AGENT_TRANSPORT_KIND, bridgeUrl: base, healthUrl: target.healthUrl };
}
