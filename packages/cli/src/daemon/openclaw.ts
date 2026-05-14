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
import { createHash } from 'node:crypto';

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
// Per-integration UI attach-job machinery moved to
// `./local-agent-attach-jobs.ts` in S1 of issue #386 so adapter-hermes'
// S3 work can reuse the same scheduler keyed on `'hermes'` instead of
// `'openclaw'`. The OpenClaw-named bindings below are backwards-compat
// re-exports that the existing OpenClaw daemon-route call sites continue
// to import from this module — no behavior change.
import {
  cancelPending as cancelPendingLocalAgentAttachJobImpl,
  isCancelled as isAttachJobCancelledImpl,
  scheduleAttachJob as scheduleAttachJobImpl,
  type PendingAttachJob,
} from './local-agent-attach-jobs.js';

export type PendingOpenClawUiAttachJob = PendingAttachJob;

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

function healthUrlMatchesBase(healthUrl: string, baseUrl: string): boolean {
  const base = trimTrailingSlashes(baseUrl);
  return healthUrl === base || healthUrl.startsWith(`${base}/`);
}

function classifyExplicitOpenClawHealthUrl(
  healthUrl: string | undefined,
  standaloneBridgeBase: string | undefined,
  gatewayBase: string | undefined,
): 'bridge' | 'gateway' | undefined {
  if (!healthUrl) return undefined;
  const bridgeMatch = standaloneBridgeBase && healthUrlMatchesBase(healthUrl, standaloneBridgeBase)
    ? trimTrailingSlashes(standaloneBridgeBase)
    : undefined;
  const gatewayMatch = gatewayBase && healthUrlMatchesBase(healthUrl, gatewayBase)
    ? trimTrailingSlashes(gatewayBase)
    : undefined;
  if (bridgeMatch && gatewayMatch) {
    return gatewayMatch.length >= bridgeMatch.length ? 'gateway' : 'bridge';
  }
  if (gatewayMatch) return 'gateway';
  if (bridgeMatch) return 'bridge';
  return undefined;
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
  const explicitHealthUrl = openclawIntegration?.transport.healthUrl
    ? trimTrailingSlashes(openclawIntegration.transport.healthUrl)
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
  const normalizedGatewayBase = gatewayBase
    ? buildOpenClawGatewayBase(gatewayBase)
    : undefined;
  const explicitHealthTarget = classifyExplicitOpenClawHealthUrl(
    explicitHealthUrl,
    standaloneBridgeBase,
    normalizedGatewayBase,
  );
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
      healthUrl: explicitHealthTarget === 'bridge'
        ? explicitHealthUrl!
        : `${standaloneBridgeBase}/health`,
    });
  }

  if (normalizedGatewayBase) {
    pushTarget({
      name: "gateway",
      inboundUrl: `${normalizedGatewayBase}/inbound`,
      healthUrl: explicitHealthTarget === 'gateway'
        ? explicitHealthUrl
        : `${normalizedGatewayBase}/health`,
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

// Backwards-compat re-exports under the OpenClaw-named symbols. The real
// scheduler lives in `./local-agent-attach-jobs.ts` (extracted in S1 of
// issue #386). These wrappers preserve the historical names so OpenClaw
// daemon-route call sites in `local-agents.ts` keep importing them
// unchanged. New Hermes call sites (S3) should import the generic names
// (`scheduleAttachJob`, `cancelPending`, `isCancelled`) from
// `./local-agent-attach-jobs.js` directly.
export function scheduleOpenClawUiAttachJob(
  integrationId: string,
  task: (job: PendingOpenClawUiAttachJob) => Promise<void>,
  onAttachScheduled?: (id: string, job: Promise<void>) => void,
): { started: boolean; job: Promise<void>; controller: AbortController } {
  return scheduleAttachJobImpl(integrationId, task, onAttachScheduled);
}

export function cancelPendingLocalAgentAttachJob(integrationId: string): void {
  cancelPendingLocalAgentAttachJobImpl(integrationId);
}

export function isOpenClawUiAttachCancelled(job: PendingOpenClawUiAttachJob): boolean {
  return isAttachJobCancelledImpl(job);
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
  assertionName?: string;
  fileHash: string;
  contextGraphId: string;
  fileName: string;
  detectedContentType?: string;
  extractionStatus?: 'completed';
  tripleCount?: number;
  rootEntity?: string;
  mdIntermediateHash?: string;
  markdownHash?: string;
  markdownForm?: string;
}

export interface OpenClawAttachmentImportResult {
  assertionUri: string;
  fileHash: string;
  contextGraphId: string;
  fileName: string;
  detectedContentType: string;
  extractionStatus: 'skipped';
  pipelineUsed?: string | null;
  tripleCount?: number;
  rootEntity?: string;
  mdIntermediateHash?: string;
  error?: string;
}

export function normalizeOpenClawAttachmentRef(raw: unknown): OpenClawAttachmentRef | null {
  if (!isPlainRecord(raw)) return null;
  const assertionUri = typeof raw.assertionUri === 'string' ? raw.assertionUri.trim() : '';
  const fileHash = typeof raw.fileHash === 'string' ? raw.fileHash.trim() : '';
  const contextGraphId = typeof raw.contextGraphId === 'string' ? raw.contextGraphId.trim() : '';
  const fileName = typeof raw.fileName === 'string' ? raw.fileName.trim() : '';
  if (!assertionUri || !fileHash || !contextGraphId || !fileName) return null;

  const normalized: OpenClawAttachmentRef = { assertionUri, fileHash, contextGraphId, fileName };
  if (typeof raw.assertionName === 'string' && raw.assertionName.trim()) {
    normalized.assertionName = raw.assertionName.trim();
  }
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
  if (typeof raw.mdIntermediateHash === 'string' && raw.mdIntermediateHash.trim()) {
    normalized.mdIntermediateHash = raw.mdIntermediateHash.trim();
  }
  if (typeof raw.markdownHash === 'string' && raw.markdownHash.trim()) {
    normalized.markdownHash = raw.markdownHash.trim();
  }
  if (typeof raw.markdownForm === 'string' && raw.markdownForm.trim()) {
    normalized.markdownForm = raw.markdownForm.trim();
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

export function normalizeOpenClawAttachmentImportResult(raw: unknown): OpenClawAttachmentImportResult | null {
  if (!isPlainRecord(raw)) return null;
  const assertionUri = typeof raw.assertionUri === 'string' ? raw.assertionUri.trim() : '';
  const fileHash = typeof raw.fileHash === 'string' ? raw.fileHash.trim() : '';
  const contextGraphId = typeof raw.contextGraphId === 'string' ? raw.contextGraphId.trim() : '';
  const fileName = typeof raw.fileName === 'string' ? raw.fileName.trim() : '';
  const detectedContentType = typeof raw.detectedContentType === 'string' ? raw.detectedContentType.trim() : '';
  if (!assertionUri || !fileHash || !contextGraphId || !fileName || !detectedContentType) return null;
  if (raw.extractionStatus !== 'skipped') return null;

  const normalized: OpenClawAttachmentImportResult = {
    assertionUri,
    fileHash,
    contextGraphId,
    fileName,
    detectedContentType,
    extractionStatus: 'skipped',
  };
  if (raw.pipelineUsed === null) {
    normalized.pipelineUsed = null;
  } else if (typeof raw.pipelineUsed === 'string' && raw.pipelineUsed.trim()) {
    normalized.pipelineUsed = raw.pipelineUsed.trim();
  } else if (raw.pipelineUsed !== undefined) {
    return null;
  }
  if (typeof raw.tripleCount === 'number' && Number.isFinite(raw.tripleCount) && raw.tripleCount >= 0) {
    normalized.tripleCount = raw.tripleCount;
  }
  if (typeof raw.rootEntity === 'string' && raw.rootEntity.trim()) {
    normalized.rootEntity = raw.rootEntity.trim();
  }
  if (typeof raw.mdIntermediateHash === 'string' && raw.mdIntermediateHash.trim()) {
    normalized.mdIntermediateHash = raw.mdIntermediateHash.trim();
  }
  if (typeof raw.error === 'string' && raw.error.trim()) {
    normalized.error = raw.error.trim();
  }
  return normalized;
}

export function normalizeOpenClawAttachmentImportResults(raw: unknown): OpenClawAttachmentImportResult[] | undefined {
  if (raw == null) return undefined;
  if (!Array.isArray(raw)) return undefined;
  if (raw.length === 0) return [];
  const results: OpenClawAttachmentImportResult[] = [];
  for (const entry of raw) {
    const normalized = normalizeOpenClawAttachmentImportResult(entry);
    if (!normalized) return undefined;
    results.push(normalized);
  }
  return results;
}

export function dedupeOpenClawAttachmentImportResults(
  attachmentImportResults: OpenClawAttachmentImportResult[] | undefined,
): OpenClawAttachmentImportResult[] | undefined {
  if (!attachmentImportResults) return attachmentImportResults;
  const seen = new Set<string>();
  const deduped: OpenClawAttachmentImportResult[] = [];
  for (const result of attachmentImportResults) {
    const key = `${result.contextGraphId}\0${result.assertionUri}\0${result.fileHash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(result);
  }
  return deduped;
}

export interface OpenClawChatContextEntry {
  key: string;
  label: string;
  value: string;
}

const ATTACHMENT_IMPORT_CONTEXT_KEY_PREFIX = 'attachment_import_result_';
const ATTACHMENT_IMPORT_CONTEXT_LABEL_PATTERN = /^attachment import result\s*:/;

interface LegacyAttachmentImportContextField {
  keys: readonly string[];
  required: boolean;
}

const LEGACY_ATTACHMENT_IMPORT_CONTEXT_FIELD_ORDER: LegacyAttachmentImportContextField[] = [
  { keys: ['filename'], required: true },
  { keys: ['assertionname'], required: true },
  { keys: ['assertionuri'], required: true },
  { keys: ['contextgraphid'], required: true },
  { keys: ['filehash'], required: true },
  { keys: ['contenttype', 'detectedcontenttype'], required: true },
  { keys: ['extractionstatus'], required: true },
  { keys: ['pipelineused'], required: false },
  { keys: ['triplecount', 'structuraltriplecount'], required: false },
  { keys: ['rootentity'], required: false },
  { keys: ['mdintermediatehash'], required: false },
  { keys: ['error'], required: false },
];

function normalizeOpenClawContextNamespaceLabel(label: string): string {
  return label
    .normalize('NFKC')
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function isOpenClawAttachmentImportContextKey(key: string): boolean {
  return key.toLowerCase().startsWith(ATTACHMENT_IMPORT_CONTEXT_KEY_PREFIX);
}

function isOpenClawAttachmentImportContextLabel(label: string): boolean {
  return ATTACHMENT_IMPORT_CONTEXT_LABEL_PATTERN.test(normalizeOpenClawContextNamespaceLabel(label));
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function legacyAttachmentImportFieldPattern(keys: readonly string[], prefix: string): RegExp {
  return new RegExp(`${prefix}(${keys.map(escapeRegExp).join('|')})\\s*=`, 'i');
}

function legacyAttachmentImportDelimiterPattern(keys: readonly string[]): RegExp {
  return new RegExp(`;\\s*(${keys.map(escapeRegExp).join('|')})\\s*=`, 'gi');
}

function hasRequiredLegacyAttachmentImportField(startIndex: number): boolean {
  return LEGACY_ATTACHMENT_IMPORT_CONTEXT_FIELD_ORDER
    .slice(startIndex)
    .some((field) => field.required);
}

function canSkipLegacyAttachmentImportFields(startIndex: number, endIndex: number): boolean {
  return !LEGACY_ATTACHMENT_IMPORT_CONTEXT_FIELD_ORDER
    .slice(startIndex, endIndex)
    .some((field) => field.required);
}

function matchLegacyAttachmentImportFieldAt(
  source: string,
  cursor: number,
  slotIndex: number,
): { key: string; slotIndex: number; valueStart: number } | null {
  for (let index = slotIndex; index < LEGACY_ATTACHMENT_IMPORT_CONTEXT_FIELD_ORDER.length; index += 1) {
    if (!canSkipLegacyAttachmentImportFields(slotIndex, index)) return null;
    const slot = LEGACY_ATTACHMENT_IMPORT_CONTEXT_FIELD_ORDER[index];
    const match = legacyAttachmentImportFieldPattern(slot.keys, '^').exec(source.slice(cursor));
    if (match?.[1]) {
      return {
        key: match[1].toLowerCase(),
        slotIndex: index,
        valueStart: cursor + match[0].length,
      };
    }
    if (slot.required) return null;
  }
  return null;
}

function findLegacyAttachmentImportNextFieldCandidateGroups(
  source: string,
  valueStart: number,
  slotIndex: number,
): Array<{ slot: LegacyAttachmentImportContextField; candidates: Array<{ delimiterStart: number; fieldStart: number }> }> {
  const groups: Array<{
    slot: LegacyAttachmentImportContextField;
    candidates: Array<{ delimiterStart: number; fieldStart: number }>;
  }> = [];
  for (let index = slotIndex; index < LEGACY_ATTACHMENT_IMPORT_CONTEXT_FIELD_ORDER.length; index += 1) {
    if (!canSkipLegacyAttachmentImportFields(slotIndex, index)) break;
    const slot = LEGACY_ATTACHMENT_IMPORT_CONTEXT_FIELD_ORDER[index];
    const pattern = legacyAttachmentImportDelimiterPattern(slot.keys);
    pattern.lastIndex = valueStart;
    const candidates: Array<{ delimiterStart: number; fieldStart: number }> = [];
    let match = pattern.exec(source);
    while (match) {
      const matchedKey = match[1] ?? '';
      const fieldOffset = match[0].indexOf(matchedKey);
      if (fieldOffset >= 0) {
        candidates.push({
          delimiterStart: match.index,
          fieldStart: match.index + fieldOffset,
        });
      }
      if (pattern.lastIndex === match.index) pattern.lastIndex += 1;
      match = pattern.exec(source);
    }
    if (candidates.length > 0) {
      groups.push({
        slot,
        candidates: candidates.sort((left, right) => right.delimiterStart - left.delimiterStart),
      });
    }
    if (slot.required) break;
  }
  return groups;
}

function parseLegacyAttachmentImportFields(
  source: string,
  slotIndex: number,
  cursor: number,
  fields: Record<string, unknown>,
): Record<string, unknown> | null {
  const field = matchLegacyAttachmentImportFieldAt(source, cursor, slotIndex);
  if (!field || fields[field.key] !== undefined) return null;

  const nextGroups = findLegacyAttachmentImportNextFieldCandidateGroups(
    source,
    field.valueStart,
    field.slotIndex + 1,
  );
  for (const group of nextGroups) {
    for (const candidate of group.candidates) {
      const fieldValue = source.slice(field.valueStart, candidate.delimiterStart).trim();
      const parsed = parseLegacyAttachmentImportFields(source, field.slotIndex + 1, candidate.fieldStart, {
        ...fields,
        [field.key]: fieldValue,
      });
      if (parsed) return parsed;
    }
    if (group.slot.required) return null;
  }

  if (hasRequiredLegacyAttachmentImportField(field.slotIndex + 1)) return null;
  return {
    ...fields,
    [field.key]: source.slice(field.valueStart).trim(),
  };
}

function parseAttachmentImportContextKeyValue(value: string): Record<string, unknown> | null {
  const source = value.trim();
  if (!source) return null;
  return parseLegacyAttachmentImportFields(source, 0, 0, {});
}

function parseAttachmentImportContextMetadata(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (isPlainRecord(parsed)) return parsed;
  } catch {
    /* fall through to legacy key=value parser */
  }
  return parseAttachmentImportContextKeyValue(value);
}

function attachmentImportMetadataValue(
  metadata: Record<string, unknown>,
  ...keys: string[]
): unknown {
  for (const key of keys) {
    if (metadata[key] !== undefined) return metadata[key];
  }
  const lowerEntries = Object.entries(metadata).map(([key, value]) => [key.toLowerCase(), value] as const);
  for (const key of keys) {
    const lowerKey = key.toLowerCase();
    const entry = lowerEntries.find(([candidate]) => candidate === lowerKey);
    if (entry) return entry[1];
  }
  return undefined;
}

function normalizeAttachmentImportMetadataPipeline(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const normalized = value.trim();
  return normalized.toLowerCase() === 'none' ? null : normalized;
}

function normalizeAttachmentImportMetadataTripleCount(value: unknown): unknown {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || !value.trim()) return value;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : value;
}

function normalizeOpenClawAttachmentImportResultFromContextEntry(
  entry: OpenClawChatContextEntry,
): OpenClawAttachmentImportResult | null {
  const metadata = parseAttachmentImportContextMetadata(entry.value);
  if (!metadata) return null;
  return normalizeOpenClawAttachmentImportResult({
    assertionUri: attachmentImportMetadataValue(metadata, 'assertionUri'),
    fileHash: attachmentImportMetadataValue(metadata, 'fileHash'),
    contextGraphId: attachmentImportMetadataValue(metadata, 'contextGraphId'),
    fileName: attachmentImportMetadataValue(metadata, 'fileName'),
    detectedContentType: attachmentImportMetadataValue(metadata, 'detectedContentType', 'contentType'),
    extractionStatus: attachmentImportMetadataValue(metadata, 'extractionStatus'),
    pipelineUsed: normalizeAttachmentImportMetadataPipeline(
      attachmentImportMetadataValue(metadata, 'pipelineUsed'),
    ),
    tripleCount: normalizeAttachmentImportMetadataTripleCount(
      attachmentImportMetadataValue(metadata, 'tripleCount', 'structuralTripleCount'),
    ),
    rootEntity: attachmentImportMetadataValue(metadata, 'rootEntity'),
    mdIntermediateHash: attachmentImportMetadataValue(metadata, 'mdIntermediateHash'),
    error: attachmentImportMetadataValue(metadata, 'error'),
  });
}

export interface OpenClawChatContextNormalization {
  contextEntries?: OpenClawChatContextEntry[];
  attachmentImportResults?: OpenClawAttachmentImportResult[];
}

export function normalizeOpenClawChatContextEntriesWithAttachmentImportResults(
  raw: unknown,
): OpenClawChatContextNormalization | undefined {
  if (raw == null) return {};
  if (!Array.isArray(raw)) return undefined;
  if (raw.length === 0) return { contextEntries: [], attachmentImportResults: [] };
  const contextEntries: OpenClawChatContextEntry[] = [];
  const attachmentImportResults: OpenClawAttachmentImportResult[] = [];
  for (const rawEntry of raw) {
    if (!isPlainRecord(rawEntry)) return undefined;
    const entry: OpenClawChatContextEntry = {
      key: typeof rawEntry.key === 'string' ? rawEntry.key.trim() : '',
      label: typeof rawEntry.label === 'string' ? rawEntry.label.trim() : '',
      value: typeof rawEntry.value === 'string' ? rawEntry.value.trim() : '',
    };
    if (!entry.key || !entry.label || !entry.value) return undefined;

    if (isOpenClawAttachmentImportContextKey(entry.key)) {
      const attachmentImportResult = normalizeOpenClawAttachmentImportResultFromContextEntry(entry);
      if (!attachmentImportResult) return undefined;
      attachmentImportResults.push(attachmentImportResult);
      continue;
    }

    if (isOpenClawAttachmentImportContextLabel(entry.label)) return undefined;
    contextEntries.push(entry);
  }
  return { contextEntries, attachmentImportResults };
}

export function normalizeOpenClawChatContextEntries(
  raw: unknown,
): OpenClawChatContextEntry[] | undefined {
  if (raw == null) return undefined;
  if (!Array.isArray(raw)) return undefined;
  const contextEntries: OpenClawChatContextEntry[] = [];
  for (const entry of raw) {
    const normalized = normalizeOpenClawChatContextEntry(entry);
    if (!normalized) return undefined;
    contextEntries.push(normalized);
  }
  return contextEntries;
}

export function hasOpenClawChatTurnContent(
  text: unknown,
  attachmentRefs: OpenClawAttachmentRef[] | undefined,
  attachmentImportResults?: OpenClawAttachmentImportResult[] | undefined,
  contextEntries?: OpenClawChatContextEntry[] | undefined,
): text is string {
  return typeof text === 'string' && (
    text.length > 0 ||
    Boolean(attachmentRefs?.length) ||
    Boolean(attachmentImportResults?.length) ||
    Boolean(contextEntries?.length)
  );
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

function openClawBindingValue(cell: unknown): string {
  if (typeof cell === 'string') return cell;
  if (cell && typeof cell === 'object' && 'value' in cell) {
    const value = (cell as { value?: unknown }).value;
    return typeof value === 'string' ? value : '';
  }
  return '';
}

function stripOpenClawBindingLiteral(cell: unknown): string {
  return stripOpenClawAttachmentLiteral(openClawBindingValue(cell)).trim();
}

function normalizeOpenClawBindingIri(cell: unknown): string {
  return openClawBindingValue(cell).replace(/^<|>$/g, '').trim();
}

function openClawHashFromFileUrn(value: string | undefined): string | undefined {
  const prefix = 'urn:dkg:file:';
  if (!value?.startsWith(prefix)) return undefined;
  const hash = value.slice(prefix.length);
  return /^(?:sha256:|keccak256:)?[0-9a-f]{64}$/i.test(hash) ? hash : undefined;
}

function openClawMarkdownHashFor(
  fileHash: string,
  contentType: string | undefined,
  mdIntermediateHash: string | undefined,
): string | undefined {
  return mdIntermediateHash
    ?? (normalizeDetectedContentType(contentType) === 'text/markdown' ? fileHash : undefined);
}

function openClawAssertionNameFromUri(assertionUri: string): string | undefined {
  const marker = '/assertion/';
  const index = assertionUri.indexOf(marker);
  if (index < 0) return undefined;
  const tail = assertionUri.slice(index + marker.length);
  const slash = tail.indexOf('/');
  return slash >= 0 ? tail.slice(slash + 1) : undefined;
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
  if (ref.mdIntermediateHash && ref.mdIntermediateHash !== record.mdIntermediateHash) return false;
  const markdownHash = openClawMarkdownHashFor(
    record.fileHash,
    record.detectedContentType,
    record.mdIntermediateHash,
  );
  if (ref.markdownHash && ref.markdownHash !== markdownHash) return false;
  if (ref.markdownForm && openClawHashFromFileUrn(ref.markdownForm) !== markdownHash) return false;
  return true;
}

function verifiedOpenClawAttachmentRefFromRecord(
  ref: OpenClawAttachmentRef,
  record: ExtractionStatusRecord,
): OpenClawAttachmentRef {
  const markdownHash = openClawMarkdownHashFor(
    record.fileHash,
    record.detectedContentType,
    record.mdIntermediateHash,
  );
  return {
    ...ref,
    assertionUri: ref.assertionUri,
    contextGraphId: ref.contextGraphId,
    fileName: record.fileName ?? ref.fileName,
    fileHash: record.fileHash,
    extractionStatus: 'completed',
    ...(record.mdIntermediateHash ? { mdIntermediateHash: record.mdIntermediateHash } : {}),
    ...(markdownHash ? { markdownHash, markdownForm: `urn:dkg:file:${markdownHash}` } : {}),
  };
}

export async function verifyOpenClawAttachmentRefsProvenance(
  agent: Pick<DKGAgent, 'store'>,
  extractionStatus: Map<string, ExtractionStatusRecord>,
  attachmentRefs: OpenClawAttachmentRef[] | undefined,
): Promise<OpenClawAttachmentRef[] | undefined> {
  if (!attachmentRefs) return attachmentRefs;

  const verified: OpenClawAttachmentRef[] = [];
  for (const ref of attachmentRefs) {
    if (!isSafeIri(ref.assertionUri)) return undefined;
    if (ref.rootEntity && !isSafeIri(ref.rootEntity)) return undefined;
    if (ref.markdownForm && !isSafeIri(ref.markdownForm)) return undefined;
    if (!isOpenClawAttachmentAssertionUriForContextGraph(ref.assertionUri, ref.contextGraphId)) return undefined;

    const extractionRecord = getExtractionStatusRecord(extractionStatus, ref.assertionUri);
    if (extractionRecord) {
      if (!extractionRecordMatchesOpenClawAttachmentRef(ref, extractionRecord)) return undefined;
      const recordMarkdownHash = openClawMarkdownHashFor(
        extractionRecord.fileHash,
        extractionRecord.detectedContentType,
        extractionRecord.mdIntermediateHash,
      );
      const refHasMarkdownMetadata = Boolean(ref.mdIntermediateHash || ref.markdownHash || ref.markdownForm);
      if (!recordMarkdownHash && !refHasMarkdownMetadata) {
        verified.push(verifiedOpenClawAttachmentRefFromRecord(ref, extractionRecord));
        continue;
      }
    }

    const metaGraph = contextGraphMetaUri(ref.contextGraphId);
    const metaResult = await agent.store.query(`
      SELECT ?fileHash ?contentType ?rootEntity ?extractionStatus ?tripleCount ?sourceFileName ?mdIntermediateHash WHERE {
        GRAPH <${metaGraph}> {
          <${ref.assertionUri}> <http://dkg.io/ontology/sourceFileHash> ?fileHash .
          OPTIONAL { <${ref.assertionUri}> <http://dkg.io/ontology/sourceContentType> ?contentType }
          OPTIONAL { <${ref.assertionUri}> <http://dkg.io/ontology/rootEntity> ?rootEntity }
          OPTIONAL { <${ref.assertionUri}> <http://dkg.io/ontology/extractionStatus> ?extractionStatus }
          OPTIONAL { <${ref.assertionUri}> <http://dkg.io/ontology/structuralTripleCount> ?tripleCount }
          OPTIONAL { <${ref.assertionUri}> <http://dkg.io/ontology/sourceFileName> ?sourceFileName }
          OPTIONAL { <${ref.assertionUri}> <http://dkg.io/ontology/mdIntermediateHash> ?mdIntermediateHash }
        }
      }
      LIMIT 1
    `) as { bindings?: Array<Record<string, unknown>> };
    const binding = metaResult?.bindings?.[0];
    if (!binding) return undefined;

    if (stripOpenClawBindingLiteral(binding.fileHash) !== ref.fileHash) return undefined;
    const storedContentType = stripOpenClawBindingLiteral(binding.contentType);
    if (
      ref.detectedContentType &&
      storedContentType &&
      normalizeDetectedContentType(ref.detectedContentType) !== normalizeDetectedContentType(storedContentType)
    ) {
      return undefined;
    }
    if (ref.extractionStatus && ref.extractionStatus !== 'completed') return undefined;
    const storedExtractionStatus = stripOpenClawBindingLiteral(binding.extractionStatus);
    if (storedExtractionStatus && storedExtractionStatus !== 'completed') return undefined;

    const storedTripleCount = parseOpenClawAttachmentTripleCount(openClawBindingValue(binding.tripleCount));
    if (ref.tripleCount != null && storedTripleCount != null && ref.tripleCount !== storedTripleCount) {
      return undefined;
    }
    const storedFileName = stripOpenClawBindingLiteral(binding.sourceFileName);
    if (storedFileName && storedFileName !== ref.fileName) return undefined;

    const storedRootEntity = normalizeOpenClawBindingIri(binding.rootEntity);
    if (ref.rootEntity && storedRootEntity && ref.rootEntity !== storedRootEntity) return undefined;

    const mdIntermediateHash = stripOpenClawBindingLiteral(binding.mdIntermediateHash) || undefined;
    if (ref.mdIntermediateHash && ref.mdIntermediateHash !== mdIntermediateHash) return undefined;
    const markdownFormResult = await agent.store.query(`
      SELECT DISTINCT ?markdownForm WHERE {
        GRAPH <${ref.assertionUri}> {
          ?document <http://dkg.io/ontology/markdownForm> ?markdownForm .
        }
      }
    `) as { bindings?: Array<Record<string, unknown>> };
    const markdownHash = openClawMarkdownHashFor(ref.fileHash, storedContentType, mdIntermediateHash);
    const storedMarkdownForms = (markdownFormResult?.bindings ?? [])
      .map((storedBinding) => normalizeOpenClawBindingIri(storedBinding.markdownForm))
      .filter(Boolean);
    for (const storedMarkdownForm of storedMarkdownForms) {
      const markdownFormHash = openClawHashFromFileUrn(storedMarkdownForm);
      if (!markdownFormHash || !markdownHash || markdownFormHash !== markdownHash) return undefined;
    }
    if (ref.markdownHash && ref.markdownHash !== markdownHash) return undefined;
    if (ref.markdownForm && (!markdownHash || openClawHashFromFileUrn(ref.markdownForm) !== markdownHash)) {
      return undefined;
    }

    verified.push({
      ...ref,
      assertionUri: ref.assertionUri,
      contextGraphId: ref.contextGraphId,
      fileName: storedFileName || ref.fileName,
      fileHash: ref.fileHash,
      extractionStatus: 'completed',
      ...(mdIntermediateHash ? { mdIntermediateHash } : {}),
      ...(markdownHash ? { markdownHash, markdownForm: `urn:dkg:file:${markdownHash}` } : {}),
    });
  }

  return verified;
}

function extractionRecordMatchesOpenClawAttachmentImportResult(
  ref: OpenClawAttachmentImportResult,
  record: ExtractionStatusRecord,
): boolean {
  if (record.status !== 'skipped') return false;
  if (record.fileHash !== ref.fileHash) return false;
  if (record.fileName && record.fileName !== ref.fileName) return false;
  if (normalizeDetectedContentType(ref.detectedContentType) !== normalizeDetectedContentType(record.detectedContentType)) {
    return false;
  }
  if (ref.pipelineUsed != null && ref.pipelineUsed !== record.pipelineUsed) return false;
  if (ref.tripleCount != null && ref.tripleCount !== record.tripleCount) return false;
  if (ref.rootEntity && ref.rootEntity !== record.rootEntity) return false;
  if (ref.mdIntermediateHash && ref.mdIntermediateHash !== record.mdIntermediateHash) return false;
  if (ref.error && ref.error !== record.error) return false;
  return true;
}

async function loadOpenClawAttachmentImportResultFromMeta(
  agent: Pick<DKGAgent, 'store'>,
  ref: OpenClawAttachmentImportResult,
): Promise<OpenClawAttachmentImportResult | undefined> {
  const metaGraph = contextGraphMetaUri(ref.contextGraphId);
  const metaResult = await agent.store.query(`
    SELECT ?fileHash ?contentType ?extractionStatus ?tripleCount ?sourceFileName WHERE {
      GRAPH <${metaGraph}> {
        <${ref.assertionUri}> <http://dkg.io/ontology/sourceFileHash> ?fileHash .
        <${ref.assertionUri}> <http://dkg.io/ontology/extractionStatus> ?extractionStatus .
        OPTIONAL { <${ref.assertionUri}> <http://dkg.io/ontology/sourceContentType> ?contentType }
        OPTIONAL { <${ref.assertionUri}> <http://dkg.io/ontology/structuralTripleCount> ?tripleCount }
        OPTIONAL { <${ref.assertionUri}> <http://dkg.io/ontology/sourceFileName> ?sourceFileName }
      }
    }
    LIMIT 1
  `) as { bindings?: Array<Record<string, string>> };
  const binding = metaResult?.bindings?.[0];
  if (!binding) return undefined;

  if (stripOpenClawAttachmentLiteral(binding.extractionStatus ?? '') !== 'skipped') return undefined;
  if (stripOpenClawAttachmentLiteral(binding.fileHash ?? '') !== ref.fileHash) return undefined;
  const storedContentType = stripOpenClawAttachmentLiteral(binding.contentType ?? '').trim();
  if (
    storedContentType &&
    normalizeDetectedContentType(ref.detectedContentType) !== normalizeDetectedContentType(storedContentType)
  ) {
    return undefined;
  }
  const storedTripleCount = parseOpenClawAttachmentTripleCount(binding.tripleCount ?? '');
  if (ref.tripleCount != null && storedTripleCount != null && ref.tripleCount !== storedTripleCount) {
    return undefined;
  }
  const storedFileName = stripOpenClawAttachmentLiteral(binding.sourceFileName ?? '').trim();
  if (!storedFileName) return undefined;
  if (storedFileName !== ref.fileName) return undefined;
  if (ref.pipelineUsed != null) return undefined;

  return {
    assertionUri: ref.assertionUri,
    contextGraphId: ref.contextGraphId,
    fileName: storedFileName || ref.fileName,
    fileHash: ref.fileHash,
    detectedContentType: storedContentType || ref.detectedContentType,
    extractionStatus: 'skipped',
    pipelineUsed: null,
    tripleCount: storedTripleCount ?? 0,
  };
}

async function loadOpenClawAttachmentImportSourceFileNameFromMeta(
  agent: Pick<DKGAgent, 'store'>,
  ref: OpenClawAttachmentImportResult,
): Promise<string | undefined> {
  const metaGraph = contextGraphMetaUri(ref.contextGraphId);
  const metaResult = await agent.store.query(`
    SELECT ?fileHash ?extractionStatus ?sourceFileName WHERE {
      GRAPH <${metaGraph}> {
        <${ref.assertionUri}> <http://dkg.io/ontology/sourceFileHash> ?fileHash .
        <${ref.assertionUri}> <http://dkg.io/ontology/extractionStatus> ?extractionStatus .
        OPTIONAL { <${ref.assertionUri}> <http://dkg.io/ontology/sourceFileName> ?sourceFileName }
      }
    }
    LIMIT 1
  `) as { bindings?: Array<Record<string, string>> };
  const binding = metaResult?.bindings?.[0];
  if (!binding) return undefined;
  if (stripOpenClawAttachmentLiteral(binding.extractionStatus ?? '') !== 'skipped') return undefined;
  if (stripOpenClawAttachmentLiteral(binding.fileHash ?? '') !== ref.fileHash) return undefined;
  const storedFileName = stripOpenClawAttachmentLiteral(binding.sourceFileName ?? '').trim();
  if (!storedFileName || storedFileName !== ref.fileName) return undefined;
  return storedFileName;
}

export async function verifyOpenClawAttachmentImportResultsProvenance(
  agent: Pick<DKGAgent, 'store'>,
  extractionStatus: Map<string, ExtractionStatusRecord>,
  attachmentImportResults: OpenClawAttachmentImportResult[] | undefined,
): Promise<OpenClawAttachmentImportResult[] | undefined> {
  if (!attachmentImportResults) return attachmentImportResults;

  const verified: OpenClawAttachmentImportResult[] = [];
  for (const ref of attachmentImportResults) {
    if (!isSafeIri(ref.assertionUri)) return undefined;
    if (ref.rootEntity && !isSafeIri(ref.rootEntity)) return undefined;
    if (!isOpenClawAttachmentAssertionUriForContextGraph(ref.assertionUri, ref.contextGraphId)) return undefined;

    const extractionRecord = getExtractionStatusRecord(extractionStatus, ref.assertionUri);
    if (extractionRecord) {
      if (!extractionRecordMatchesOpenClawAttachmentImportResult(ref, extractionRecord)) return undefined;
      const verifiedFileName = extractionRecord.fileName
        ?? await loadOpenClawAttachmentImportSourceFileNameFromMeta(agent, ref);
      if (!verifiedFileName) return undefined;

      verified.push({
        assertionUri: ref.assertionUri,
        contextGraphId: ref.contextGraphId,
        fileName: verifiedFileName,
        fileHash: extractionRecord.fileHash,
        detectedContentType: extractionRecord.detectedContentType,
        extractionStatus: 'skipped',
        pipelineUsed: extractionRecord.pipelineUsed,
        tripleCount: extractionRecord.tripleCount,
        ...(extractionRecord.rootEntity ? { rootEntity: extractionRecord.rootEntity } : {}),
        ...(extractionRecord.mdIntermediateHash ? { mdIntermediateHash: extractionRecord.mdIntermediateHash } : {}),
        ...(extractionRecord.error ? { error: extractionRecord.error } : {}),
      });
      continue;
    }

    const durableResult = await loadOpenClawAttachmentImportResultFromMeta(agent, ref);
    if (!durableResult) return undefined;
    verified.push(durableResult);
  }

  return verified;
}

function sanitizeAttachmentImportContextValue(value: string | number | null | undefined): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function attachmentImportContextKey(ref: OpenClawAttachmentImportResult): string {
  const digest = createHash('sha256')
    .update(`${ref.contextGraphId}\n${ref.assertionUri}\n${ref.fileHash}`)
    .digest('hex')
    .slice(0, 24);
  return `${ATTACHMENT_IMPORT_CONTEXT_KEY_PREFIX}${digest}`;
}

export function buildOpenClawAttachmentImportContextEntries(
  attachmentImportResults: OpenClawAttachmentImportResult[] | undefined,
): OpenClawChatContextEntry[] {
  if (!attachmentImportResults?.length) return [];
  return attachmentImportResults.map((ref) => {
    const metadata = {
      fileName: sanitizeAttachmentImportContextValue(ref.fileName),
      assertionUri: sanitizeAttachmentImportContextValue(ref.assertionUri),
      contextGraphId: sanitizeAttachmentImportContextValue(ref.contextGraphId),
      fileHash: sanitizeAttachmentImportContextValue(ref.fileHash),
      contentType: sanitizeAttachmentImportContextValue(ref.detectedContentType),
      extractionStatus: ref.extractionStatus,
      pipelineUsed: sanitizeAttachmentImportContextValue(ref.pipelineUsed ?? 'none'),
      tripleCount: ref.tripleCount ?? 0,
      ...(ref.rootEntity ? { rootEntity: sanitizeAttachmentImportContextValue(ref.rootEntity) } : {}),
      ...(ref.mdIntermediateHash ? { mdIntermediateHash: sanitizeAttachmentImportContextValue(ref.mdIntermediateHash) } : {}),
      ...(ref.error ? { error: sanitizeAttachmentImportContextValue(ref.error) } : {}),
    };
    return {
      key: attachmentImportContextKey(ref),
      label: `Attachment import result: ${sanitizeAttachmentImportContextValue(ref.fileName)}`,
      value: JSON.stringify(metadata),
    };
  });
}

