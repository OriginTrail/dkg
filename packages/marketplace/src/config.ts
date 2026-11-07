// SPDX-License-Identifier: Apache-2.0

/**
 * The `marketplace` block of the node's config. The marketplace is off unless
 * `enabled` is true.
 */
import { ethers } from 'ethers';
import type { ConnectorSettings } from './connector.js';
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
  /** The Marketplace Context Graph, where sellers share their offers and buyers read them. */
  contextGraphId?: string;
  /** Selling: off unless `seller.enabled`, and only while the node is a Core Node. */
  seller?: SellerConfig;
}

export interface SellerConfig {
  enabled?: boolean;
  services?: SellerServiceConfig[];
  /** New calls stop this long before an epoch ends. Default 180. */
  stopServingSeconds?: number;
  /** How often the seller checks its gate and shares its offers. Default 300. */
  tickSeconds?: number;
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
  backend: ConnectorSettings;
}

export interface ResolvedSellerService extends Omit<SellerServiceConfig, 'pricePerUnit' | 'capacity' | 'provenance'> {
  serviceId: string;
  pricePerUnit: bigint;
  capacity: number | null;
  provenance: 'weights-pinned' | 'upstream-claimed';
}

export interface ResolvedSellerConfig {
  contextGraphId: string | undefined;
  services: ResolvedSellerService[];
  stopServingSeconds: number;
  tickSeconds: number;
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
    return {
      model: s.model,
      serviceId,
      pricePerUnit: BigInt(s.pricePerUnit),
      capacity,
      provenance: s.provenance ?? (b.kind === 'llamacpp' ? 'weights-pinned' : 'upstream-claimed'),
      ...(s.tokenizerBundle ? { tokenizerBundle: s.tokenizerBundle } : {}),
      backend: b,
    };
  });
  const stop = seller.stopServingSeconds ?? DEFAULT_STOP_SERVING_SECONDS;
  if (!Number.isInteger(stop) || stop < 0) throw new Error('marketplace.seller.stopServingSeconds must be a whole number of seconds');
  const tick = seller.tickSeconds ?? DEFAULT_TICK_SECONDS;
  if (!Number.isInteger(tick) || tick < 1) throw new Error('marketplace.seller.tickSeconds must be a positive integer');
  return { contextGraphId: config?.contextGraphId, services, stopServingSeconds: stop, tickSeconds: tick };
}
