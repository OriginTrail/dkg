import { createHash, randomUUID } from 'node:crypto';
import type { DkgConfig } from './config.js';

export type AdoptionTelemetryEventType =
  | 'install_completed'
  | 'context_graph_synced';

export interface AdoptionTelemetryEvent {
  type: AdoptionTelemetryEventType;
  contextGraphId: string;
  dataSynced?: number;
  sharedMemorySynced?: number;
}

export interface AdoptionTelemetryReceipt {
  schemaVersion: 1;
  /** Unique sync/install occurrence. Retries of this occurrence reuse it. */
  receiptId: string;
  /** Stable key for (event, Context Graph, node); receivers UPSERT this key. */
  adoptionKey: string;
  event: AdoptionTelemetryEventType;
  contextGraphId: string;
  /** Stable pseudonymous node identity. The raw libp2p Peer ID never leaves the node. */
  nodeIdHash: string;
  nodeVersion?: string;
  network?: string;
  occurredAt: string;
  dataSynced?: number;
  sharedMemorySynced?: number;
}

export interface ResolvedAdoptionTelemetryConfig {
  enabled: boolean;
  endpoint?: string;
  token?: string;
  timeoutMs: number;
  maxAttempts: number;
  warning?: string;
}

export interface AdoptionTelemetrySink {
  readonly enabled: boolean;
  enqueue(event: AdoptionTelemetryEvent): boolean;
}

interface AdoptionTelemetryReporterOptions {
  config: ResolvedAdoptionTelemetryConfig;
  peerId: string;
  nodeVersion?: string;
  network?: string;
  fetcher?: typeof fetch;
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  maxPending?: number;
}

const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MAX_PENDING = 128;
const MAX_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 5;

function parseExplicitBoolean(raw: string | undefined): boolean | undefined {
  if (raw == null || raw.trim() === '') return undefined;
  const value = raw.trim().toLowerCase();
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  return undefined;
}

function positiveInteger(
  envValue: string | undefined,
  configValue: number | undefined,
  fallback: number,
  max: number,
): number {
  const candidate = envValue == null || envValue.trim() === ''
    ? configValue
    : Number(envValue);
  if (!Number.isSafeInteger(candidate) || Number(candidate) <= 0) return fallback;
  return Math.min(Number(candidate), max);
}

function validateEndpoint(raw: string | undefined): { endpoint?: string; warning?: string } {
  const endpoint = raw?.trim();
  if (!endpoint) return {};
  try {
    const parsed = new URL(endpoint);
    const loopback = parsed.hostname === 'localhost'
      || parsed.hostname === '127.0.0.1'
      || parsed.hostname === '[::1]';
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
      return { warning: 'adoption telemetry endpoint must use https (http is allowed only on loopback)' };
    }
    if (parsed.username || parsed.password) {
      return { warning: 'adoption telemetry endpoint must not contain credentials' };
    }
    return { endpoint: parsed.toString() };
  } catch {
    return { warning: 'adoption telemetry endpoint is not a valid URL' };
  }
}

/**
 * Resolve adoption telemetry independently from OTLP signals, but keep the
 * daemon-wide telemetry master switch authoritative. Both gates must be
 * explicit and an endpoint must resolve; otherwise no adoption data leaves
 * the node.
 */
export function resolveAdoptionTelemetryConfig(
  telemetry: DkgConfig['telemetry'],
  env: Readonly<Record<string, string | undefined>> = process.env,
): ResolvedAdoptionTelemetryConfig {
  const adoption = telemetry?.adoption;
  const envEnabledRaw = env.DKG_ADOPTION_TELEMETRY_ENABLED;
  const envEnabled = parseExplicitBoolean(envEnabledRaw);
  const invalidEnvEnabled = envEnabledRaw != null && envEnabledRaw.trim() !== '' && envEnabled === undefined;
  const explicitlyEnabled = envEnabled ?? adoption?.enabled === true;
  const { endpoint, warning } = validateEndpoint(
    env.DKG_ADOPTION_TELEMETRY_ENDPOINT ?? adoption?.endpoint,
  );
  const timeoutMs = positiveInteger(
    env.DKG_ADOPTION_TELEMETRY_TIMEOUT_MS,
    adoption?.timeoutMs,
    DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  );
  const maxAttempts = positiveInteger(
    env.DKG_ADOPTION_TELEMETRY_MAX_ATTEMPTS,
    adoption?.maxAttempts,
    DEFAULT_MAX_ATTEMPTS,
    MAX_ATTEMPTS,
  );

  if (telemetry?.enabled !== true) {
    return { enabled: false, timeoutMs, maxAttempts };
  }
  if (invalidEnvEnabled) {
    return {
      enabled: false,
      timeoutMs,
      maxAttempts,
      warning: 'DKG_ADOPTION_TELEMETRY_ENABLED must be true/false or 1/0',
    };
  }
  if (!explicitlyEnabled) {
    return { enabled: false, timeoutMs, maxAttempts };
  }
  if (warning) {
    return { enabled: false, timeoutMs, maxAttempts, warning };
  }
  if (!endpoint) {
    return {
      enabled: false,
      timeoutMs,
      maxAttempts,
      warning: 'adoption telemetry is enabled but no endpoint is configured',
    };
  }
  return {
    enabled: true,
    endpoint,
    token: env.DKG_ADOPTION_TELEMETRY_TOKEN ?? adoption?.token,
    timeoutMs,
    maxAttempts,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function adoptionNodeIdHash(peerId: string): string {
  return `sha256:${sha256(`dkg-adoption-node-v1\0${peerId}`)}`;
}

export function buildAdoptionTelemetryReceipt(
  event: AdoptionTelemetryEvent,
  identity: { peerId: string; nodeVersion?: string; network?: string },
  occurredAtMs = Date.now(),
  occurrenceId = randomUUID(),
): AdoptionTelemetryReceipt {
  const contextGraphId = event.contextGraphId.trim();
  if (!contextGraphId) throw new Error('adoption telemetry requires a contextGraphId');
  const nodeIdHash = adoptionNodeIdHash(identity.peerId);
  const adoptionKey = `sha256:${sha256(
    `dkg-adoption-receipt-v1\0${event.type}\0${contextGraphId}\0${nodeIdHash}`,
  )}`;
  const receiptId = `sha256:${sha256(
    `dkg-adoption-occurrence-v1\0${adoptionKey}\0${occurrenceId}`,
  )}`;
  const receipt: AdoptionTelemetryReceipt = {
    schemaVersion: 1,
    receiptId,
    adoptionKey,
    event: event.type,
    contextGraphId,
    nodeIdHash,
    nodeVersion: identity.nodeVersion,
    network: identity.network,
    occurredAt: new Date(occurredAtMs).toISOString(),
  };
  if (Number.isFinite(event.dataSynced)) receipt.dataSynced = event.dataSynced;
  if (Number.isFinite(event.sharedMemorySynced)) {
    receipt.sharedMemorySynced = event.sharedMemorySynced;
  }
  return receipt;
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * Best-effort, bounded adoption-receipt delivery. Callers enqueue after their
 * primary operation has succeeded; delivery never changes install/sync
 * success. Concurrent duplicates share one in-flight request, while later
 * repeats send a new receipt ID with the same adoption key so the receiver can
 * UPSERT lastSeen without counting a second node.
 */
export class AdoptionTelemetryReporter implements AdoptionTelemetrySink {
  readonly enabled: boolean;
  private readonly config: ResolvedAdoptionTelemetryConfig;
  private readonly identity: { peerId: string; nodeVersion?: string; network?: string };
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly log: (message: string) => void;
  private readonly maxPending: number;
  private readonly pending = new Map<string, Promise<void>>();
  private accepting = true;
  private warnedQueueFull = false;

  constructor(options: AdoptionTelemetryReporterOptions) {
    this.config = options.config;
    this.enabled = options.config.enabled;
    this.identity = {
      peerId: options.peerId,
      nodeVersion: options.nodeVersion,
      network: options.network,
    };
    this.fetcher = options.fetcher ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.delay = options.delay ?? defaultDelay;
    this.log = options.log ?? (() => {});
    this.maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
  }

  enqueue(event: AdoptionTelemetryEvent): boolean {
    if (!this.accepting || !this.enabled || !this.config.endpoint) return false;
    let receipt: AdoptionTelemetryReceipt;
    try {
      receipt = buildAdoptionTelemetryReceipt(event, this.identity, this.now());
    } catch (error) {
      this.log(`Adoption telemetry ignored invalid event: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    // A repeated sync arriving while the same adoption key is still being
    // delivered is redundant. A later repeat gets a new per-occurrence receipt
    // ID and refreshes lastSeen for the same adoption key.
    if (this.pending.has(receipt.adoptionKey)) return true;
    if (this.pending.size >= this.maxPending) {
      if (!this.warnedQueueFull) {
        this.warnedQueueFull = true;
        this.log(`Adoption telemetry queue full (${this.maxPending}); dropping new receipts`);
      }
      return false;
    }

    const task = this.deliver(receipt).finally(() => {
      this.pending.delete(receipt.adoptionKey);
      if (this.pending.size < this.maxPending) this.warnedQueueFull = false;
    });
    this.pending.set(receipt.adoptionKey, task);
    return true;
  }

  async flush(): Promise<void> {
    await Promise.allSettled([...this.pending.values()]);
  }

  async shutdown(): Promise<void> {
    this.accepting = false;
    await this.flush();
  }

  private async deliver(receipt: AdoptionTelemetryReceipt): Promise<void> {
    const endpoint = this.config.endpoint!;
    let lastError = 'unknown error';
    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt += 1) {
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(), this.config.timeoutMs);
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'Idempotency-Key': receipt.receiptId,
        };
        if (this.config.token) headers.Authorization = `Bearer ${this.config.token}`;
        const response = await this.fetcher(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(receipt),
          signal: abort.signal,
        });
        if (response.ok) return;
        lastError = `HTTP ${response.status}`;
        if (!isRetryableStatus(response.status)) break;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      } finally {
        clearTimeout(timeout);
      }
      if (attempt < this.config.maxAttempts) {
        await this.delay(Math.min(250 * 2 ** (attempt - 1), 2_000));
      }
    }
    this.log(
      `Adoption telemetry delivery failed for ${receipt.event}/${receipt.contextGraphId}: ${lastError}`,
    );
  }
}
