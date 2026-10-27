/**
 * The buyer's local per-seller recount standing (`SellerStandingBook`),
 * persisted atomically (0600) to `<dataDir>/marketplace/seller-standing.json`
 * after every record and loaded at runtime start. Standing is a LOCAL
 * observation that steers this buyer's router; it never affects settlement
 * (a seller-signed, buyer-authorized receipt settles regardless).
 *
 * A malformed file is moved aside (`.corrupt-<ms>`) with a warning and the
 * book starts empty — losing local history is safe, refusing to boot is not.
 * Persistence faults are warned about and swallowed.
 */
import { existsSync, readFileSync, renameSync } from 'node:fs';
import {
  SellerStandingBook,
  type RecountPolicy,
  type RecountVerdict,
  type SellerRecountRecord,
  type SellerStanding,
  type SellerStandingBookJson,
} from '@origintrail-official/dkg-marketplace';
import { writeFileAtomic0600 } from './atomic-file.js';
import type { MarketplaceLogger } from './seller-service.js';

export const SELLER_STANDING_FILE = 'seller-standing.json';

export class SellerStandingStore {
  readonly #path: string | undefined;
  readonly #log: MarketplaceLogger;
  readonly book: SellerStandingBook;

  constructor(path: string | undefined, policy: Partial<RecountPolicy> | undefined, log: MarketplaceLogger) {
    this.#path = path;
    this.#log = log;
    this.book = new SellerStandingBook(policy, this.#load(policy));
  }

  #load(policy: Partial<RecountPolicy> | undefined): SellerStandingBookJson | undefined {
    const path = this.#path;
    if (!path || !existsSync(path)) return undefined;
    try {
      const json = JSON.parse(readFileSync(path, 'utf8')) as SellerStandingBookJson;
      new SellerStandingBook(policy, json); // validate before adopting
      return json;
    } catch (error) {
      const aside = `${path}.corrupt-${Date.now()}`;
      try {
        renameSync(path, aside);
      } catch { /* leave it; the next persist overwrites */ }
      this.#log.warn(
        `[marketplace] seller standing file ${path} is malformed (moved to ${aside}); starting empty: ${(error as Error).message}`,
      );
      return undefined;
    }
  }

  #persist(): void {
    if (!this.#path) return;
    try {
      writeFileAtomic0600(this.#path, `${JSON.stringify(this.book.toJSON())}\n`);
    } catch (error) {
      this.#log.warn(`[marketplace] seller standing persist failed: ${(error as Error).message}`);
    }
  }

  record(sellerIdentityId: bigint, verdict: RecountVerdict, nowSeconds: number): SellerStanding {
    const standing = this.book.record(sellerIdentityId, verdict, nowSeconds);
    this.#persist();
    return standing;
  }

  reset(sellerIdentityId: bigint): boolean {
    const removed = this.book.reset(sellerIdentityId);
    if (removed) this.#persist();
    return removed;
  }

  standings(nowSeconds: number): Map<string, SellerStanding> {
    return this.book.standings(nowSeconds);
  }

  snapshot(nowSeconds: number): Array<SellerRecountRecord & { standing: SellerStanding }> {
    return this.book.snapshot(nowSeconds);
  }

  summary(nowSeconds: number): { sellers: number; deprioritized: number; denied: number } {
    let deprioritized = 0;
    let denied = 0;
    const standings = this.book.standings(nowSeconds);
    for (const standing of standings.values()) {
      if (standing === 'deprioritized') deprioritized += 1;
      if (standing === 'denied') denied += 1;
    }
    return { sellers: standings.size, deprioritized, denied };
  }
}
