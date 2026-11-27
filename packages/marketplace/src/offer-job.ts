// SPDX-License-Identifier: Apache-2.0

/**
 * The seller's offers in Verifiable Memory (OT-RFC-27): one Knowledge Asset
 * per service, `offer-<serviceId>`, in the Marketplace Context Graph, kept as
 * the seller's terms are, by the offer job.
 *
 * Each run, for each service, while the node is a Core Node:
 *   1. A publish that was confirmed while the catalog's record of it was not
 *      kept ("catalog pending") is finished from its recovery evidence; it is
 *      never published again.
 *   2. The asset's end epoch is read from the chain, and with two epochs or
 *      fewer left the asset is extended by `TERM_EPOCHS`, from the wallet
 *      that pays for the node's publishes.
 *   3. The offer the seller would sign now: its settings, this epoch's price
 *      and the next's, and the asset's end epoch (for a new asset,
 *      `TERM_EPOCHS` from now). The schedule published is kept while it
 *      prices this epoch and the next as the seller does.
 *   4. Unchanged from the offer last published, and signed by the node's
 *      signing wallet, nothing is sent. Changed (a price, a setting, the peer
 *      id, the end epoch after an extension, the wallet that signs), it is
 *      signed, later than the one before it, and published: the first time, or
 *      as an update of the same asset.
 * A service the settings no longer name is withdrawn: its offer is published
 * once more, marked withdrawn, and no longer extended. What was published is
 * kept on disk by graph (`seller-offers-by-graph.json`), so a restart sends
 * nothing, and a graph the seller has not published to gets offers of its
 * own; the assets in a graph it published to before are kept as they are,
 * and extended no more while another graph is the seller's.
 *
 * A run that fails for a service (no TRAC, too few ACKs, a graph that is not
 * registered or has not admitted the node) leaves it as it was, says why in
 * Operate, and is tried again after a backoff: one tick, doubling up to an
 * hour. A seller without a published offer is not listed. Runs take turns,
 * and the seller starts them beside its landing tick, never inside it.
 */
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  SERVICE_CLASS_INFERENCE,
  enrichEvmError,
  type MarketplaceChainAdapter,
  type MarketplaceDomain,
} from '@origintrail-official/dkg-chain';
import { KeyedLock, writeDurably } from './journal.js';
import {
  MARKETPLACE_NS,
  scheduledPrice,
  serviceOfferFromWire,
  serviceOfferQuads,
  serviceOfferSignerOf,
  serviceOfferToWire,
  serviceOffersFromBindings,
  signServiceOffer,
  type OfferQuad,
  type ServiceOffer,
  type ServiceOfferWire,
} from './offers.js';

/** The epochs a new offer asset is stored for, and an extension adds. */
export const TERM_EPOCHS = 12;
/** An asset is extended once this many epochs or fewer are left of it. */
export const EXTEND_WITHIN_EPOCHS = 2;
/** The longest wait before a failed run is tried again, in seconds. */
export const MAX_OFFER_BACKOFF_SECONDS = 3_600;

/** Where the offers go: the Marketplace Context Graph's Verifiable Memory, through the node's agent. */
export interface OfferAssets {
  /** The graph's id, as the node's settings name it: what was published is kept by it. */
  contextGraphId: string;
  /** Publish `quads` as the asset `name`: the first time, or as an update of the one published under it. */
  publish(name: string, quads: OfferQuad[]): Promise<{ kaId: bigint }>;
  /** Finish the catalog's record of a confirmed publish, from the evidence its error carried. */
  recover(evidence: unknown): Promise<void>;
}

/** What a service offers, from the seller's settings. */
export interface OfferedService {
  serviceId: string;
  model: string;
  provenance: 'weights-pinned' | 'upstream-claimed';
  tokenizerBundle?: string;
  capacity: number | null;
}

export type ListingProblem =
  | 'not-core-node' | 'not-admitted' | 'no-trac' | 'no-ack-quorum' | 'graph-not-registered' | 'catalog-pending' | 'expired' | 'error';

/** A service's offer as Operate shows it (`Offering.listing`). */
export interface Listing {
  /** In Verifiable Memory, valid this epoch, not withdrawn, its catalog record kept, and the node a Core Node. */
  listed: boolean;
  kaId?: string;
  validUntilEpoch?: number;
  withdrawn?: boolean;
  /** Why it is not listed, or why its last run failed. */
  problem?: ListingProblem;
  message?: string;
  /** Chain seconds: when a failed run is tried again. */
  retryAt?: number;
}

/** Why a publish, an extension or a recovery failed, by the error's code, name or revert. */
export function listingProblemOf(err: unknown): ListingProblem {
  const { code, name } = (err ?? {}) as { code?: unknown; name?: unknown };
  if (code === 'MARKETPLACE_NOT_ADMITTED') return 'not-admitted';
  if (code === 'CONFIRMED_CATALOG_OBLIGATION_PENDING') return 'catalog-pending';
  if (code === 'CG_NOT_REGISTERED') return 'graph-not-registered';
  if (code === 'NO_FUNDED_PUBLISHER_WALLET' || name === 'InsufficientPublisherFundsError') return 'no-trac';
  if (name === 'QuorumUnmetError') return 'no-ack-quorum';
  const revert = enrichEvmError(err);
  if (revert === 'TooLowBalance' || revert === 'ERC20InsufficientBalance') return 'no-trac';
  if (code === 'OFFER_EXPIRED' || revert === 'KnowledgeAssetExpired') return 'expired';
  return 'error';
}

/** A confirmed publish whose catalog record is owed: the asset's id and the evidence to finish it from. */
function catalogPendingOf(err: unknown): { kaId: string; evidence: unknown } | undefined {
  if (listingProblemOf(err) !== 'catalog-pending') return undefined;
  const { transaction, recoveryEvidence } = err as { transaction?: { kaId?: bigint; batchId?: bigint }; recoveryEvidence?: unknown };
  const kaId = transaction?.kaId ?? transaction?.batchId;
  return kaId === undefined || recoveryEvidence === undefined ? undefined : { kaId: kaId.toString(), evidence: recoveryEvidence };
}

/** What is kept of one service's asset: its id, the offer last published, and the catalog record a confirmed publish owes. */
interface AssetRecord {
  kaId: string;
  offer: ServiceOfferWire;
  pending?: unknown;
}

/** The terms of two offers alike, `signedAt` and the signature aside. */
function sameTerms(a: Omit<ServiceOffer, 'signedAt' | 'signature'>, b: Omit<ServiceOffer, 'signedAt' | 'signature'>): boolean {
  const keys = ['seller', 'serviceId', 'serviceClass', 'unit', 'model', 'provenance', 'tokenizerBundle', 'capacity', 'peerId',
    'pricePerUnit', 'priceEpoch', 'nextPricePerUnit', 'validUntilEpoch', 'withdrawn'] as const;
  return keys.every((k) => a[k] === b[k]);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The offer a record keeps, when it reads back as a buyer reads its asset (offers.ts checks each field); `undefined` otherwise. */
function publishedOffer(wire: unknown): ServiceOffer | undefined {
  if (!isObject(wire)) return undefined;
  try {
    const offer = serviceOfferFromWire(wire as ServiceOfferWire);
    const row: Record<string, string> = {};
    for (const q of serviceOfferQuads(offer)) if (q.predicate.startsWith(MARKETPLACE_NS)) row[q.predicate.slice(MARKETPLACE_NS.length)] = q.object;
    const [read] = serviceOffersFromBindings([row]);
    return read && sameTerms(read, offer) && read.signedAt === offer.signedAt && read.signature === offer.signature ? read : undefined;
  } catch {
    return undefined;
  }
}

/** One graph's records as the file keeps them, each checked: an asset id, and an offer that reads back as published. Throws on any other. */
function recordsOf(value: unknown, where: string): Record<string, AssetRecord> {
  if (value === undefined) return {};
  if (!isObject(value)) throw new Error(`${where} holds no offers by service`);
  const records: Record<string, AssetRecord> = {};
  for (const [serviceId, record] of Object.entries(value)) {
    const { kaId, offer, pending } = isObject(record) ? record : ({} as Record<string, unknown>);
    const read = publishedOffer(offer);
    if (typeof kaId !== 'string' || !/^[1-9]\d*$/.test(kaId) || !read || read.serviceId !== serviceId) {
      throw new Error(`${where} holds no published offer for ${serviceId}`);
    }
    records[serviceId] = { kaId, offer: serviceOfferToWire(read), ...(pending === undefined ? {} : { pending }) };
  }
  return records;
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

export interface OfferJobDeps {
  chain: MarketplaceChainAdapter;
  /** Where `seller-offers-by-graph.json` goes. */
  dir: string;
  assets: OfferAssets;
  /** The operational wallet that signs offers. */
  signer: string;
  peerId: string;
  /** The first backoff, in seconds: the seller's tick. */
  tickSeconds: number;
  /** The seller as the job reads it: its gate, its services, and their prices, this epoch's frozen. */
  seller: {
    gate(): { identityId: bigint; open: boolean; domain: MarketplaceDomain | undefined };
    services(): readonly OfferedService[];
    prices(serviceId: string, epoch: number): Promise<{ price: bigint; nextPrice: bigint }>;
  };
  log?: (message: string) => void;
}

export class OfferJob {
  /** What was published in the graph the offers go to, by service id. */
  private records: Record<string, AssetRecord> = {};
  /** What the file keeps of the graphs published to before, as it was read: written back as it is. */
  private others: Record<string, unknown> = {};
  /** service id => its last run's failure, and how many in a row. */
  private readonly failures = new Map<string, { problem: ListingProblem; message: string; count: number; retryAt: number }>();
  private readonly closed = new Set<string>();
  private readonly lock = new KeyedLock();
  private running: Promise<void> | undefined;
  private again = false;
  private stopped = false;

  constructor(private readonly deps: OfferJobDeps) {}

  private get file(): string {
    return join(this.deps.dir, 'seller-offers-by-graph.json');
  }

  /**
   * Read what was published in the graph the offers go to. Call once before the first run. A file it cannot read,
   * or a record of the graph's that does not hold an asset id and its offer as published, fails the load.
   */
  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as { code?: string }).code !== 'ENOENT') throw err;
      return;
    }
    const graphs: unknown = JSON.parse(text);
    if (!isObject(graphs)) throw new Error(`${this.file} holds no offers by graph`);
    const { [this.deps.assets.contextGraphId]: records, ...others } = graphs;
    this.records = recordsOf(records, `${this.file}, in "${this.deps.assets.contextGraphId}",`);
    this.others = others;
  }

  /** A service's offer as Operate shows it, in `epoch`. */
  listingOf(serviceId: string, epoch: number): Listing {
    const id = serviceId.toLowerCase();
    const record = this.records[id];
    const failure = this.failures.get(id);
    const offer = record ? serviceOfferFromWire(record.offer) : undefined;
    const listed = !!offer && !offer.withdrawn && record!.pending === undefined && offer.validUntilEpoch >= epoch && !this.closed.has(id);
    return {
      listed,
      ...(record ? { kaId: record.kaId, validUntilEpoch: offer!.validUntilEpoch, withdrawn: offer!.withdrawn } : {}),
      ...(this.closed.has(id) ? { problem: 'not-core-node' as const } : {}),
      ...(failure ? { problem: failure.problem, message: failure.message, retryAt: failure.retryAt } : {}),
    };
  }

  /** Start a run beside whatever else the seller does; one asked for while one runs follows it. `now` drops the backoffs. */
  poke(now = false): void {
    if (now) for (const f of this.failures.values()) f.retryAt = 0;
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.run().catch((err: unknown) => this.deps.log?.(`[marketplace] the offers were not kept: ${messageOf(err)}`));
      } while (this.again && !this.stopped);
    })().finally(() => { this.running = undefined; });
  }

  /** Wait for the run in progress, and start no more. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.running;
  }

  /** One run over every service, the settings' and those withdrawn from them; runs take turns. */
  run(): Promise<void> {
    return this.lock.run('run', () => this.runNow());
  }

  private async runNow(): Promise<void> {
    const gate = this.deps.seller.gate();
    const times = await this.deps.chain.getEpochTimes();
    const services = new Map(this.deps.seller.services().map((s) => [s.serviceId.toLowerCase(), s]));
    for (const serviceId of new Set([...services.keys(), ...Object.keys(this.records)])) {
      const service = services.get(serviceId);
      this.closed.delete(serviceId);
      if (!gate.open || gate.domain === undefined) {
        this.closed.add(serviceId);
        continue;
      }
      const failure = this.failures.get(serviceId);
      if (failure && times.now < failure.retryAt) continue;
      try {
        await this.keep(serviceId, service, { identityId: gate.identityId, domain: gate.domain }, times);
        this.failures.delete(serviceId);
      } catch (err) {
        this.failed(serviceId, err, times.now);
      }
    }
  }

  /** Steps 1 to 4 of the module comment for one service; `service` absent for one the settings no longer name. */
  private async keep(
    serviceId: string,
    service: OfferedService | undefined,
    gate: { identityId: bigint; domain: MarketplaceDomain },
    times: { epoch: number; now: number },
  ): Promise<void> {
    let record = this.records[serviceId];
    if (record?.pending !== undefined) {
      await this.deps.assets.recover(record.pending);
      record = { kaId: record.kaId, offer: record.offer };
      await this.save(serviceId, record);
      this.deps.log?.(`[marketplace] the offer of ${serviceId} is on chain and its catalog record kept`);
    }
    const published = record ? serviceOfferFromWire(record.offer) : undefined;
    if (!service && (!published || published.withdrawn)) return;
    let validUntilEpoch = times.epoch + TERM_EPOCHS;
    if (record) {
      const kaId = BigInt(record.kaId);
      validUntilEpoch = Number((await this.deps.chain.getKnowledgeAssetUpdateContext(kaId)).endEpoch);
      if (validUntilEpoch < times.epoch) {
        // Buyers drop it already; one the settings still name is stuck there.
        if (!service) return;
        throw Object.assign(new Error(`the asset of ${serviceId}'s offer expired after epoch ${validUntilEpoch}`), { code: 'OFFER_EXPIRED' });
      }
      if (service && validUntilEpoch - times.epoch <= EXTEND_WITHIN_EPOCHS) {
        validUntilEpoch = (await this.deps.chain.extendKnowledgeAssetLifetime(kaId, TERM_EPOCHS)).endEpoch;
        this.deps.log?.(`[marketplace] the asset of ${serviceId}'s offer is stored through epoch ${validUntilEpoch}`);
      }
    }
    // A withdrawal keeps the schedule published; otherwise it is kept while it prices this epoch and the next as the seller does.
    const prices = service && await this.deps.seller.prices(serviceId, times.epoch);
    const schedule = published && (!prices
      || (scheduledPrice(published, times.epoch) === prices.price && scheduledPrice(published, times.epoch + 1) === prices.nextPrice))
      ? { pricePerUnit: published.pricePerUnit, priceEpoch: published.priceEpoch, ...(published.nextPricePerUnit === undefined ? {} : { nextPricePerUnit: published.nextPricePerUnit }) }
      : { pricePerUnit: prices!.price, priceEpoch: times.epoch, ...(prices!.nextPrice === prices!.price ? {} : { nextPricePerUnit: prices!.nextPrice }) };
    const terms = service ?? published!;
    const desired: Omit<ServiceOffer, 'signedAt' | 'signature'> = {
      seller: gate.identityId, serviceId, serviceClass: SERVICE_CLASS_INFERENCE, unit: 'token', model: terms.model, provenance: terms.provenance,
      ...(terms.tokenizerBundle ? { tokenizerBundle: terms.tokenizerBundle } : {}), capacity: terms.capacity, peerId: this.deps.peerId,
      ...schedule, validUntilEpoch, withdrawn: !service,
    };
    // An offer another wallet signed, as before the node's signing wallet changed, is signed again: buyers drop one whose signer is retired.
    if (published && sameTerms(published, desired) && serviceOfferSignerOf(gate.domain, published)?.toLowerCase() === this.deps.signer.toLowerCase()) return;
    const offer = await signServiceOffer(this.deps.chain, this.deps.signer, gate.domain, { ...desired, signedAt: Math.max(times.now, (published?.signedAt ?? 0) + 1) });
    try {
      const { kaId } = await this.deps.assets.publish(`offer-${serviceId}`, serviceOfferQuads(offer));
      await this.save(serviceId, { kaId: kaId.toString(), offer: serviceOfferToWire(offer) });
    } catch (err) {
      // Confirmed on chain, its catalog record owed: kept as published, and finished at the next run, never sent again.
      const pending = catalogPendingOf(err);
      if (pending) await this.save(serviceId, { kaId: pending.kaId, offer: serviceOfferToWire(offer), pending: pending.evidence });
      throw err;
    }
    this.deps.log?.(`[marketplace] ${offer.withdrawn ? 'withdrew' : 'published'} the offer of ${serviceId}, valid through epoch ${offer.validUntilEpoch}`);
  }

  /** A failed run: why, logged when the reason changes, and when it is tried again. */
  private failed(serviceId: string, err: unknown, now: number): void {
    const problem = listingProblemOf(err);
    const before = this.failures.get(serviceId);
    const count = (before?.count ?? 0) + 1;
    const wait = Math.min(this.deps.tickSeconds * 2 ** (count - 1), MAX_OFFER_BACKOFF_SECONDS);
    this.failures.set(serviceId, { problem, message: messageOf(err), count, retryAt: now + wait });
    if (before?.problem !== problem) this.deps.log?.(`[marketplace] the offer of ${serviceId} was not kept (${problem}), tried again in ${wait} s: ${messageOf(err)}`);
  }

  /** Keep one service's record on disk, under its graph: written beside the file, synced, then renamed over it. */
  private async save(serviceId: string, record: AssetRecord): Promise<void> {
    const records = { ...this.records, [serviceId]: record };
    await writeDurably(this.file, `${JSON.stringify({ ...this.others, [this.deps.assets.contextGraphId]: records }, null, 2)}\n`);
    this.records = records;
  }
}
