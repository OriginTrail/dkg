/**
 * Seller offering resolution: config → served `MarketplaceSellerOffering`.
 *
 *  - Static offerings (`stub-inference`, `local-query`) resolve synchronously;
 *    `local-query` publishes the query cost schedule pin.
 *  - `chat-connector` offerings MOUNT: semantic checks, the pinned tokenizer
 *    (its file digest IS the published pin), then the connector. A mount
 *    failure is a `MarketplaceConnectorMountError` naming the offering.
 *
 * `SellerConnectorManager` owns the served set on top of that:
 *  - boot (`boot`): static offerings serve immediately; connector offerings
 *    mount in the background and, on failure, are held `failed` (quote →
 *    `CONNECTOR_UNAVAILABLE`, serve → `UNKNOWN_OFFERING`, never published) and
 *    retried with backoff (60 s, doubling, capped at 10 min). A successful
 *    retry swaps the offering in; boot never publishes.
 *  - replace (`replace`, from `marketplaceSetOfferings`): ALL-OR-NOTHING —
 *    every connector mounts first; any failure throws and the old set stays.
 *    It cancels pending boot retries.
 */
import { ethers } from 'ethers';
import {
  CHAT_PAYLOAD_SCHEMA,
  CHAT_TEMPLATE_OPENAI_COUNT_V1,
  CHAT_TEMPLATE_OPENAI_COUNT_V1_DIGEST,
  canonicalModelId,
  inferModelFamily,
  offeringIdFor,
  type MeteringBasis,
  type OfferModelFacts,
  type QueryGuards,
  type TokenCountEngine,
  type TokenizerKind,
} from '@origintrail-official/dkg-marketplace';
import { createChatConnectorExecutor } from './chat-executor.js';
import type { MarketplaceConnectorConfig, MarketplaceOfferingConfig } from './config.js';
import { mountChatConnector, type ChatConnectorMountDeps } from './connectors/index.js';
import type { ChatConnector, ChatConnectorKind } from './connectors/types.js';
import { MarketplaceConnectorMountError } from './connectors/types.js';
import {
  QUERY_OFFER_COST_PIN,
  createQueryExecutor,
  createStubInferenceExecutor,
  type MarketplaceQueryFn,
} from './executors.js';
import { MAX_OFFER_FACT_CHARS } from './offer-rdf.js';
import type { MarketplaceLogger, MarketplaceSellerOffering, MarketplaceSellerService } from './seller-service.js';
import { loadTokenizerEngine } from './tokenizer-files.js';

export interface SellerOfferingDeps extends Omit<ChatConnectorMountDeps, 'log'> {
  log: MarketplaceLogger;
  queryFn: MarketplaceQueryFn;
  queryGuards?: Partial<QueryGuards>;
  /** Injectable result cap (tests); default `MAX_SERVE_RESULT_BYTES`. */
  maxResultBytes?: number;
}

export interface MarketplaceConnectorStatus {
  offeringLocalId: string;
  modelId: string;
  kind: ChatConnectorKind;
  state: 'mounting' | 'mounted' | 'failed';
  detail?: string;
  upstreamOrigin?: string;
  secretConfigured: boolean;
  metering: { basis: MeteringBasis; tokenizerKind?: TokenizerKind; tokenizerDigest?: string };
  weightsDigest?: string;
  health?: { ok: boolean; latencyMs: number; detail?: string; checkedAt: number };
}

export function isConnectorOffering(config: MarketplaceOfferingConfig): boolean {
  return config.executor === 'chat-connector' || (config.executor === undefined && config.connector !== undefined);
}

function configError(config: MarketplaceOfferingConfig, message: string, code: MarketplaceConnectorMountError['code'] = 'CONNECTOR_CONFIG'): never {
  throw new MarketplaceConnectorMountError(code, `offering ${config.offeringLocalId}: ${message}`, config.offeringLocalId);
}

function resolveAllowedBuyers(config: MarketplaceOfferingConfig): ReadonlySet<string> | undefined {
  if (config.allowedBuyers === undefined || config.allowedBuyers.length === 0) return undefined;
  const out = new Set<string>();
  for (const address of config.allowedBuyers) {
    if (typeof address !== 'string' || !ethers.isAddress(address.toLowerCase())) configError(config, 'allowedBuyers must list EVM addresses');
    out.add(address.toLowerCase());
  }
  return out;
}

function baseOffering(config: MarketplaceOfferingConfig, modelId: string | undefined) {
  const allowedBuyers = resolveAllowedBuyers(config);
  return {
    offeringLocalId: config.offeringLocalId,
    offeringId: offeringIdFor(config.offeringLocalId),
    serviceType: config.serviceType,
    ...(modelId !== undefined ? { modelId } : {}),
    unit: config.unit,
    askPerUnitWei: config.askPerUnitWei,
    ...(config.capacityUnitsPerMin !== undefined ? { capacityUnitsPerMin: config.capacityUnitsPerMin } : {}),
    ...(config.expiresAt !== undefined ? { expiresAt: config.expiresAt } : {}),
    ...(allowedBuyers ? { allowedBuyers, access: 'restricted' as const } : {}),
  };
}

/** A `stub-inference` / `local-query` offering (no mount). */
export function resolveStaticOffering(config: MarketplaceOfferingConfig, deps: SellerOfferingDeps): MarketplaceSellerOffering {
  if (config.connector !== undefined) configError(config, 'a connector requires executor chat-connector');
  const kind = config.executor ?? (config.serviceType === 'query' ? 'local-query' : 'stub-inference');
  // Non-connector offerings keep their model id, canonicalized when valid.
  const modelId = config.modelId === undefined ? undefined : canonicalModelId(config.modelId) ?? config.modelId;
  if (kind === 'local-query') {
    return {
      ...baseOffering(config, modelId),
      executor: createQueryExecutor(deps.queryFn, {
        ...(deps.queryGuards ? { guards: deps.queryGuards } : {}),
        ...(deps.maxResultBytes !== undefined ? { maxResultBytes: deps.maxResultBytes } : {}),
      }),
      queryCost: { ...QUERY_OFFER_COST_PIN },
    };
  }
  if (kind !== 'stub-inference') configError(config, 'executor chat-connector requires a connector');
  return { ...baseOffering(config, modelId), executor: createStubInferenceExecutor() };
}

/** Published free-form facts: printable, no backslash (the RDF literal round trip stays exact). */
function isPublishableFact(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f || ch === '\\') return false;
  }
  return value.length > 0;
}

function optionalFact(config: MarketplaceOfferingConfig, value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_OFFER_FACT_CHARS || !isPublishableFact(value)) {
    configError(config, `model.${field} must be a printable string (no backslash) of at most ${MAX_OFFER_FACT_CHARS} characters`);
  }
  return value;
}

function minDefined(a: bigint | undefined, b: bigint | undefined): bigint | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a < b ? a : b;
}

/** Mount one `chat-connector` offering. Throws `MarketplaceConnectorMountError` (with `offeringLocalId`). */
export async function mountConnectorOffering(
  config: MarketplaceOfferingConfig,
  deps: SellerOfferingDeps,
): Promise<{ offering: MarketplaceSellerOffering; connector: ChatConnector }> {
  const connectorConfig = config.connector;
  if (!connectorConfig) configError(config, 'executor chat-connector requires a connector');
  if (config.serviceType !== 'inference' || config.unit !== 'token') {
    configError(config, 'a chat-connector offering must be serviceType inference with unit token');
  }
  const modelId = canonicalModelId(config.modelId);
  if (modelId === undefined) configError(config, 'a chat-connector offering needs a modelId matching the canonical model-id pattern');
  const base = baseOffering(config, modelId);
  const tokenizer = config.metering?.tokenizer;
  if (connectorConfig.kind === 'llamacpp' && tokenizer?.kind !== 'hf-bpe-v1') {
    configError(config, 'a llamacpp offering must pin metering.tokenizer.kind hf-bpe-v1');
  }
  if (connectorConfig.kind === 'codex-oauth') {
    if (tokenizer?.kind !== 'tiktoken-o200k-v1') configError(config, 'a codex-oauth offering must pin metering.tokenizer.kind tiktoken-o200k-v1');
    if (!base.allowedBuyers) {
      configError(config, 'a codex-oauth offering needs a non-empty allowedBuyers (subscription scope)', 'CONNECTOR_SCOPE');
    }
  }
  const displayName = optionalFact(config, config.model?.displayName, 'displayName');
  const family = optionalFact(config, config.model?.family, 'family');
  const quantization = optionalFact(config, config.model?.quantization, 'quantization');
  if (config.model?.contextLength !== undefined && config.model.contextLength <= 0n) configError(config, 'model.contextLength must be positive');

  let engine: TokenCountEngine | undefined;
  if (tokenizer) {
    try {
      engine = loadTokenizerEngine(tokenizer.kind, tokenizer.path);
    } catch (error) {
      configError(config, (error as Error).message, 'CONNECTOR_TOKENIZER');
    }
  }
  let connector: ChatConnector;
  try {
    connector = await mountChatConnector(connectorConfig, deps);
  } catch (error) {
    if (error instanceof MarketplaceConnectorMountError) {
      throw new MarketplaceConnectorMountError(error.code, `offering ${config.offeringLocalId}: ${error.message}`, config.offeringLocalId);
    }
    throw error;
  }
  const desc = connector.description;
  if (desc.kind !== 'llamacpp' && !isPublishableFact(desc.upstreamModel)) {
    configError(config, 'connector.upstreamModel must be printable (no backslash): it is published as mkt:upstreamModel');
  }
  const contextLength = minDefined(config.model?.contextLength, desc.contextLength);
  const model: OfferModelFacts = {
    provenanceClass: desc.provenanceClass,
    ...(desc.kind !== 'llamacpp' ? { upstreamModel: desc.upstreamModel } : {}),
    ...(desc.weightsDigest !== undefined ? { weightsDigest: desc.weightsDigest } : {}),
    ...(desc.servingSeed !== undefined ? { servingSeed: desc.servingSeed } : {}),
    ...(desc.servingTemperature !== undefined ? { servingTemperature: desc.servingTemperature } : {}),
    ...(contextLength !== undefined ? { contextLength } : {}),
    ...((family ?? inferModelFamily(modelId)) !== undefined ? { family: family ?? inferModelFamily(modelId) } : {}),
    ...(displayName !== undefined ? { displayName } : {}),
    ...(quantization !== undefined ? { quantization } : {}),
  };
  const offering: MarketplaceSellerOffering = {
    ...base,
    executor: createChatConnectorExecutor({
      connector,
      modelId,
      ...(engine ? { engine } : {}),
      ...(contextLength !== undefined ? { contextLength } : {}),
      ...(deps.maxResultBytes !== undefined ? { maxResultBytes: deps.maxResultBytes } : {}),
    }),
    apiShape: CHAT_PAYLOAD_SCHEMA,
    toolTransport: desc.toolTransport,
    metering: engine
      ? {
          basis: 'pinned',
          tokenizer: { kind: engine.kind, digest: engine.digest },
          chatTemplate: { id: CHAT_TEMPLATE_OPENAI_COUNT_V1.version, digest: CHAT_TEMPLATE_OPENAI_COUNT_V1_DIGEST },
        }
      : { basis: 'provider-reported' },
    model,
  };
  return { offering, connector };
}

function originOf(connector: MarketplaceConnectorConfig): string | undefined {
  const raw = connector.kind === 'codex-oauth' ? connector.baseUrl ?? 'https://chatgpt.com' : connector.baseUrl;
  try {
    return new URL(raw).origin;
  } catch {
    return undefined;
  }
}

interface ConnectorEntry {
  config: MarketplaceOfferingConfig;
  state: 'mounting' | 'mounted' | 'failed';
  offering?: MarketplaceSellerOffering;
  connector?: ChatConnector;
  detail?: string;
  health?: MarketplaceConnectorStatus['health'];
}

const RETRY_INITIAL_MS = 60_000;
const RETRY_MAX_MS = 600_000;

export class SellerConnectorManager {
  readonly #seller: MarketplaceSellerService;
  readonly #deps: SellerOfferingDeps;
  #configs: MarketplaceOfferingConfig[] = [];
  #static = new Map<string, MarketplaceSellerOffering>();
  #connectors = new Map<string, ConnectorEntry>();
  #generation = 0;
  #timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(seller: MarketplaceSellerService, deps: SellerOfferingDeps) {
    this.#seller = seller;
    this.#deps = deps;
  }

  /** Runtime start: serve static offerings now, mount connectors in the background (with retry). */
  boot(configs: readonly MarketplaceOfferingConfig[]): void {
    const generation = ++this.#generation;
    this.#configs = [...configs];
    this.#static = new Map();
    this.#connectors = new Map();
    for (const config of configs) {
      if (isConnectorOffering(config)) {
        this.#connectors.set(config.offeringLocalId, { config, state: 'mounting' });
        continue;
      }
      try {
        this.#static.set(config.offeringLocalId, resolveStaticOffering(config, this.#deps));
      } catch (error) {
        this.#deps.log.warn(`[marketplace] offering ${config.offeringLocalId} not served: ${(error as Error).message}`);
      }
    }
    this.#apply();
    for (const entry of this.#connectors.values()) void this.#mountInBackground(entry, generation, RETRY_INITIAL_MS);
  }

  /** `marketplaceSetOfferings`: all-or-nothing — mount every connector first, then swap. */
  async replace(configs: readonly MarketplaceOfferingConfig[]): Promise<void> {
    const nextStatic = new Map<string, MarketplaceSellerOffering>();
    for (const config of configs) {
      if (!isConnectorOffering(config)) nextStatic.set(config.offeringLocalId, resolveStaticOffering(config, this.#deps));
    }
    const mounts = await Promise.allSettled(
      configs.filter(isConnectorOffering).map(async (config) => ({ config, ...(await mountConnectorOffering(config, this.#deps)) })),
    );
    const failed = mounts.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    if (failed) throw failed.reason;
    this.#cancelRetries();
    this.#generation += 1;
    this.#configs = [...configs];
    this.#static = nextStatic;
    this.#connectors = new Map();
    for (const outcome of mounts) {
      if (outcome.status !== 'fulfilled') continue;
      const { config, offering, connector } = outcome.value;
      this.#connectors.set(config.offeringLocalId, { config, state: 'mounted', offering, connector });
    }
    this.#apply();
  }

  stop(): void {
    this.#cancelRetries();
    this.#generation += 1;
  }

  counts(): { mounted: number; failed: number; mounting: number } {
    const counts = { mounted: 0, failed: 0, mounting: 0 };
    for (const entry of this.#connectors.values()) counts[entry.state] += 1;
    return counts;
  }

  async status(opts: { probe?: boolean } = {}): Promise<MarketplaceConnectorStatus[]> {
    const entries = [...this.#connectors.values()];
    if (opts.probe) {
      await Promise.all(entries.map(async (entry) => {
        if (!entry.connector) return;
        const health = await entry.connector.health().catch((error: unknown) => ({
          ok: false, latencyMs: 0, detail: (error as Error)?.message ?? 'health probe failed',
        }));
        entry.health = { ...health, checkedAt: Math.floor((this.#deps.now ?? Date.now)() / 1000) };
      }));
    }
    return entries.map((entry) => this.#statusOf(entry));
  }

  #statusOf(entry: ConnectorEntry): MarketplaceConnectorStatus {
    const { config } = entry;
    const connectorConfig = config.connector!;
    const desc = entry.connector?.description;
    const metering = entry.offering?.metering;
    const origin = desc?.upstreamOrigin ?? originOf(connectorConfig);
    return {
      offeringLocalId: config.offeringLocalId,
      modelId: entry.offering?.modelId ?? canonicalModelId(config.modelId) ?? String(config.modelId ?? ''),
      kind: connectorConfig.kind,
      state: entry.state,
      ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
      ...(origin !== undefined ? { upstreamOrigin: origin } : {}),
      secretConfigured: desc?.secretConfigured
        ?? (connectorConfig.kind === 'openai-compatible' ? connectorConfig.secretEnvFile !== undefined : connectorConfig.kind === 'codex-oauth'),
      metering: metering?.basis === 'pinned'
        ? { basis: 'pinned', tokenizerKind: metering.tokenizer.kind, tokenizerDigest: metering.tokenizer.digest }
        : metering?.basis === 'provider-reported' || !config.metering?.tokenizer
          ? { basis: 'provider-reported' }
          : { basis: 'pinned', tokenizerKind: config.metering.tokenizer.kind },
      ...(desc?.weightsDigest !== undefined ? { weightsDigest: desc.weightsDigest } : {}),
      ...(entry.health ? { health: entry.health } : {}),
    };
  }

  async #mountInBackground(entry: ConnectorEntry, generation: number, nextDelayMs: number): Promise<void> {
    try {
      const { offering, connector } = await mountConnectorOffering(entry.config, this.#deps);
      if (generation !== this.#generation) return;
      Object.assign(entry, { state: 'mounted', offering, connector, detail: undefined });
      this.#apply();
      this.#deps.log.info(`[marketplace] connector offering ${entry.config.offeringLocalId} mounted (${connector.description.kind})`);
    } catch (error) {
      if (generation !== this.#generation) return;
      entry.state = 'failed';
      entry.detail = (error as Error).message;
      this.#apply();
      this.#deps.log.warn(
        `[marketplace] connector offering ${entry.config.offeringLocalId} failed to mount (retrying in ${Math.round(nextDelayMs / 1000)}s): ${entry.detail}`,
      );
      const timer = setTimeout(() => {
        this.#timers.delete(timer);
        if (generation !== this.#generation) return;
        void this.#mountInBackground(entry, generation, Math.min(nextDelayMs * 2, RETRY_MAX_MS));
      }, nextDelayMs);
      timer.unref?.();
      this.#timers.add(timer);
    }
  }

  #cancelRetries(): void {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
  }

  /** Push the served set (config order) and the unavailable connector ids to the seller. */
  #apply(): void {
    const served: MarketplaceSellerOffering[] = [];
    const unavailable: string[] = [];
    for (const config of this.#configs) {
      const staticOffering = this.#static.get(config.offeringLocalId);
      if (staticOffering) {
        served.push(staticOffering);
        continue;
      }
      const entry = this.#connectors.get(config.offeringLocalId);
      if (entry?.state === 'mounted' && entry.offering) served.push(entry.offering);
      else if (entry) unavailable.push(offeringIdFor(config.offeringLocalId));
    }
    this.#seller.setOfferings(served, { unavailable });
  }
}
