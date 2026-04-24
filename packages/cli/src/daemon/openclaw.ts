// OpenClaw channel/bridge/attach machinery extracted from the legacy
// monolithic `daemon.ts`. Owns the gateway helpers, UI-attach job
// machinery, channel headers, the streaming pipe, attachment-ref
// normalisation, and provenance verification.
//
// Bridge health cache lives in `./state.ts` (mutated from
// `handle-request.ts` after each /send round trip).
// `pendingOpenClawUiAttachJobs` is module-private working memory
// and is intentionally not exported.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { execFile, exec } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import type { DKGAgent } from '@origintrail-official/dkg-agent';
import {
  contextGraphAssertionUri,
  contextGraphMetaUri,
  isSafeIri,
  validateSubGraphName,
  type Logger,
} from '@origintrail-official/dkg-core';
import {
  dkgDir,
  saveConfig,
  loadConfig,
  type DkgConfig,
  type LocalAgentIntegrationConfig,
  type LocalAgentIntegrationTransport,
} from '../config.js';
import {
  type ExtractionStatusRecord,
  getExtractionStatusRecord,
} from '../extraction-status.js';
import { daemonState } from './state.js';
import { normalizeDetectedContentType } from './manifest.js';
// Cycle: local-agents imports lots from openclaw, and openclaw needs
// these two getters from local-agents. TS handles the cycle because
// every reference is inside a function body (not module-init).
import {
  getStoredLocalAgentIntegrations,
  getLocalAgentIntegration,
} from './local-agents.js';

const daemonRequire = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

// Tiny module-private helper duplicated from `./local-agents.ts` to
// avoid a deeper cycle (the canonical `isPlainRecord` is only used
// within local-agents normalisation; openclaw uses it once for
// attachment-ref normalisation).
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// OpenClaw bridge health cache — avoids hammering the bridge on every /send
const BRIDGE_HEALTH_CACHE_OK_TTL_MS = 10_000;
const BRIDGE_HEALTH_CACHE_ERROR_TTL_MS = 1_000;
export const OPENCLAW_UI_CONNECT_TIMEOUT_MS = 150_000;
export const OPENCLAW_UI_CONNECT_POLL_MS = 1_500;
export const OPENCLAW_CHANNEL_RESPONSE_TIMEOUT_MS = 180_000;
export type PendingOpenClawUiAttachJob = {
  job: Promise<void>;
  controller: AbortController;
  cancelled: boolean;
};
const pendingOpenClawUiAttachJobs = new Map<string, PendingOpenClawUiAttachJob>();

export function isOpenClawBridgeHealthCacheValid(cache: { ok: boolean; ts: number } | null): boolean {
  if (!cache) return false;
  const ttl = cache.ok ? BRIDGE_HEALTH_CACHE_OK_TTL_MS : BRIDGE_HEALTH_CACHE_ERROR_TTL_MS;
  return Date.now() - cache.ts < ttl;
}

export interface OpenClawChannelTarget {
  name: "bridge" | "gateway";
  inboundUrl: string;
  streamUrl?: string;
  healthUrl?: string;
}

export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return value.slice(0, end);
}

export function buildOpenClawGatewayBase(value: string): string {
  return value.endsWith("/api/dkg-channel")
    ? value
    : `${value}/api/dkg-channel`;
}

export async function loadBridgeAuthToken(): Promise<string | undefined> {
  try {
    const raw = await readFile(join(dkgDir(), "auth.token"), "utf-8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith("#"));
  } catch {
    return undefined;
  }
}


export function getOpenClawChannelTargets(config: DkgConfig): OpenClawChannelTarget[] {
  const storedOpenClawIntegration = getStoredLocalAgentIntegrations(config).openclaw;
  if (storedOpenClawIntegration?.enabled === false) return [];

  const openclawIntegration = getLocalAgentIntegration(config, 'openclaw');
  const explicitBridgeBase = openclawIntegration?.transport.bridgeUrl
    ? trimTrailingSlashes(openclawIntegration.transport.bridgeUrl)
    : undefined;
  const explicitGatewayBase = openclawIntegration?.transport.gatewayUrl
    ? trimTrailingSlashes(openclawIntegration.transport.gatewayUrl)
    : undefined;
  const bridgeLooksLikeGateway =
    explicitBridgeBase?.endsWith("/api/dkg-channel") ?? false;
  const standaloneBridgeBase = explicitBridgeBase
    ? bridgeLooksLikeGateway
      ? undefined
      : explicitBridgeBase
    : !explicitGatewayBase
      ? "http://127.0.0.1:9201"
      : undefined;
  const gatewayBase =
    explicitGatewayBase ??
    (bridgeLooksLikeGateway ? explicitBridgeBase : undefined);
  const targets: OpenClawChannelTarget[] = [];
  const seenInboundUrls = new Set<string>();

  const pushTarget = (target: OpenClawChannelTarget) => {
    if (seenInboundUrls.has(target.inboundUrl)) return;
    seenInboundUrls.add(target.inboundUrl);
    targets.push(target);
  };

  if (standaloneBridgeBase) {
    pushTarget({
      name: "bridge",
      inboundUrl: `${standaloneBridgeBase}/inbound`,
      streamUrl: `${standaloneBridgeBase}/inbound/stream`,
      healthUrl: `${standaloneBridgeBase}/health`,
    });
  }

  if (gatewayBase) {
    const normalizedGatewayBase = buildOpenClawGatewayBase(gatewayBase);
    pushTarget({
      name: "gateway",
      inboundUrl: `${normalizedGatewayBase}/inbound`,
      healthUrl: `${normalizedGatewayBase}/health`,
    });
  }

  return targets;
}

export type OpenClawBridgeHealthState = Record<string, unknown> & {
  ok: boolean;
  channel?: string;
  cached?: boolean;
  error?: string;
};

export type OpenClawGatewayHealthState = Record<string, unknown> & {
  ok: boolean;
  channel?: string;
  error?: string;
};

export interface OpenClawChannelHealthReport {
  ok: boolean;
  target?: 'bridge' | 'gateway';
  bridge?: OpenClawBridgeHealthState;
  gateway?: OpenClawGatewayHealthState;
  error?: string;
}

export function transportPatchFromOpenClawTarget(
  config: DkgConfig,
  targetName: 'bridge' | 'gateway' | undefined,
): LocalAgentIntegrationTransport | undefined {
  if (!targetName) return undefined;
  const target = getOpenClawChannelTargets(config).find((item) => item.name === targetName);
  if (!target) return undefined;

  if (target.name === 'bridge') {
    const bridgeBase = target.inboundUrl.endsWith('/inbound')
      ? target.inboundUrl.slice(0, -'/inbound'.length)
      : target.inboundUrl;
    return {
      kind: 'openclaw-channel',
      bridgeUrl: bridgeBase,
      ...(target.healthUrl ? { healthUrl: target.healthUrl } : {}),
    };
  }

  const gatewayBase = target.inboundUrl.endsWith('/inbound')
    ? target.inboundUrl.slice(0, -'/inbound'.length)
    : target.inboundUrl;
  const gatewayUrl = gatewayBase.endsWith('/api/dkg-channel')
    ? gatewayBase.slice(0, -'/api/dkg-channel'.length)
    : gatewayBase;
  return {
    kind: 'openclaw-channel',
    gatewayUrl,
    ...(target.healthUrl ? { healthUrl: target.healthUrl } : {}),
  };
}

export async function probeOpenClawChannelHealth(
  config: DkgConfig,
  bridgeAuthToken: string | undefined,
  opts: { ignoreBridgeCache?: boolean; timeoutMs?: number } = {},
): Promise<OpenClawChannelHealthReport> {
  const targets = getOpenClawChannelTargets(config);
  let bridge: OpenClawBridgeHealthState | undefined;
  let gateway: OpenClawGatewayHealthState | undefined;
  let lastError = 'No OpenClaw channel health endpoint configured';
  const timeoutMs = opts.timeoutMs ?? 5_000;

  for (const target of targets) {
    if (!target.healthUrl) continue;

    if (target.name === 'bridge') {
      if (!bridgeAuthToken) {
        bridge = { ok: false, error: 'Bridge auth token unavailable' };
        lastError = 'Bridge auth token unavailable';
        continue;
      }

      const cachedBridgeHealth = daemonState.openClawBridgeHealth;
      const cacheValid = !opts.ignoreBridgeCache
        && isOpenClawBridgeHealthCacheValid(cachedBridgeHealth);
      if (cacheValid && cachedBridgeHealth) {
        bridge = { ok: cachedBridgeHealth.ok, cached: true };
        if (cachedBridgeHealth.ok) {
          return { ok: true, target: 'bridge', bridge };
        }
        continue;
      }
    }

    try {
      const healthRes = await fetch(target.healthUrl, {
        headers: buildOpenClawChannelHeaders(target, bridgeAuthToken, { Accept: 'application/json' }),
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
      const result: Record<string, unknown> & { ok: boolean } = { ok: healthRes.ok, ...parsed };
      if (target.name === 'bridge') {
        daemonState.openClawBridgeHealth = { ok: healthRes.ok, ts: Date.now() };
        bridge = result;
      } else {
        gateway = result;
      }
      if (healthRes.ok) {
        return {
          ok: true,
          target: target.name,
          bridge,
          gateway,
        };
      }
      lastError = typeof result.error === 'string'
        ? result.error
        : `Health endpoint responded ${healthRes.status}`;
    } catch (err: any) {
      const result = { ok: false, error: err.message };
      if (target.name === 'bridge') {
        daemonState.openClawBridgeHealth = { ok: false, ts: Date.now() };
        bridge = result;
      } else {
        gateway = result;
      }
      lastError = err.message;
    }
  }

  return { ok: false, bridge, gateway, error: lastError };
}

export async function runOpenClawUiSetup(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error('OpenClaw attach cancelled');
  const { runSetup } = await import('@origintrail-official/dkg-adapter-openclaw');
  await runSetup({ start: false, verify: false, signal });
}

// KEEP IN SYNC with adapter's openclawConfigPath() — see packages/adapter-openclaw/src/setup.ts.
// Intentionally duplicated to avoid a top-level static import of the adapter barrel, which would
// break `dkg` startup in fresh workspace checkouts where the adapter's `dist/` has not been built
// yet. The DI shape around `verifyMemorySlot` is synchronous, so a dynamic import is not an option
// either — the fallback path has to be callable without awaiting.
export function localOpenclawConfigPath(): string {
  return join(process.env.OPENCLAW_HOME ?? join(homedir(), '.openclaw'), 'openclaw.json');
}

export function isOpenClawMemorySlotElected(openclawConfigPath?: string): boolean {
  const configPath = openclawConfigPath && openclawConfigPath.trim()
    ? openclawConfigPath
    : localOpenclawConfigPath();
  if (!existsSync(configPath)) return false;
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed?.plugins?.slots?.memory === 'adapter-openclaw';
  } catch {
    return false;
  }
}

export async function restartOpenClawGateway(signal?: AbortSignal): Promise<void> {
  await execFileAsync('openclaw', ['gateway', 'restart'], {
    shell: process.platform === 'win32',
    signal,
    timeout: 120_000,
  });
}

export async function waitForOpenClawChatReady(
  config: DkgConfig,
  bridgeAuthToken: string | undefined,
  signal?: AbortSignal,
): Promise<OpenClawChannelHealthReport> {
  const throwIfCancelled = () => {
    if (signal?.aborted) {
      throw new Error('OpenClaw attach cancelled');
    }
  };
  const waitForPoll = async () => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, OPENCLAW_UI_CONNECT_POLL_MS);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('OpenClaw attach cancelled'));
    };
    if (!signal) return;
    if (signal.aborted) {
      clearTimeout(timer);
      reject(new Error('OpenClaw attach cancelled'));
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });

  const deadline = Date.now() + OPENCLAW_UI_CONNECT_TIMEOUT_MS;
  throwIfCancelled();
  let latest = await probeOpenClawChannelHealth(config, bridgeAuthToken, { ignoreBridgeCache: true });
  while (!latest.ok && Date.now() < deadline) {
    await waitForPoll();
    throwIfCancelled();
    latest = await probeOpenClawChannelHealth(config, bridgeAuthToken, { ignoreBridgeCache: true });
  }
  return latest;
}

export type OpenClawUiAttachDeps = {
  runSetup?: (signal?: AbortSignal) => Promise<void>;
  restartGateway?: (signal?: AbortSignal) => Promise<void>;
  waitForReady?: (
    config: DkgConfig,
    bridgeAuthToken: string | undefined,
    signal?: AbortSignal,
  ) => Promise<OpenClawChannelHealthReport>;
  probeHealth?: (
    config: DkgConfig,
    bridgeAuthToken: string | undefined,
    opts?: { ignoreBridgeCache?: boolean; timeoutMs?: number },
  ) => Promise<OpenClawChannelHealthReport>;
  saveConfig?: (config: DkgConfig) => Promise<void>;
  onAttachScheduled?: (id: string, job: Promise<void>) => void;
  verifyMemorySlot?: () => boolean;
};

export function formatOpenClawUiAttachFailure(err: any): string {
  return err?.stderr?.trim?.()
    || err?.stdout?.trim?.()
    || err?.message
    || 'OpenClaw attach failed';
}

export function scheduleOpenClawUiAttachJob(
  integrationId: string,
  task: (job: PendingOpenClawUiAttachJob) => Promise<void>,
  onAttachScheduled?: (id: string, job: Promise<void>) => void,
): { started: boolean; job: Promise<void>; controller: AbortController } {
  const existing = pendingOpenClawUiAttachJobs.get(integrationId);
  if (existing) {
    onAttachScheduled?.(integrationId, existing.job);
    return { started: false, job: existing.job, controller: existing.controller };
  }

  const controller = new AbortController();
  const jobState: PendingOpenClawUiAttachJob = {
    controller,
    cancelled: false,
    job: Promise.resolve().then(() => task(jobState)).finally(() => {
      const current = pendingOpenClawUiAttachJobs.get(integrationId);
      if (current === jobState) {
        pendingOpenClawUiAttachJobs.delete(integrationId);
      }
    }),
  };
  pendingOpenClawUiAttachJobs.set(integrationId, jobState);
  onAttachScheduled?.(integrationId, jobState.job);
  return { started: true, job: jobState.job, controller };
}

export function cancelPendingLocalAgentAttachJob(integrationId: string): void {
  const job = pendingOpenClawUiAttachJobs.get(integrationId);
  if (!job) return;
  job.cancelled = true;
  job.controller.abort();
  pendingOpenClawUiAttachJobs.delete(integrationId);
}

export function isOpenClawUiAttachCancelled(job: PendingOpenClawUiAttachJob): boolean {
  return job.cancelled || job.controller.signal.aborted;
}


export function shouldTryNextOpenClawTarget(status: number): boolean {
  return status === 404 || status === 405 || status === 501 || status === 503;
}

export function buildOpenClawChannelHeaders(
  target: OpenClawChannelTarget,
  bridgeAuthToken: string | undefined,
  baseHeaders: Record<string, string> = {},
): Record<string, string> {
  if (target.name !== "bridge" || !bridgeAuthToken) return baseHeaders;
  return { ...baseHeaders, "x-dkg-bridge-token": bridgeAuthToken };
}

export async function ensureOpenClawBridgeAvailable(
  target: OpenClawChannelTarget,
  bridgeAuthToken: string | undefined,
): Promise<{
  ok: boolean;
  status?: number;
  details?: string;
  offline?: boolean;
}> {
  if (target.name !== "bridge" || !target.healthUrl) return { ok: true };
  if (!bridgeAuthToken) {
    return {
      ok: false,
      details: "Bridge auth token unavailable",
      offline: true,
    };
  }

      const cachedBridgeHealth = daemonState.openClawBridgeHealth;
      const cacheValid = isOpenClawBridgeHealthCacheValid(cachedBridgeHealth);
      if (cacheValid && cachedBridgeHealth) {
        return cachedBridgeHealth.ok
          ? { ok: true }
          : {
          ok: false,
          details: "Bridge health check cached as unavailable",
          offline: true,
        };
  }

  try {
    const healthRes = await fetch(target.healthUrl, {
      headers: buildOpenClawChannelHeaders(target, bridgeAuthToken, {
        Accept: "application/json",
      }),
      signal: AbortSignal.timeout(3_000),
    });
    daemonState.openClawBridgeHealth = { ok: healthRes.ok, ts: Date.now() };
    if (!healthRes.ok) {
      const details = await healthRes.text().catch(() => "");
      return {
        ok: false,
        status: healthRes.status,
        details: details || `Bridge health responded ${healthRes.status}`,
        offline: true,
      };
    }
    return { ok: true };
  } catch (err: any) {
    daemonState.openClawBridgeHealth = { ok: false, ts: Date.now() };
    return { ok: false, details: err.message, offline: true };
  }
}

export type OpenClawStreamRequest = Pick<IncomingMessage, "on">;
export type OpenClawStreamResponse = Pick<
  ServerResponse,
  "on" | "off" | "writeHead" | "write" | "end" | "writableEnded"
>;
export type OpenClawStreamReader = {
  read: () => Promise<{ done: boolean; value?: Uint8Array }>;
  cancel: () => Promise<unknown>;
  releaseLock: () => void;
};

export async function writeOpenClawStreamChunk(
  res: OpenClawStreamResponse,
  chunk: Uint8Array,
): Promise<void> {
  if (res.write(chunk)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      res.off("drain", onDrain);
      res.off("close", onClose);
      res.off("error", onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      resolve();
    };
    const onError = (err: unknown) => {
      cleanup();
      reject(err);
    };
    res.on("drain", onDrain);
    res.on("close", onClose);
    res.on("error", onError);
  });
}

export async function pipeOpenClawStream(
  req: OpenClawStreamRequest,
  res: OpenClawStreamResponse,
  reader: OpenClawStreamReader,
): Promise<void> {
  let clientGone = false;
  const cancelUpstream = () => {
    if (clientGone) return;
    clientGone = true;
    void reader.cancel().catch(() => {});
  };

  req.on("aborted", cancelUpstream);
  res.on("close", () => {
    if (!res.writableEnded) cancelUpstream();
  });
  res.on("error", cancelUpstream);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done || clientGone) break;
      if (value !== undefined) {
        await writeOpenClawStreamChunk(res, value);
        if (clientGone) break;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function isValidOpenClawPersistTurnPayload(payload: {
  sessionId?: unknown;
  userMessage?: unknown;
  assistantReply?: unknown;
  persistenceState?: unknown;
  failureReason?: unknown;
  attachmentRefs?: unknown;
}): payload is {
  sessionId: string;
  userMessage: string;
  assistantReply: string;
  turnId?: unknown;
  toolCalls?: unknown;
  persistenceState?: unknown;
  failureReason?: unknown;
  attachmentRefs?: unknown;
} {
  return (
    typeof payload.sessionId === "string" &&
    payload.sessionId.trim().length > 0 &&
    typeof payload.userMessage === "string" &&
    typeof payload.assistantReply === "string" &&
    (
      payload.failureReason === undefined ||
      payload.failureReason === null ||
      typeof payload.failureReason === 'string'
    ) &&
    (
      payload.attachmentRefs === undefined ||
      normalizeOpenClawAttachmentRefs(payload.attachmentRefs) !== undefined
    ) &&
    (
      payload.persistenceState === undefined ||
      payload.persistenceState === 'stored' ||
      payload.persistenceState === 'failed' ||
      payload.persistenceState === 'pending'
    )
  );
}

export interface OpenClawAttachmentRef {
  assertionUri: string;
  fileHash: string;
  contextGraphId: string;
  fileName: string;
  detectedContentType?: string;
  extractionStatus?: 'completed';
  tripleCount?: number;
  rootEntity?: string;
}

export function normalizeOpenClawAttachmentRef(raw: unknown): OpenClawAttachmentRef | null {
  if (!isPlainRecord(raw)) return null;
  const assertionUri = typeof raw.assertionUri === 'string' ? raw.assertionUri.trim() : '';
  const fileHash = typeof raw.fileHash === 'string' ? raw.fileHash.trim() : '';
  const contextGraphId = typeof raw.contextGraphId === 'string' ? raw.contextGraphId.trim() : '';
  const fileName = typeof raw.fileName === 'string' ? raw.fileName.trim() : '';
  if (!assertionUri || !fileHash || !contextGraphId || !fileName) return null;

  const normalized: OpenClawAttachmentRef = { assertionUri, fileHash, contextGraphId, fileName };
  if (typeof raw.detectedContentType === 'string' && raw.detectedContentType.trim()) {
    normalized.detectedContentType = raw.detectedContentType.trim();
  }
  if (raw.extractionStatus === 'completed') {
    normalized.extractionStatus = raw.extractionStatus;
  } else if (raw.extractionStatus !== undefined) {
    return null;
  }
  if (typeof raw.tripleCount === 'number' && Number.isFinite(raw.tripleCount) && raw.tripleCount >= 0) {
    normalized.tripleCount = raw.tripleCount;
  }
  if (typeof raw.rootEntity === 'string' && raw.rootEntity.trim()) {
    normalized.rootEntity = raw.rootEntity.trim();
  }
  return normalized;
}

export function normalizeOpenClawAttachmentRefs(raw: unknown): OpenClawAttachmentRef[] | undefined {
  if (raw == null) return undefined;
  if (!Array.isArray(raw)) return undefined;
  if (raw.length === 0) return [];
  const refs: OpenClawAttachmentRef[] = [];
  for (const entry of raw) {
    const normalized = normalizeOpenClawAttachmentRef(entry);
    if (!normalized) return undefined;
    refs.push(normalized);
  }
  return refs;
}

export interface OpenClawChatContextEntry {
  key: string;
  label: string;
  value: string;
}

export function normalizeOpenClawChatContextEntry(
  raw: unknown,
): OpenClawChatContextEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const key = typeof record.key === "string" ? record.key.trim() : "";
  const label = typeof record.label === "string" ? record.label.trim() : "";
  const value = typeof record.value === "string" ? record.value.trim() : "";
  if (!key || !label || !value) return null;
  return { key, label, value };
}

export function normalizeOpenClawChatContextEntries(
  raw: unknown,
): OpenClawChatContextEntry[] | undefined {
  if (raw == null) return undefined;
  if (!Array.isArray(raw)) return undefined;
  if (raw.length === 0) return [];
  const entries: OpenClawChatContextEntry[] = [];
  for (const entry of raw) {
    const normalized = normalizeOpenClawChatContextEntry(entry);
    if (!normalized) return undefined;
    entries.push(normalized);
  }
  return entries;
}

export function hasOpenClawChatTurnContent(
  text: unknown,
  attachmentRefs: OpenClawAttachmentRef[] | undefined,
): text is string {
  return typeof text === 'string' && (text.length > 0 || Boolean(attachmentRefs?.length));
}

export function unescapeOpenClawAttachmentLiteralBody(raw: string): string {
  let decoded = '';

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch !== '\\') {
      decoded += ch;
      continue;
    }

    const next = raw[i + 1];
    if (!next) {
      decoded += '\\';
      break;
    }

    if (next === 'u' || next === 'U') {
      const hexLength = next === 'u' ? 4 : 8;
      const hex = raw.slice(i + 2, i + 2 + hexLength);
      if (/^[0-9A-Fa-f]+$/.test(hex) && hex.length === hexLength) {
        const codePoint = Number.parseInt(hex, 16);
        if (codePoint <= 0x10FFFF) {
          decoded += String.fromCodePoint(codePoint);
          i += 1 + hexLength;
          continue;
        }
      }
      decoded += `\\${next}`;
      i += 1;
      continue;
    }

    const escaped = ({
      t: '\t',
      b: '\b',
      n: '\n',
      r: '\r',
      f: '\f',
      '"': '"',
      "'": "'",
      '\\': '\\',
    } as Record<string, string>)[next];

    if (escaped !== undefined) {
      decoded += escaped;
    } else {
      decoded += `\\${next}`;
    }
    i += 1;
  }

  return decoded;
}

export function stripOpenClawAttachmentLiteral(raw: string | undefined): string {
  if (!raw) return '';
  const match = raw.match(/^"([\s\S]*)"(?:\^\^<[^>]+>)?(?:@[a-z-]+)?$/);
  return match ? unescapeOpenClawAttachmentLiteralBody(match[1]) : raw;
}

export function parseOpenClawAttachmentTripleCount(raw: string | undefined): number | undefined {
  const value = stripOpenClawAttachmentLiteral(raw).trim();
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function isOpenClawAttachmentAssertionUriForContextGraph(assertionUri: string, contextGraphId: string): boolean {
  const prefix = `did:dkg:context-graph:${contextGraphId}/`;
  if (!assertionUri.startsWith(prefix)) return false;
  const remainder = assertionUri.slice(prefix.length);
  if (remainder.startsWith('assertion/')) {
    return remainder.length > 'assertion/'.length;
  }
  const assertionMarker = remainder.indexOf('/assertion/');
  if (assertionMarker <= 0) return false;
  const subGraphName = remainder.slice(0, assertionMarker);
  const validation = validateSubGraphName(subGraphName);
  return validation.valid;
}

export function extractionRecordMatchesOpenClawAttachmentRef(
  ref: OpenClawAttachmentRef,
  record: ExtractionStatusRecord,
): boolean {
  if (record.status !== 'completed') return false;
  if (record.fileHash !== ref.fileHash) return false;
  if (record.fileName && record.fileName !== ref.fileName) return false;
  if (
    ref.detectedContentType &&
    normalizeDetectedContentType(ref.detectedContentType) !== normalizeDetectedContentType(record.detectedContentType)
  ) {
    return false;
  }
  if (ref.extractionStatus && ref.extractionStatus !== 'completed') return false;
  if (ref.tripleCount != null && ref.tripleCount !== record.tripleCount) return false;
  if (ref.rootEntity && ref.rootEntity !== record.rootEntity) return false;
  return true;
}

export async function verifyOpenClawAttachmentRefsProvenance(
  agent: Pick<DKGAgent, 'store'>,
  extractionStatus: Map<string, ExtractionStatusRecord>,
  attachmentRefs: OpenClawAttachmentRef[] | undefined,
): Promise<OpenClawAttachmentRef[] | undefined> {
  if (!attachmentRefs) return attachmentRefs;

  for (const ref of attachmentRefs) {
    if (!isSafeIri(ref.assertionUri)) return undefined;
    if (ref.rootEntity && !isSafeIri(ref.rootEntity)) return undefined;
    if (!isOpenClawAttachmentAssertionUriForContextGraph(ref.assertionUri, ref.contextGraphId)) return undefined;

    const extractionRecord = getExtractionStatusRecord(extractionStatus, ref.assertionUri);
    if (extractionRecord) {
      if (!extractionRecordMatchesOpenClawAttachmentRef(ref, extractionRecord)) return undefined;
      if (extractionRecord.fileName === ref.fileName) continue;
    }

    const metaGraph = contextGraphMetaUri(ref.contextGraphId);
    const metaResult = await agent.store.query(`
      SELECT ?fileHash ?contentType ?rootEntity ?tripleCount ?sourceFileName WHERE {
        GRAPH <${metaGraph}> {
          <${ref.assertionUri}> <http://dkg.io/ontology/sourceFileHash> ?fileHash .
          OPTIONAL { <${ref.assertionUri}> <http://dkg.io/ontology/sourceContentType> ?contentType }
          OPTIONAL { <${ref.assertionUri}> <http://dkg.io/ontology/rootEntity> ?rootEntity }
          OPTIONAL { <${ref.assertionUri}> <http://dkg.io/ontology/structuralTripleCount> ?tripleCount }
          OPTIONAL { <${ref.assertionUri}> <http://dkg.io/ontology/sourceFileName> ?sourceFileName }
        }
      }
      LIMIT 1
    `) as { bindings?: Array<Record<string, string>> };
    const binding = metaResult?.bindings?.[0];
    if (!binding) return undefined;

    if (stripOpenClawAttachmentLiteral(binding.fileHash ?? '') !== ref.fileHash) return undefined;
    const storedContentType = stripOpenClawAttachmentLiteral(binding.contentType ?? '').trim();
    if (
      ref.detectedContentType &&
      storedContentType &&
      normalizeDetectedContentType(ref.detectedContentType) !== normalizeDetectedContentType(storedContentType)
    ) {
      return undefined;
    }
    if (ref.extractionStatus && ref.extractionStatus !== 'completed') return undefined;

    const storedTripleCount = parseOpenClawAttachmentTripleCount(binding.tripleCount ?? '');
    if (ref.tripleCount != null && storedTripleCount != null && ref.tripleCount !== storedTripleCount) {
      return undefined;
    }
    const storedFileName = stripOpenClawAttachmentLiteral(binding.sourceFileName ?? '').trim();
    if (storedFileName && storedFileName !== ref.fileName) return undefined;

    const storedRootEntity = typeof binding.rootEntity === 'string'
      ? binding.rootEntity.replace(/[<>]/g, '').trim()
      : '';
    if (ref.rootEntity && storedRootEntity && ref.rootEntity !== storedRootEntity) return undefined;
  }

  return attachmentRefs;
}

