// daemon/payment.ts
//
// x402-style payment seam for paid dRAG answers (OT-RFC-55 §5.4).
//
// V1 ships the WIRE FORMAT (HTTP 402 challenge + `X-PAYMENT` header) and a
// pluggable {@link PaymentVerifier} with a {@link MockPaymentVerifier}
// (accept-any, for dev/CI). The real Coinbase/USDC facilitator drops in behind
// the SAME interface — the route does not change. Public CGs are FREE in V1;
// real per-CG / market pricing and the live facilitator are deferred (see the
// PR notes). This module is self-contained and pure (no settlement side
// effects beyond what a verifier implements), so the payment gate can be
// unit-tested without a chain or a facilitator.
//
// Wire shapes mirror x402: the 402 body carries `{ x402Version, error, accepts:
// [PaymentRequirements] }`; the client retries with `X-PAYMENT: base64(JSON
// PaymentPayload)`; on success the response carries a settlement receipt.

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

/**
 * Dev/CI verifier: accepts any payment that MATCHES the challenge (network,
 * asset, payTo, and amount ≥ required). Performs NO on-chain settlement — it
 * returns a synthetic receipt so the 402 → pay → 200 flow is exercisable end to
 * end without a facilitator or funded wallet. Mirrors the `MockChainAdapter`
 * idiom used elsewhere in the codebase.
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
    if (payload.network !== required.network) return fail('network mismatch');
    if (payload.asset !== required.asset) return fail('asset mismatch');
    if (payload.payTo.toLowerCase() !== required.payTo.toLowerCase()) return fail('payTo mismatch');
    if (!amountGte(payload.amount, required.amount)) return fail('insufficient amount');
    return { ok: true, ...base, txRef: `mock-settle-${required.nonce}` };
  }
}

/** Compare decimal-string amounts. Returns `a >= b`. */
export function amountGte(a: string, b: string): boolean {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return x >= y;
}

/** Parse a `"<amount> <asset>"` price string (e.g. `"0.01 USDC"`). Null if invalid. */
export function parsePrice(price: string): { amount: string; asset: string } | null {
  const m = price.trim().match(/^([0-9]+(?:\.[0-9]+)?)\s+([A-Za-z][A-Za-z0-9]*)$/);
  if (!m) return null;
  if (Number(m[1]) <= 0) return null;
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
    typeof p.scheme !== 'string' ||
    typeof p.network !== 'string' ||
    typeof p.asset !== 'string' ||
    typeof p.amount !== 'string' ||
    typeof p.payTo !== 'string'
  ) {
    return null;
  }
  return {
    x402Version: typeof p.x402Version === 'number' ? p.x402Version : X402_VERSION,
    scheme: p.scheme,
    network: p.network,
    asset: p.asset,
    amount: p.amount,
    payTo: p.payTo,
    nonce: typeof p.nonce === 'string' ? p.nonce : '',
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
 * verify it. Pure given its inputs + the injected verifier — no global state.
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
  nonce: string;
  xPaymentHeader: string | string[] | undefined;
  verifier: PaymentVerifier;
}): Promise<
  | { kind: 'free' }
  | { kind: 'challenge'; required: PaymentRequirements; reason?: string }
  | { kind: 'paid'; receipt: SettlementReceipt }
> {
  if (!opts.price) return { kind: 'free' };
  const required: PaymentRequirements = {
    scheme: 'exact',
    network: opts.network,
    asset: opts.price.asset,
    amount: opts.price.amount,
    payTo: opts.payTo,
    resource: opts.resource,
    nonce: opts.nonce,
    description: 'dRAG verifiable answer',
  };
  const payment = parseXPaymentHeader(opts.xPaymentHeader);
  if (!payment) return { kind: 'challenge', required };
  // Verify against the challenge but honour the payer's echoed nonce.
  const receipt = await opts.verifier.verify(payment, { ...required, nonce: payment.nonce || required.nonce });
  if (!receipt.ok) return { kind: 'challenge', required, reason: receipt.reason };
  return { kind: 'paid', receipt };
}
