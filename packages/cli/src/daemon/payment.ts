// daemon/payment.ts
//
// x402-style payment seam for paid dRAG answers (OT-RFC-55 §5.4).
//
// V1 ships the WIRE FORMAT (HTTP 402 challenge + `X-PAYMENT` header) and a
// pluggable {@link PaymentVerifier} with a {@link MockPaymentVerifier}
// (challenge-matching only, for dev/CI). The real Coinbase/USDC facilitator
// drops in behind the SAME interface — the route does not change. Public CGs
// are FREE in V1; real per-CG / market pricing and the live facilitator are
// deferred (see the PR notes). This module has no settlement side effects
// beyond what a verifier implements; its only process state is an explicitly
// injected, bounded challenge store.
//
// Wire shapes mirror x402: the 402 body carries `{ x402Version, error, accepts:
// [PaymentRequirements] }`; the client retries with `X-PAYMENT: base64(JSON
// PaymentPayload)`; on success the response carries a settlement receipt.

import { randomUUID } from 'node:crypto';

export const X402_VERSION = 1;

/** What the server asks the client to pay (one entry in the 402 `accepts` array). */
export interface PaymentRequirements {
  scheme: 'exact';
  /** Settlement network, e.g. `base-sepolia` / `base`. */
  network: string;
  /** Token symbol or contract address, e.g. `USDC`. */
  asset: string;
  /** Required amount, human units in V1 (e.g. `"0.01"`). */
  amount: string;
  /** Receiving address. */
  payTo: string;
  /** The priced resource (request path). */
  resource: string;
  /** Per-challenge nonce echoed by the payer. */
  nonce: string;
  description?: string;
}

/** The signed payment the client returns in `X-PAYMENT`. */
export interface PaymentPayload {
  x402Version: number;
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  nonce: string;
  /** Payer address. */
  from?: string;
  /** Opaque signed authorization (EIP-3009 / Permit2 in real x402); ignored by the mock. */
  authorization?: string;
}

/** The verifier's verdict; attached to a paid answer as `settlement`. */
export interface SettlementReceipt {
  ok: boolean;
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  from?: string;
  /** Settlement reference (a real tx hash, or a synthetic id for the mock). */
  txRef?: string;
  /** Present when `ok === false`. */
  reason?: string;
}

/** The settlement boundary. Swap {@link MockPaymentVerifier} for a real facilitator. */
export interface PaymentVerifier {
  verify(payload: PaymentPayload, required: PaymentRequirements): Promise<SettlementReceipt>;
}

/** Process-owned storage for short-lived, single-use payment challenges. */
export interface PaymentChallengeStore {
  /** Issue and remember a challenge, adding a server-generated nonce. */
  issue(required: Omit<PaymentRequirements, 'nonce'>): PaymentRequirements;
  /** Atomically remove and return an unexpired challenge. */
  take(nonce: string): PaymentRequirements | null;
}

export interface InMemoryPaymentChallengeStoreOptions {
  /** How long a challenge may be retried. Defaults to five minutes. */
  ttlMs?: number;
  /** Hard memory bound. Oldest challenges are evicted first. Defaults to 10,000. */
  maxEntries?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Injectable nonce source for deterministic tests. Must return unique, non-empty values. */
  nonce?: () => string;
}

interface StoredPaymentChallenge {
  required: PaymentRequirements;
  expiresAt: number;
}

const DEFAULT_CHALLENGE_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_CHALLENGES = 10_000;

/**
 * Bounded TTL challenge storage for a daemon process.
 *
 * `take` deletes synchronously before returning, so only one concurrent retry
 * can reach an asynchronous verifier with a given nonce.
 */
export class InMemoryPaymentChallengeStore implements PaymentChallengeStore {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly nonce: () => string;
  private readonly entries = new Map<string, StoredPaymentChallenge>();

  constructor(opts: InMemoryPaymentChallengeStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_CHALLENGE_TTL_MS;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_CHALLENGES;
    this.now = opts.now ?? (() => Date.now());
    this.nonce = opts.nonce ?? (() => randomUUID());
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs <= 0) {
      throw new RangeError('payment challenge ttlMs must be a positive safe integer');
    }
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries <= 0) {
      throw new RangeError('payment challenge maxEntries must be a positive safe integer');
    }
  }

  issue(required: Omit<PaymentRequirements, 'nonce'>): PaymentRequirements {
    const now = this.now();
    this.pruneExpired(now);

    // A UUID collision is vanishingly unlikely, but an injected nonce source
    // must not be able to overwrite a still-valid challenge.
    let challengeNonce = '';
    for (let attempt = 0; attempt < 8; attempt++) {
      challengeNonce = this.nonce();
      if (challengeNonce && !this.entries.has(challengeNonce)) break;
      challengeNonce = '';
    }
    if (!challengeNonce) throw new Error('unable to allocate a unique payment challenge nonce');

    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }

    const issued = { ...required, nonce: challengeNonce };
    this.entries.set(challengeNonce, {
      required: issued,
      expiresAt: now + this.ttlMs,
    });
    return { ...issued };
  }

  take(nonce: string): PaymentRequirements | null {
    if (!nonce) return null;
    const now = this.now();
    const stored = this.entries.get(nonce);
    if (!stored) {
      this.pruneExpired(now);
      return null;
    }

    // Delete before checking expiry or doing any caller-side async work. This
    // is the atomic one-use transition in the daemon's JS execution context.
    this.entries.delete(nonce);
    if (stored.expiresAt <= now) return null;
    return { ...stored.required };
  }

  private pruneExpired(now: number): void {
    for (const [nonce, stored] of this.entries) {
      if (stored.expiresAt <= now) this.entries.delete(nonce);
    }
  }
}

/**
 * Dev/CI verifier: accepts any payment that MATCHES the challenge (scheme,
 * network, asset, payTo, nonce, and amount ≥ required). Performs NO on-chain
 * settlement — it returns a synthetic receipt so the 402 → pay → 200 flow is
 * exercisable end to end without a facilitator or funded wallet. Mirrors the
 * `MockChainAdapter` idiom used elsewhere in the codebase.
 */
export class MockPaymentVerifier implements PaymentVerifier {
  async verify(payload: PaymentPayload, required: PaymentRequirements): Promise<SettlementReceipt> {
    const base = {
      scheme: required.scheme,
      network: required.network,
      asset: required.asset,
      amount: required.amount,
      payTo: required.payTo,
      from: payload.from,
    };
    const fail = (reason: string): SettlementReceipt => ({ ok: false, ...base, reason });
    if (payload.x402Version !== X402_VERSION) return fail('x402 version mismatch');
    if (payload.scheme !== required.scheme) return fail('scheme mismatch');
    if (payload.network !== required.network) return fail('network mismatch');
    if (payload.asset !== required.asset) return fail('asset mismatch');
    if (payload.payTo.toLowerCase() !== required.payTo.toLowerCase()) return fail('payTo mismatch');
    if (payload.nonce !== required.nonce) return fail('nonce mismatch');
    if (!amountGte(payload.amount, required.amount)) return fail('insufficient amount');
    return { ok: true, ...base, txRef: `mock-settle-${required.nonce}` };
  }
}

/** Compare decimal-string amounts. Returns `a >= b`. */
export function amountGte(a: string, b: string): boolean {
  const comparison = compareDecimalAmounts(a, b);
  return comparison !== null && comparison >= 0;
}

interface DecimalAmount {
  whole: string;
  fraction: string;
}

/** Parse a non-negative, plain decimal without ever converting it to a JS number. */
function parseDecimalAmount(value: string): DecimalAmount | null {
  const match = value.match(/^([0-9]+)(?:\.([0-9]+))?$/);
  if (!match) return null;
  return {
    whole: match[1].replace(/^0+(?=\d)/, ''),
    fraction: (match[2] ?? '').replace(/0+$/, ''),
  };
}

/** Exact arbitrary-precision decimal comparison. Null means either input is invalid. */
function compareDecimalAmounts(a: string, b: string): -1 | 0 | 1 | null {
  const x = parseDecimalAmount(a);
  const y = parseDecimalAmount(b);
  if (!x || !y) return null;
  if (x.whole.length !== y.whole.length) return x.whole.length > y.whole.length ? 1 : -1;
  if (x.whole !== y.whole) return x.whole > y.whole ? 1 : -1;
  const fractionLength = Math.max(x.fraction.length, y.fraction.length);
  const xFraction = x.fraction.padEnd(fractionLength, '0');
  const yFraction = y.fraction.padEnd(fractionLength, '0');
  if (xFraction === yFraction) return 0;
  return xFraction > yFraction ? 1 : -1;
}

/** Parse a `"<amount> <asset>"` price string (e.g. `"0.01 USDC"`). Null if invalid. */
export function parsePrice(price: string): { amount: string; asset: string } | null {
  const m = price.trim().match(/^([0-9]+(?:\.[0-9]+)?)\s+([A-Za-z][A-Za-z0-9]*)$/);
  if (!m) return null;
  if (compareDecimalAmounts(m[1], '0') !== 1) return null;
  return { amount: m[1], asset: m[2].toUpperCase() };
}

/** Build the 402 response body (x402 `accepts` envelope). */
export function build402Body(required: PaymentRequirements): {
  x402Version: number;
  error: string;
  accepts: PaymentRequirements[];
} {
  return { x402Version: X402_VERSION, error: 'payment required', accepts: [required] };
}

/** Decode an `X-PAYMENT: base64(JSON)` header into a {@link PaymentPayload}. Null if absent/invalid. */
export function parseXPaymentHeader(header: string | string[] | undefined): PaymentPayload | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw || typeof raw !== 'string') return null;
  let json: string;
  try {
    json = Buffer.from(raw, 'base64').toString('utf8');
  } catch {
    return null;
  }
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const p = obj as Record<string, unknown>;
  if (
    typeof p.x402Version !== 'number' ||
    !Number.isSafeInteger(p.x402Version) ||
    typeof p.scheme !== 'string' ||
    typeof p.network !== 'string' ||
    typeof p.asset !== 'string' ||
    typeof p.amount !== 'string' ||
    typeof p.payTo !== 'string' ||
    typeof p.nonce !== 'string' ||
    !p.nonce
  ) {
    return null;
  }
  return {
    x402Version: p.x402Version,
    scheme: p.scheme,
    network: p.network,
    asset: p.asset,
    amount: p.amount,
    payTo: p.payTo,
    nonce: p.nonce,
    from: typeof p.from === 'string' ? p.from : undefined,
    authorization: typeof p.authorization === 'string' ? p.authorization : undefined,
  };
}

/** Encode a {@link PaymentPayload} as an `X-PAYMENT` header value (clients/tests). */
export function encodeXPaymentHeader(payload: PaymentPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

/**
 * Decide whether a dRAG answer request must pay, and (if a payment is present)
 * verify it. Challenge state is explicit and process-owned; callers should
 * create one {@link InMemoryPaymentChallengeStore} and reuse it across requests.
 *
 * Returns:
 *  - `{ kind: 'free' }`            — no price configured; serve for free.
 *  - `{ kind: 'challenge', ... }`  — priced, no/invalid payment → caller emits 402.
 *  - `{ kind: 'paid', receipt }`   — payment verified → caller serves + attaches receipt.
 */
export async function resolvePayment(opts: {
  price?: { amount: string; asset: string };
  network: string;
  payTo: string;
  resource: string;
  xPaymentHeader: string | string[] | undefined;
  verifier: PaymentVerifier;
  challengeStore: PaymentChallengeStore;
}): Promise<
  | { kind: 'free' }
  | { kind: 'challenge'; required: PaymentRequirements; reason?: string }
  | { kind: 'paid'; receipt: SettlementReceipt }
> {
  if (!opts.price) return { kind: 'free' };
  const currentRequirement: Omit<PaymentRequirements, 'nonce'> = {
    scheme: 'exact',
    network: opts.network,
    asset: opts.price.asset,
    amount: opts.price.amount,
    payTo: opts.payTo,
    resource: opts.resource,
    description: 'dRAG verifiable answer',
  };
  const challenge = (reason?: string): { kind: 'challenge'; required: PaymentRequirements; reason?: string } => ({
    kind: 'challenge',
    required: opts.challengeStore.issue(currentRequirement),
    ...(reason ? { reason } : {}),
  });

  const payment = parseXPaymentHeader(opts.xPaymentHeader);
  if (!payment) return challenge();

  // `take` is synchronous and destructive: concurrent retries cannot both
  // reach the asynchronous verifier with the same issued challenge.
  const issued = opts.challengeStore.take(payment.nonce);
  if (!issued) return challenge('payment challenge is unknown, expired, or already used');
  if (issued.nonce !== payment.nonce) return challenge('payment nonce does not match the issued challenge');
  if (!requirementsMatch(issued, currentRequirement)) {
    return challenge('payment challenge does not match this request');
  }

  const receipt = await opts.verifier.verify(payment, issued);
  if (!receipt.ok) return challenge(receipt.reason);
  return { kind: 'paid', receipt };
}

function requirementsMatch(
  issued: PaymentRequirements,
  current: Omit<PaymentRequirements, 'nonce'>,
): boolean {
  return (
    issued.scheme === current.scheme &&
    issued.network === current.network &&
    issued.asset === current.asset &&
    compareDecimalAmounts(issued.amount, current.amount) === 0 &&
    issued.payTo.toLowerCase() === current.payTo.toLowerCase() &&
    issued.resource === current.resource
  );
}
