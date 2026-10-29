/**
 * #3591 — can a publisher wallet pay for its next publication? The claim asks this, so a job is
 * never claimed by a wallet the chain has just refused for funds while another wallet could pay.
 *
 * The answer rests on evidence, never on a guess. Until the chain has refused a publication for
 * funds, every wallet may claim and no balance is read. A definitive refusal (the node turned the
 * transaction away before the mempool, or the adapter found no funded wallet before signing) then:
 *   - keeps the refused wallet out of claims for a cooldown that doubles while the wallet stays
 *     short (30 s to 10 min). After each cooldown a fresh balance reading decides: the wallet is
 *     back once it covers the cost the node stated, or, when the node stated none, once its native
 *     or TRAC balance grew since the refusal (a top-up);
 *   - teaches the node the cost a publication needs, when the node stated it (`have X want Y`,
 *     `balance X, tx cost Y`). For an hour after that, a wallet claims only with a reading, taken
 *     since its last job, that covers that cost. A wallet below it is kept out like a refused one.
 *
 * Both are bounded by the same hour: a refused wallet with no top-up gets one more attempt after
 * it, because a stated cost goes stale when the gas price falls. Gas and balances can still change
 * between the claim and the send; the refusal that follows is again definitive, so the job is
 * retried rather than lost (`insufficient_funds` is in the automatic retry lane).
 *
 * Readings happen only when a wallet with a candidate job asks to claim, or right after a refusal,
 * and never under the claim lock: the claim gets `false` while a reading is pending, and the
 * reading's end pokes the wallet's loop. A reading that fails or does not answer in time counts as
 * unreadable, and an unreadable balance never keeps a wallet out on its own.
 *
 * State is in memory. After a restart a wallet that is still short is refused once more before
 * it is kept out again; the refused job itself keeps its retry schedule in the store.
 */

/** One wallet's balances in wei; `null` where the read failed. */
export interface AsyncLiftWalletBalances {
  readonly native: bigint | null;
  readonly trac: bigint | null;
}

/** Reads a publisher wallet's current balances from the chain. */
export type AsyncLiftWalletBalanceReader = (walletId: string) => Promise<AsyncLiftWalletBalances>;

export const WALLET_FUNDING_COOLDOWN_BASE_MS = 30_000;
export const WALLET_FUNDING_COOLDOWN_MAX_MS = 10 * 60_000;
/** How long a stated cost is applied, and how long a refused wallet stays out without a top-up. */
export const WALLET_FUNDING_EVIDENCE_TTL_MS = 60 * 60_000;
/** A reading older than this no longer shows that a wallet can pay the learned cost. */
export const WALLET_FUNDING_READING_TTL_MS = 60_000;
/** A balance read that has not answered by then counts as unreadable. */
export const WALLET_FUNDING_READ_TIMEOUT_MS = 15_000;

const UNREADABLE: AsyncLiftWalletBalances = { native: null, trac: null };

interface WalletExclusion {
  readonly since: number;
  cooldownMs: number;
  /** No claim and no new reading before this. */
  until: number;
  /** The cost the node stated for the refused transaction, or the learned cost the wallet was below. */
  readonly requiredNativeWei?: bigint;
  /** Read right after the refusal: a later reading above it shows a top-up. */
  balancesAtRefusal?: AsyncLiftWalletBalances;
}

interface WalletReading {
  readonly balances: AsyncLiftWalletBalances;
  /** When the read started. */
  readonly at: number;
}

interface WalletFundingRecord {
  excluded?: WalletExclusion;
  reading?: WalletReading;
  pendingRead?: Promise<void>;
  /** The wallet's last job ended here; a reading from before it no longer describes the wallet. */
  spentAt?: number;
}

export class AsyncLiftWalletFunding {
  private readonly wallets = new Map<string, WalletFundingRecord>();
  private requirement?: { readonly nativeWei: bigint; readonly learnedAt: number };

  constructor(private readonly options: {
    readonly readBalances?: AsyncLiftWalletBalanceReader;
    readonly now: () => number;
    /** Scheduling only: a reading settled, so the wallet's next claim attempt can decide. */
    readonly onReading: (walletId: string) => void;
  }) {}

  /** May this wallet claim the candidate job now? Synchronous; it may start a reading. */
  mayClaim(walletId: string): boolean {
    const now = this.options.now();
    const wallet = this.wallets.get(walletId);
    const excluded = wallet?.excluded;
    if (wallet && excluded) {
      if (now < excluded.until) return false;
      if (now - excluded.since < WALLET_FUNDING_EVIDENCE_TTL_MS && this.options.readBalances) {
        const reading = wallet.reading;
        if (!reading || reading.at < excluded.until) return this.read(walletId);
        if (!replenished(excluded, reading.balances)) {
          excluded.cooldownMs = Math.min(WALLET_FUNDING_COOLDOWN_MAX_MS, excluded.cooldownMs * 2);
          excluded.until = now + excluded.cooldownMs;
          return false;
        }
      }
      wallet.excluded = undefined;
    }
    const requirement = this.requirement;
    if (!requirement || now - requirement.learnedAt >= WALLET_FUNDING_EVIDENCE_TTL_MS || !this.options.readBalances) {
      return true;
    }
    const reading = wallet?.reading;
    if (!reading || reading.at <= (wallet?.spentAt ?? -Infinity) || now - reading.at > WALLET_FUNDING_READING_TTL_MS) {
      return this.read(walletId);
    }
    if (covers(reading.balances.native, requirement.nativeWei)) return true;
    this.exclude(walletId, now, requirement.nativeWei, reading.balances);
    return false;
  }

  /** The chain refused this wallet's publication for funds, definitively. */
  recordRefusal(walletId: string, error: unknown): void {
    const now = this.options.now();
    const stated = refusedTransactionCostWei(error);
    if (stated !== undefined) this.requirement = { nativeWei: stated, learnedAt: now };
    const exclusion = this.exclude(walletId, now, stated ?? this.wallets.get(walletId)?.excluded?.requiredNativeWei);
    this.walletRecord(walletId).reading = undefined;
    this.read(walletId, (balances) => { exclusion.balancesAtRefusal ??= balances; });
  }

  /** The wallet's job ended: what it spent makes its last reading stale. */
  recordSpend(walletId: string): void {
    this.walletRecord(walletId).spentAt = this.options.now();
  }

  private exclude(
    walletId: string,
    now: number,
    requiredNativeWei: bigint | undefined,
    balancesAtRefusal?: AsyncLiftWalletBalances,
  ): WalletExclusion {
    const wallet = this.walletRecord(walletId);
    const prior = wallet.excluded;
    const cooldownMs = prior ? Math.min(WALLET_FUNDING_COOLDOWN_MAX_MS, prior.cooldownMs * 2) : WALLET_FUNDING_COOLDOWN_BASE_MS;
    wallet.excluded = {
      since: prior?.since ?? now,
      cooldownMs,
      until: now + cooldownMs,
      ...(requiredNativeWei !== undefined ? { requiredNativeWei } : {}),
      ...(balancesAtRefusal ? { balancesAtRefusal } : {}),
    };
    return wallet.excluded;
  }

  /** Start one reading for this wallet unless one is pending; the claim waits for it (`false`). */
  private read(walletId: string, then?: (balances: AsyncLiftWalletBalances) => void): false {
    const reader = this.options.readBalances;
    const wallet = this.walletRecord(walletId);
    if (!reader || wallet.pendingRead) return false;
    const at = this.options.now();
    wallet.pendingRead = boundedRead(reader, walletId)
      .then((balances) => {
        wallet.reading = { balances, at };
        then?.(balances);
      })
      .finally(() => {
        wallet.pendingRead = undefined;
        try { this.options.onReading(walletId); } catch { /* Scheduling cannot change the reading. */ }
      });
    return false;
  }

  private walletRecord(walletId: string): WalletFundingRecord {
    let wallet = this.wallets.get(walletId);
    if (!wallet) {
      wallet = {};
      this.wallets.set(walletId, wallet);
    }
    return wallet;
  }
}

/** An unreadable balance does not keep a wallet out: the chain still refuses what it cannot pay. */
function covers(nativeWei: bigint | null, requiredWei: bigint): boolean {
  return nativeWei === null || nativeWei >= requiredWei;
}

function replenished(excluded: WalletExclusion, balances: AsyncLiftWalletBalances): boolean {
  if (excluded.requiredNativeWei !== undefined) return covers(balances.native, excluded.requiredNativeWei);
  const before = excluded.balancesAtRefusal;
  // Nothing to compare with: the cooldown alone paces the next attempt.
  if (!before || (before.native === null && before.trac === null)) return true;
  return grew(before.native, balances.native) || grew(before.trac, balances.trac);
}

function grew(before: bigint | null, after: bigint | null): boolean {
  return before !== null && after !== null && after > before;
}

async function boundedRead(reader: AsyncLiftWalletBalanceReader, walletId: string): Promise<AsyncLiftWalletBalances> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => reader(walletId)).catch(() => UNREADABLE),
      new Promise<AsyncLiftWalletBalances>((resolve) => {
        timer = setTimeout(() => resolve(UNREADABLE), WALLET_FUNDING_READ_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The cost the node stated for a transaction it refused for funds, from its own text: go-ethereum
 * and Erigon say `have X want Y`, newer go-ethereum `balance X, tx cost Y`. The error is read with
 * its cause chain, since adapters wrap the provider's error. `undefined` when no cost is stated.
 */
export function refusedTransactionCostWei(error: unknown): bigint | undefined {
  let current = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    const text = errorText(current);
    const match = /\bhave (\d+) want (\d+)/i.exec(text) ?? /\bbalance (\d+), tx cost (\d+)/i.exec(text);
    if (match) {
      const cost = BigInt(match[2]!);
      if (cost > 0n) return cost;
    }
    current = errorCause(current);
  }
  return undefined;
}

function errorText(error: unknown): string {
  try {
    return typeof error === 'string' ? error : String((error as { message?: unknown }).message ?? '');
  } catch {
    return '';
  }
}

function errorCause(error: unknown): unknown {
  try {
    return typeof error === 'object' ? (error as { cause?: unknown }).cause : undefined;
  } catch {
    return undefined;
  }
}
