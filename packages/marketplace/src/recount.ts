/**
 * Buyer-side recount and local seller standing (re-designed from the fork's
 * `buyer/recount.ts`: no Ed25519 legs, no withhold codes).
 *
 * A receipt that is seller-signed and buyer-authorized settles regardless of
 * the recount — the RFC fixes that consequence. The recount compares the
 * buyer's own count of the committed result bytes against the receipt's
 * `servedUnits` and drives a LOCAL per-seller standing that steers the
 * router: `trusted` → `deprioritized` → `denied` (with a cool-down).
 *
 * A malformed result from an offer advertising `apiShape`/`queryCost` is a
 * `mismatch` (`malformed-result`), never `unverifiable`: otherwise a
 * dishonest seller could dodge every recount by emitting slightly malformed
 * results.
 */
import { CHAT_TEMPLATE_OPENAI_COUNT_V1_DIGEST, meterChat } from './chat-metering.js';
import type { ChatMessage, ChatToolOptions } from './chat-messages.js';
import {
  countResultRows,
  QUERY_COST_SCHEDULE_V1,
  queryAdmissionUnits,
  queryCostScheduleDigest,
  queryDeliveryUnits,
  QueryTooLargeError,
  type QueryCostSchedule,
} from './query-cost.js';
import { parseChatServeResult, parseQueryServeResult } from './serve-wire.js';
import type { TokenCountEngine } from './token-engines.js';
import type { OfferMetering, OfferQueryCost } from './types.js';

export type RecountVerdictKind = 'match' | 'mismatch' | 'unverifiable';

export type RecountReason =
  | 'no-engine'
  | 'provider-reported'
  | 'not-metered'
  | 'tokenizer-drift'
  | 'template-drift'
  | 'schedule-drift'
  | 'malformed-result'
  | 'units-differ'
  | 'metering-block-differs';

export interface RecountVerdict {
  verdict: RecountVerdictKind;
  reason?: RecountReason;
  /** The receipt's servedUnits. */
  servedUnits: bigint;
  recountUnits?: bigint;
}

const verdictOf = (
  verdict: RecountVerdictKind,
  servedUnits: bigint,
  reason?: RecountReason,
  recountUnits?: bigint,
): RecountVerdict => ({
  verdict,
  ...(reason !== undefined ? { reason } : {}),
  servedUnits,
  ...(recountUnits !== undefined ? { recountUnits } : {}),
});

/**
 * Recount one chat delivery. `wireMessages`/`wireOptions` are the exact
 * objects serialized into the payload; `result` is the JSON-parsed,
 * receipt-verified result.
 */
export function recountChat(input: {
  engine: TokenCountEngine | undefined;
  offerMetering: OfferMetering | undefined;
  wireMessages: readonly ChatMessage[];
  wireOptions: ChatToolOptions;
  result: unknown;
  receiptServedUnits: bigint;
}): RecountVerdict {
  const served = input.receiptServedUnits;
  const parsed = parseChatServeResult(input.result);
  if (!parsed.ok) return verdictOf('mismatch', served, 'malformed-result');
  const pin = input.offerMetering;
  if (pin?.basis === 'provider-reported') return verdictOf('unverifiable', served, 'provider-reported');
  if (!pin) return verdictOf('unverifiable', served, 'not-metered');
  const { engine } = input;
  // `openai-chat-count/v1` is the only template the buyer can count with; an
  // offer omitting the template pin means v1.
  const templateDigest = pin.chatTemplate?.digest ?? CHAT_TEMPLATE_OPENAI_COUNT_V1_DIGEST;
  if (
    !engine ||
    engine.kind !== pin.tokenizer.kind ||
    engine.digest !== pin.tokenizer.digest ||
    templateDigest !== CHAT_TEMPLATE_OPENAI_COUNT_V1_DIGEST
  ) {
    return verdictOf('unverifiable', served, 'no-engine');
  }
  const metering = parsed.result.metering;
  if (metering.tokenizer?.kind !== pin.tokenizer.kind || metering.tokenizer.digest !== pin.tokenizer.digest) {
    return verdictOf('mismatch', served, 'tokenizer-drift');
  }
  if (metering.chatTemplate?.digest !== templateDigest) return verdictOf('mismatch', served, 'template-drift');
  if (BigInt(metering.servedUnits) !== served) return verdictOf('mismatch', served, 'metering-block-differs');
  const message = parsed.result.choices[0].message;
  const recount = meterChat(engine, {
    messages: input.wireMessages,
    options: input.wireOptions,
    content: message.content,
    toolCalls: message.tool_calls,
  }).servedUnits;
  return recount === served ? verdictOf('match', served, undefined, recount) : verdictOf('mismatch', served, 'units-differ', recount);
}

/**
 * Recount one query delivery under the pinned schedule (default V1). An
 * offer without a `queryCost` group is a pre-schedule seller: `not-metered`,
 * and the result is not parsed (a legacy `{ result }` is never malformed).
 */
export function recountQuery(input: {
  sparql: string;
  offerQueryCost: OfferQueryCost | undefined;
  result: unknown;
  receiptServedUnits: bigint;
  schedule?: QueryCostSchedule;
}): RecountVerdict {
  const served = input.receiptServedUnits;
  const schedule = input.schedule ?? QUERY_COST_SCHEDULE_V1;
  const pin = input.offerQueryCost;
  if (!pin) return verdictOf('unverifiable', served, 'not-metered');
  if (pin.schedule !== schedule.version || pin.digest !== queryCostScheduleDigest(schedule)) {
    return verdictOf('unverifiable', served, 'schedule-drift');
  }
  const parsed = parseQueryServeResult(input.result);
  if (!parsed.ok) return verdictOf('mismatch', served, 'malformed-result');
  if (BigInt(parsed.result.metering.servedUnits) !== served) return verdictOf('mismatch', served, 'metering-block-differs');
  let admission: bigint;
  try {
    admission = queryAdmissionUnits(input.sparql, schedule);
  } catch (error) {
    // The buyer refuses oversized queries before routing; never reached in practice.
    if (error instanceof QueryTooLargeError) return verdictOf('unverifiable', served, 'not-metered');
    throw error;
  }
  const recount = parsed.result.metering.aborted
    ? admission
    : admission + queryDeliveryUnits(countResultRows(parsed.result.result), schedule);
  return recount === served ? verdictOf('match', served, undefined, recount) : verdictOf('mismatch', served, 'units-differ', recount);
}

// ── local seller standing ──────────────────────────────────────────────────

export type SellerStanding = 'trusted' | 'deprioritized' | 'denied';

export interface RecountPolicy {
  /** How many recent match/mismatch verdicts the standing looks at. */
  window: number;
  /** Mismatches in the window that deprioritize a seller. */
  deprioritizeAt: number;
  /** Mismatches in the window that deny a seller (until the cool-down passes). */
  denyAt: number;
  denyCooldownSeconds: number;
}

export const DEFAULT_RECOUNT_POLICY: RecountPolicy = Object.freeze({
  window: 20,
  deprioritizeAt: 1,
  denyAt: 3,
  denyCooldownSeconds: 86_400,
});

export interface SellerRecountRecord {
  /** Decimal identity id. */
  sellerIdentityId: string;
  recounted: number;
  matches: number;
  mismatches: number;
  unverifiable: number;
  /** Σ max(0, served − recount) over mismatches carrying a recount. */
  overbilledUnits: bigint;
  /** Σ max(0, recount − served) over mismatches carrying a recount. */
  underbilledUnits: bigint;
  /** Last `window` match/mismatch verdicts, oldest first (unverifiable excluded). */
  recent: Array<'match' | 'mismatch'>;
  /** Unix seconds. */
  lastMismatchAt: number | null;
  lastVerdictAt: number | null;
}

export interface SellerStandingBookJson {
  version: 1;
  sellers: Array<Record<string, unknown>>;
}

function resolvePolicy(partial: Partial<RecountPolicy> = {}): RecountPolicy {
  const policy = { ...DEFAULT_RECOUNT_POLICY, ...partial };
  for (const key of ['window', 'deprioritizeAt', 'denyAt'] as const) {
    if (!Number.isSafeInteger(policy[key]) || policy[key] < 1) throw new Error(`recount policy ${key} must be a positive integer`);
  }
  if (!Number.isSafeInteger(policy.denyCooldownSeconds) || policy.denyCooldownSeconds < 0) {
    throw new Error('recount policy denyCooldownSeconds must be a non-negative integer');
  }
  return policy;
}

const DECIMAL = /^(0|[1-9]\d*)$/;

function parseCount(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new Error(`seller standing ${field} must be a non-negative integer`);
  return v;
}

function parseUnits(v: unknown, field: string): bigint {
  if (typeof v !== 'string' || !DECIMAL.test(v)) throw new Error(`seller standing ${field} must be a decimal string`);
  return BigInt(v);
}

function parseTime(v: unknown, field: string): number | null {
  if (v === null) return null;
  return parseCount(v, field);
}

function parseRecord(raw: Record<string, unknown>, window: number): SellerRecountRecord {
  if (typeof raw.sellerIdentityId !== 'string' || !DECIMAL.test(raw.sellerIdentityId)) {
    throw new Error('seller standing sellerIdentityId must be a decimal string');
  }
  if (!Array.isArray(raw.recent) || !raw.recent.every((v) => v === 'match' || v === 'mismatch')) {
    throw new Error('seller standing recent must be an array of match/mismatch');
  }
  return {
    sellerIdentityId: raw.sellerIdentityId,
    recounted: parseCount(raw.recounted, 'recounted'),
    matches: parseCount(raw.matches, 'matches'),
    mismatches: parseCount(raw.mismatches, 'mismatches'),
    unverifiable: parseCount(raw.unverifiable, 'unverifiable'),
    overbilledUnits: parseUnits(raw.overbilledUnits, 'overbilledUnits'),
    underbilledUnits: parseUnits(raw.underbilledUnits, 'underbilledUnits'),
    recent: (raw.recent as Array<'match' | 'mismatch'>).slice(-window),
    lastMismatchAt: parseTime(raw.lastMismatchAt, 'lastMismatchAt'),
    lastVerdictAt: parseTime(raw.lastVerdictAt, 'lastVerdictAt'),
  };
}

function copyRecord(record: SellerRecountRecord): SellerRecountRecord {
  return { ...record, recent: [...record.recent] };
}

/** Per-seller recount history and the pure standing function over it. */
export class SellerStandingBook {
  readonly policy: RecountPolicy;
  readonly #records = new Map<string, SellerRecountRecord>();

  /** Throws on an invalid policy or a malformed persisted book. */
  constructor(policy?: Partial<RecountPolicy>, json?: SellerStandingBookJson) {
    this.policy = resolvePolicy(policy);
    if (json === undefined) return;
    if (typeof json !== 'object' || json === null || json.version !== 1 || !Array.isArray(json.sellers)) {
      throw new Error('seller standing book must be { version: 1, sellers: [...] }');
    }
    for (const raw of json.sellers) {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('seller standing entry must be an object');
      const record = parseRecord(raw, this.policy.window);
      if (this.#records.has(record.sellerIdentityId)) {
        throw new Error(`seller standing lists seller ${record.sellerIdentityId} twice`);
      }
      this.#records.set(record.sellerIdentityId, record);
    }
  }

  #key(sellerIdentityId: bigint): string {
    if (sellerIdentityId < 0n) throw new Error(`sellerIdentityId must be non-negative, got: ${sellerIdentityId}`);
    return sellerIdentityId.toString();
  }

  #standingOf(record: SellerRecountRecord | undefined, nowSeconds: number): SellerStanding {
    if (!record) return 'trusted';
    const mismatches = record.recent.filter((v) => v === 'mismatch').length;
    if (
      mismatches >= this.policy.denyAt &&
      record.lastMismatchAt !== null &&
      nowSeconds - record.lastMismatchAt < this.policy.denyCooldownSeconds
    ) {
      return 'denied';
    }
    return mismatches >= this.policy.deprioritizeAt ? 'deprioritized' : 'trusted';
  }

  /** Record one verdict and return the seller's standing after it. */
  record(sellerIdentityId: bigint, verdict: RecountVerdict, nowSeconds: number): SellerStanding {
    const key = this.#key(sellerIdentityId);
    let record = this.#records.get(key);
    if (!record) {
      record = {
        sellerIdentityId: key,
        recounted: 0,
        matches: 0,
        mismatches: 0,
        unverifiable: 0,
        overbilledUnits: 0n,
        underbilledUnits: 0n,
        recent: [],
        lastMismatchAt: null,
        lastVerdictAt: null,
      };
      this.#records.set(key, record);
    }
    record.recounted += 1;
    record.lastVerdictAt = nowSeconds;
    if (verdict.verdict === 'unverifiable') {
      record.unverifiable += 1;
    } else {
      record.recent.push(verdict.verdict);
      if (record.recent.length > this.policy.window) record.recent.splice(0, record.recent.length - this.policy.window);
      if (verdict.verdict === 'match') {
        record.matches += 1;
      } else {
        record.mismatches += 1;
        record.lastMismatchAt = nowSeconds;
        if (verdict.recountUnits !== undefined) {
          if (verdict.servedUnits > verdict.recountUnits) record.overbilledUnits += verdict.servedUnits - verdict.recountUnits;
          else record.underbilledUnits += verdict.recountUnits - verdict.servedUnits;
        }
      }
    }
    return this.#standingOf(record, nowSeconds);
  }

  standing(sellerIdentityId: bigint, nowSeconds: number): SellerStanding {
    return this.#standingOf(this.#records.get(this.#key(sellerIdentityId)), nowSeconds);
  }

  /** Standing of every known seller, keyed by decimal identity id (unknown sellers are `trusted`). */
  standings(nowSeconds: number): Map<string, SellerStanding> {
    const out = new Map<string, SellerStanding>();
    for (const [key, record] of this.#records) out.set(key, this.#standingOf(record, nowSeconds));
    return out;
  }

  /** Operator override: forget a seller's history. */
  reset(sellerIdentityId: bigint): boolean {
    return this.#records.delete(this.#key(sellerIdentityId));
  }

  snapshot(nowSeconds: number): Array<SellerRecountRecord & { standing: SellerStanding }> {
    return [...this.#records.values()].map((record) => ({
      ...copyRecord(record),
      standing: this.#standingOf(record, nowSeconds),
    }));
  }

  toJSON(): SellerStandingBookJson {
    return {
      version: 1,
      sellers: [...this.#records.values()].map((record) => ({
        sellerIdentityId: record.sellerIdentityId,
        recounted: record.recounted,
        matches: record.matches,
        mismatches: record.mismatches,
        unverifiable: record.unverifiable,
        overbilledUnits: record.overbilledUnits.toString(),
        underbilledUnits: record.underbilledUnits.toString(),
        recent: [...record.recent],
        lastMismatchAt: record.lastMismatchAt,
        lastVerdictAt: record.lastVerdictAt,
      })),
    };
  }
}
