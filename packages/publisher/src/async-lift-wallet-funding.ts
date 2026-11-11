/**
 * #3591 — can a publisher wallet pay for its next publication? The claim asks this, so a job is
 * never claimed by a wallet the chain has just refused for funds while another wallet could pay.
 *
 * The answer rests on evidence about each wallet, never on a guess. Until the chain refuses a
 * wallet's publication for funds, the wallet claims freely and nothing is read. A definitive
 * refusal (the node turned the transaction away before the mempool, or the adapter found no funded
 * wallet before signing) keeps that wallet, and only that wallet, out of claims for a cooldown that
 * doubles while it stays short (30 s to 10 min). After each cooldown a fresh balance reading
 * decides: the wallet is back once it covers the cost the node stated for the refused transaction
 * (`have X want Y`, `balance X, tx cost Y`), or, when the node stated none, once its native
 * balance, its TRAC balance or the coverage of its Publishing Conviction Account grew since the
 * refusal (a top-up, a registered or funded account, a new epoch's allowance). The balances at the
 * refusal are the ones the refusal carries, when it does: a reading after it can already hold a
 * top-up. A reading right after the refusal fills in the rest, so a top-up that lands before that
 * reading goes unseen for what the refusal did not carry, until the attempt after an hour.
 *
 * A stated cost is the cost of one transaction, so it never applies to other wallets: costs vary
 * with the operation, the payload and the gas price, and another wallet may pay for a cheaper job.
 * A refused wallet with no top-up gets one more attempt after an hour, because a stated cost also
 * goes stale when the gas price falls. Gas and balances can still change between the claim and
 * the send; the refusal that follows is again definitive, so the job is retried rather than lost
 * (`insufficient_funds` is in the automatic retry lane).
 *
 * Readings happen only for a refused wallet: right after the refusal, and when its cooldown is over
 * and it has a candidate job. They never run under the claim lock: the claim gets `false` while a
 * reading is pending, and the reading's end pokes the wallet's loop. A reading that fails or does
 * not answer in time counts as unreadable, and an unreadable balance never keeps a wallet out.
 *
 * State is in memory. After a restart a wallet that is still short is refused once more before
 * it is kept out again; the refused job itself keeps its retry schedule in the store.
 */

/** One wallet's balances in wei; `null` where the read failed. */
export interface AsyncLiftWalletBalances {
  readonly native: bigint | null;
  readonly trac: bigint | null;
  /**
   * TRAC the wallet's Publishing Conviction Account can still cover this epoch: `0n` when the
   * wallet is no agent or the account expired; `null` or absent where it is unknown.
   */
  readonly pca?: bigint | null;
}

/** Reads a publisher wallet's current balances from the chain. */
export type AsyncLiftWalletBalanceReader = (walletId: string) => Promise<AsyncLiftWalletBalances>;

export const WALLET_FUNDING_COOLDOWN_BASE_MS = 30_000;
export const WALLET_FUNDING_COOLDOWN_MAX_MS = 10 * 60_000;
/** How long a refused wallet stays out without a top-up before it gets one more attempt. */
export const WALLET_FUNDING_EVIDENCE_TTL_MS = 60 * 60_000;
/** A balance read that has not answered by then counts as unreadable. */
export const WALLET_FUNDING_READ_TIMEOUT_MS = 15_000;

const UNREADABLE: AsyncLiftWalletBalances = { native: null, trac: null };

interface WalletExclusion {
  readonly since: number;
  cooldownMs: number;
  /** No claim and no new reading before this. */
  until: number;
  /** The cost the node stated for the refused transaction. */
  readonly requiredNativeWei?: bigint;
  /** Carried by the refusal or read right after it: a later reading above it shows a top-up. */
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
}

export class AsyncLiftWalletFunding {
  private readonly wallets = new Map<string, WalletFundingRecord>();

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
    if (!wallet || !excluded) return true;
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
    return true;
  }

  /** The chain refused this wallet's publication for funds, definitively. */
  recordRefusal(walletId: string, error: unknown): void {
    const now = this.options.now();
    const wallet = this.walletRecord(walletId);
    const prior = wallet.excluded;
    const cooldownMs = prior ? Math.min(WALLET_FUNDING_COOLDOWN_MAX_MS, prior.cooldownMs * 2) : WALLET_FUNDING_COOLDOWN_BASE_MS;
    const requiredNativeWei = refusedTransactionCostWei(error) ?? prior?.requiredNativeWei;
    const carried = balancesCarriedByRefusal(error, walletId);
    const exclusion: WalletExclusion = {
      since: prior?.since ?? now,
      cooldownMs,
      until: now + cooldownMs,
      ...(requiredNativeWei !== undefined ? { requiredNativeWei } : {}),
      ...(carried ? { balancesAtRefusal: carried } : {}),
    };
    wallet.excluded = exclusion;
    wallet.reading = undefined;
    this.read(walletId, (balances) => {
      exclusion.balancesAtRefusal = {
        native: carried?.native ?? balances.native,
        trac: carried?.trac ?? balances.trac,
        pca: balances.pca ?? null,
      };
    });
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

/**
 * With no stated cost, a top-up is any metric that is larger now than at the refusal: native gas,
 * TRAC, or Publishing Conviction coverage, which grows when an account is registered for the
 * wallet, funded, or starts a new epoch while both balances stay the same. With nothing read at the
 * refusal, the cooldown alone paces the next attempt.
 */
function replenished(excluded: WalletExclusion, balances: AsyncLiftWalletBalances): boolean {
  if (excluded.requiredNativeWei !== undefined) return covers(balances.native, excluded.requiredNativeWei);
  const before = excluded.balancesAtRefusal;
  if (!before) return true;
  const metrics = [
    [before.native, balances.native],
    [before.trac, balances.trac],
    [before.pca ?? null, balances.pca ?? null],
  ] as const;
  return metrics.every(([then]) => then === null) || metrics.some(([then, now]) => mayHaveGrown(then, now));
}

/**
 * A metric read at only one of the two moments cannot be compared, and may be the top-up: the
 * cooldown-paced attempt goes ahead, because an unreadable balance never keeps a wallet out.
 */
function mayHaveGrown(then: bigint | null, now: bigint | null): boolean {
  return then === null || now === null ? then !== now : now > then;
}

async function boundedRead(reader: AsyncLiftWalletBalanceReader, walletId: string): Promise<AsyncLiftWalletBalances> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      // Only bigints count: a reader's malformed answer must not throw inside the claim lock.
      Promise.resolve().then(() => reader(walletId)).then(
        (balances) => ({ native: weiOrNull(balances?.native), trac: weiOrNull(balances?.trac), pca: weiOrNull(balances?.pca) }),
        () => UNREADABLE,
      ),
      new Promise<AsyncLiftWalletBalances>((resolve) => {
        timer = setTimeout(() => resolve(UNREADABLE), WALLET_FUNDING_READ_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function weiOrNull(value: unknown): bigint | null {
  return typeof value === 'bigint' && value >= 0n ? value : null;
}

/**
 * The cost the node stated for a transaction it refused for funds, from its own text: go-ethereum
 * and Erigon say `have X want Y`, newer go-ethereum `balance X, tx cost Y`. The error is read with
 * its cause chain, since adapters wrap the provider's error. `undefined` when no cost is stated.
 */
export function refusedTransactionCostWei(error: unknown): bigint | undefined {
  for (const current of errorChain(error)) {
    const text = errorText(current);
    const match = /\bhave (\d+) want (\d+)/i.exec(text) ?? /\bbalance (\d+), tx cost (\d+)/i.exec(text);
    if (match) {
      const cost = BigInt(match[2]!);
      if (cost > 0n) return cost;
    }
  }
  return undefined;
}

/**
 * This wallet's entry in the balances a refusal carries: the adapter's no-funded-wallet failure
 * lists what it saw for each wallet when it decided. `undefined` when the refusal carries none.
 */
function balancesCarriedByRefusal(error: unknown, walletId: string): AsyncLiftWalletBalances | undefined {
  const wanted = walletId.toLowerCase();
  for (const current of errorChain(error)) {
    try {
      const entries = (current as { balances?: unknown }).balances;
      if (!Array.isArray(entries)) continue;
      const own = entries.find((entry) => typeof entry?.address === 'string' && entry.address.toLowerCase() === wanted);
      if (own) return { native: weiOrNull(own.nativeWei), trac: weiOrNull(own.tracWei) };
    } catch {
      // A refusal is recorded on the failure path: an unreadable one carries nothing.
    }
  }
  return undefined;
}

function* errorChain(error: unknown): Generator<unknown> {
  let current = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    yield current;
    current = errorCause(current);
  }
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
