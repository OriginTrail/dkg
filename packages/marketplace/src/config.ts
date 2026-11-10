// SPDX-License-Identifier: Apache-2.0

/**
 * The `marketplace` block of the node's config. The marketplace is off unless
 * `enabled` is true.
 */
import { ethers } from 'ethers';
import { MAX_TOKENS_FIELDS, type ConnectorSettings } from './connector.js';
import { DEFAULT_LANDING, type LandingSettings } from './landing.js';
import { serviceIdOf } from './offers.js';
import { DEFAULT_STOP_SERVING_SECONDS } from './seller.js';

export interface MarketplaceConfig {
  /** Off by default: the node funds nothing. */
  enabled?: boolean;
  /**
   * The operational wallet that pays for subscriptions: the sender of every
   * funding and top-up. One of the node's operational wallets, the primary
   * one by default.
   */
  buyerWallet?: string;
  /** How long before an epoch ends the node funds the next epoch's subscription. Default 120. */
  prefundLeadMinutes?: number;
  /** How often the buyer's job runs. Default 300. */
  tickSeconds?: number;
  /**
   * The Marketplace Context Graph, where sellers share their offers and buyers read them. A graph that admits every
   * node: registered on chain as public, or in its owner's wallet namespace (`0x<owner>/<name>`), whose owner's
   * signed policy a node fetches from its peers. A node shares into it and reads it once it is admitted. Unset, the
   * daemon uses the graph its network config names (`network/<name>.json#marketplace.contextGraphId`; testnet's).
   */
  contextGraphId?: string;
  /** Selling: off unless `seller.enabled`, and only while the node is a Core Node. */
  seller?: SellerConfig;
  /** A reference rate the catalog shows USD by; none by default. */
  fx?: { tracUsd?: number; source?: string; asOf?: number };
}

/** The catalog's reference rate (`Fx`): USD per TRAC, where it comes from and when it was read; a null rate hides USD. */
export interface Fx {
  tracUsd: number | null;
  source: string;
  asOf: number | null;
}

export const NO_FX: Readonly<Fx> = Object.freeze({ tracUsd: null, source: 'none', asOf: null });

/** The reference rate from the settings. */
export function resolveFx(config: MarketplaceConfig | undefined): Fx {
  const fx = config?.fx;
  if (fx === undefined) return { ...NO_FX };
  const tracUsd = fx.tracUsd ?? null;
  if (tracUsd !== null && (typeof tracUsd !== 'number' || !Number.isFinite(tracUsd) || tracUsd <= 0)) {
    throw new Error('marketplace.fx.tracUsd must be a positive number of USD per TRAC');
  }
  const asOf = fx.asOf ?? null;
  if (asOf !== null && (!Number.isSafeInteger(asOf) || asOf <= 0)) throw new Error('marketplace.fx.asOf must be a time in seconds');
  const source = fx.source ?? (tracUsd === null ? NO_FX.source : 'config');
  if (typeof source !== 'string' || source === '') throw new Error('marketplace.fx.source must say where the rate comes from');
  return { tracUsd, source, asOf };
}

export interface SellerConfig {
  enabled?: boolean;
  services?: SellerServiceConfig[];
  /** New calls stop this long before an epoch ends. Default 180. */
  stopServingSeconds?: number;
  /** How often the seller checks its gate, shares its offers and lands, from the epoch's start. Default 300. */
  tickSeconds?: number;
  /** The landing loop; each setting has its default. */
  landing?: LandingConfig;
}

export interface LandingConfig {
  /** Default 120. */
  landingIntervalMinutes?: number;
  /** Land at every tick this near the end. Default 20. */
  lastStretchMinutes?: number;
  /** One more tick this long before the end; 0 turns it off. Default 60. */
  finalLandingSeconds?: number;
  /** Land once a budget's unlanded value reaches this share of what it has left; 0 turns it off. Default 0.5. */
  nearLimitShare?: number;
  /** Send nothing this near the end. Default 30. */
  endMarginSeconds?: number;
  /** Land only receipts completed this long before the chain's time. Default 30. */
  completedMarginSeconds?: number;
  /** Default 3. */
  maxBatchesPerTick?: number;
  /** Default 8. */
  maxFaultDrops?: number;
  /** Send nothing while the base fee is above this, in gwei. Default 0.25. */
  baseFeeCeilingGwei?: number;
  /** The ceiling in the last stretch, in gwei. Default 1. */
  lastStretchBaseFeeCeilingGwei?: number;
}

export interface SellerServiceConfig {
  /** The model's URN; its keccak256 is the service id. */
  model: string;
  /** Wei per token, input and output alike, for epochs whose price is not frozen yet. */
  pricePerUnit: string;
  /** Calls taken at once, as the offer states it. */
  capacity?: number;
  /** By default weights-pinned for a llama.cpp backend, upstream-claimed for another. */
  provenance?: 'weights-pinned' | 'upstream-claimed';
  tokenizerBundle?: string;
  /**
   * Whether the service takes OpenAI tool calls, said in its quotes. On by default for an `openai` backend, off for
   * llama.cpp, whose server takes tools only when it runs with a tool-calling chat template.
   */
  tools?: boolean;
  backend: ConnectorSettings;
}

export interface ResolvedSellerService extends Omit<SellerServiceConfig, 'pricePerUnit' | 'capacity' | 'provenance' | 'tools'> {
  serviceId: string;
  pricePerUnit: bigint;
  capacity: number | null;
  provenance: 'weights-pinned' | 'upstream-claimed';
  tools: boolean;
}

export interface ResolvedSellerConfig {
  contextGraphId: string | undefined;
  services: ResolvedSellerService[];
  stopServingSeconds: number;
  tickSeconds: number;
  landing: LandingSettings;
}

export interface ResolvedMarketplaceConfig {
  enabled: boolean;
  buyerWallet: string;
  prefundLeadSeconds: number;
  tickSeconds: number;
}

export const DEFAULT_PREFUND_LEAD_MINUTES = 120;
export const DEFAULT_TICK_SECONDS = 300;

/**
 * The marketplace settings with their defaults. `operationalWallets` are the
 * node's, the primary one first; the buyer wallet must be one of them, since
 * the node signs its transactions.
 */
export function resolveMarketplaceConfig(
  config: MarketplaceConfig | undefined,
  operationalWallets: readonly string[],
): ResolvedMarketplaceConfig {
  const primary = operationalWallets[0];
  const buyer = config?.buyerWallet ?? primary;
  if (buyer === undefined || !ethers.isAddress(buyer)) {
    throw new Error('marketplace.buyerWallet must be an address; the node has no operational wallet to default to');
  }
  if (!operationalWallets.some((wallet) => wallet.toLowerCase() === buyer.toLowerCase())) {
    throw new Error(`marketplace.buyerWallet ${buyer} is not one of this node's operational wallets`);
  }
  const lead = config?.prefundLeadMinutes ?? DEFAULT_PREFUND_LEAD_MINUTES;
  if (!Number.isFinite(lead) || lead <= 0) throw new Error('marketplace.prefundLeadMinutes must be a positive number');
  const tick = config?.tickSeconds ?? DEFAULT_TICK_SECONDS;
  if (!Number.isInteger(tick) || tick < 1) throw new Error('marketplace.tickSeconds must be a positive integer');
  return {
    enabled: config?.enabled === true,
    buyerWallet: ethers.getAddress(buyer),
    prefundLeadSeconds: Math.round(lead * 60),
    tickSeconds: tick,
  };
}

const UINT96_MAX = (1n << 96n) - 1n;

/**
 * The seller's settings with their defaults, or `null` while selling is off.
 * Every service needs a model URN, a price in wei per token, and a backend:
 * an OpenAI-compatible upstream, or llama.cpp on loopback.
 */
export function resolveSellerConfig(config: MarketplaceConfig | undefined): ResolvedSellerConfig | null {
  const seller = config?.seller;
  if (seller?.enabled !== true) return null;
  if (!Array.isArray(seller.services) || seller.services.length === 0) {
    throw new Error('marketplace.seller.services must list at least one service');
  }
  const seen = new Set<string>();
  const services = seller.services.map((s, i): ResolvedSellerService => {
    const at = `marketplace.seller.services[${i}]`;
    if (typeof s?.model !== 'string' || s.model.trim() === '') throw new Error(`${at}.model must be the model's URN`);
    const serviceId = serviceIdOf(s.model);
    if (seen.has(serviceId)) throw new Error(`${at}: ${s.model} is listed twice`);
    seen.add(serviceId);
    if (typeof s.pricePerUnit !== 'string' || !/^[1-9]\d*$/.test(s.pricePerUnit) || BigInt(s.pricePerUnit) > UINT96_MAX) {
      throw new Error(`${at}.pricePerUnit must be a decimal string of wei per token, above 0`);
    }
    const capacity = s.capacity ?? null;
    if (capacity !== null && (!Number.isSafeInteger(capacity) || capacity < 1)) throw new Error(`${at}.capacity must be a positive integer`);
    const b = s.backend;
    if (b?.kind !== 'openai' && b?.kind !== 'llamacpp') throw new Error(`${at}.backend.kind must be openai or llamacpp`);
    if (typeof b.baseUrl !== 'string' || !URL.canParse(b.baseUrl)) throw new Error(`${at}.backend.baseUrl must be a URL`);
    if (typeof b.model !== 'string' || b.model === '') throw new Error(`${at}.backend.model must name the backend's model`);
    if (b.apiKeyEnv !== undefined && !/^[A-Z_][A-Z0-9_]*$/.test(b.apiKeyEnv)) {
      throw new Error(`${at}.backend.apiKeyEnv must name an environment variable`);
    }
    if (s.tools !== undefined && typeof s.tools !== 'boolean') throw new Error(`${at}.tools must be true or false`);
    if (b.maxTokensField !== undefined && !MAX_TOKENS_FIELDS.includes(b.maxTokensField)) {
      throw new Error(`${at}.backend.maxTokensField must be max_tokens or max_completion_tokens`);
    }
    if (b.temperature !== undefined && b.temperature !== null && (typeof b.temperature !== 'number' || !Number.isFinite(b.temperature) || b.temperature < 0 || b.temperature > 2)) {
      throw new Error(`${at}.backend.temperature must be a number from 0 to 2, or null to send none`);
    }
    return {
      model: s.model,
      serviceId,
      pricePerUnit: BigInt(s.pricePerUnit),
      capacity,
      provenance: s.provenance ?? (b.kind === 'llamacpp' ? 'weights-pinned' : 'upstream-claimed'),
      tools: s.tools ?? b.kind === 'openai',
      ...(s.tokenizerBundle ? { tokenizerBundle: s.tokenizerBundle } : {}),
      backend: b,
    };
  });
  const stop = seller.stopServingSeconds ?? DEFAULT_STOP_SERVING_SECONDS;
  if (!Number.isInteger(stop) || stop < 0) throw new Error('marketplace.seller.stopServingSeconds must be a whole number of seconds');
  const tick = seller.tickSeconds ?? DEFAULT_TICK_SECONDS;
  if (!Number.isInteger(tick) || tick < 1) throw new Error('marketplace.seller.tickSeconds must be a positive integer');
  return { contextGraphId: config?.contextGraphId, services, stopServingSeconds: stop, tickSeconds: tick, landing: resolveLanding(seller.landing) };
}

type WholeLandingSetting = Exclude<keyof LandingConfig & keyof LandingSettings, 'nearLimitShare'>;

/** The landing settings with their defaults; whole numbers but the share and the ceilings. */
function resolveLanding(config: LandingConfig | undefined): LandingSettings {
  const at = (name: string) => `marketplace.seller.landing.${name}`;
  const whole = (name: WholeLandingSetting, least: number): number => {
    const value = config?.[name] ?? DEFAULT_LANDING[name];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < least) throw new Error(`${at(name)} must be a whole number of at least ${least}`);
    return value;
  };
  const gwei = (name: 'baseFeeCeilingGwei' | 'lastStretchBaseFeeCeilingGwei', fallback: bigint): bigint => {
    const value = config?.[name];
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`${at(name)} must be a positive number of gwei`);
    return BigInt(Math.round(value * 1e9));
  };
  const share = config?.nearLimitShare ?? DEFAULT_LANDING.nearLimitShare;
  if (typeof share !== 'number' || !(share >= 0 && share <= 1)) throw new Error(`${at('nearLimitShare')} must be a share from 0 to 1`);
  return {
    landingIntervalMinutes: whole('landingIntervalMinutes', 1),
    lastStretchMinutes: whole('lastStretchMinutes', 0),
    finalLandingSeconds: whole('finalLandingSeconds', 0),
    nearLimitShare: share,
    endMarginSeconds: whole('endMarginSeconds', 0),
    completedMarginSeconds: whole('completedMarginSeconds', 0),
    maxBatchesPerTick: whole('maxBatchesPerTick', 1),
    maxFaultDrops: whole('maxFaultDrops', 0),
    baseFeeCeiling: gwei('baseFeeCeilingGwei', DEFAULT_LANDING.baseFeeCeiling),
    lastStretchBaseFeeCeiling: gwei('lastStretchBaseFeeCeilingGwei', DEFAULT_LANDING.lastStretchBaseFeeCeiling),
  };
}
