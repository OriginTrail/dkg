// Subscription payment verification — the SAFE-HEAD discipline extracted
// from the retired deposit rail (the verification logic was never
// refund-shaped; the rail around it was). A period payment is credited only
// after CONFIRMATION_DEPTH confirmations observed at the node's SAFE head —
// never on a receipt alone, never on a mempool sighting. Deposit identity
// = chain:token:tx:log (Bo's rule: two logs in one tx must not collapse).

export interface ObservedTransfer {
  txHash: string;
  from: string;
  to: string;
  token: string;
  amountTrac: string;        // decimal string as read from the chain
  blockNumber: number;
  safeHeadBlock: number;     // the node's observed SAFE head, not latest
  chainId: number;
  logIndex: number;
}

export interface PaymentTerms {
  sellerRevenueWallet: string;   // the DEDICATED subscription wallet — never ops
  tracContract: string;
  buyer: string;
  confirmationDepth: number;
  minimumMicroTrac: number;
}

export type PaymentVerdict =
  | { ok: true; paidMicroTrac: number; identity: string }
  | { ok: false; code: "E_PAYMENT_UNCONFIRMED" | "E_PAYMENT_BELOW_MINIMUM" | "E_PAYMENT_WRONG_RECIPIENT" | "E_PAYMENT_WRONG_TOKEN" | "E_PAYMENT_WRONG_SENDER"; detail?: string };

const toMicro = (trac: string): number => {
  const [i, f = ""] = String(trac).split(".");
  return Number(i) * 1_000_000 + Number((f + "000000").slice(0, 6));
};

export const paymentIdentity = (t: ObservedTransfer): string =>
  `${t.chainId}:${t.token.toLowerCase()}:${t.txHash.toLowerCase()}:${t.logIndex}`;

/** Pure and total: every rejection is a stable code; nothing credits on a
 *  maybe. The buyer's wallet IS the plan identity — a stranger cannot fund
 *  someone else's plan. */
export function evaluatePayment(t: ObservedTransfer, terms: PaymentTerms): PaymentVerdict {
  if (t.to.toLowerCase() !== terms.sellerRevenueWallet.toLowerCase()) return { ok: false, code: "E_PAYMENT_WRONG_RECIPIENT" };
  if (t.token.toLowerCase() !== terms.tracContract.toLowerCase()) return { ok: false, code: "E_PAYMENT_WRONG_TOKEN" };
  if (t.from.toLowerCase() !== terms.buyer.toLowerCase()) return { ok: false, code: "E_PAYMENT_WRONG_SENDER" };
  const confirmations = t.safeHeadBlock - t.blockNumber + 1;
  if (confirmations < terms.confirmationDepth) {
    return { ok: false, code: "E_PAYMENT_UNCONFIRMED", detail: `${Math.max(0, confirmations)}/${terms.confirmationDepth} at safe head` };
  }
  const micro = toMicro(t.amountTrac);
  if (micro < terms.minimumMicroTrac) return { ok: false, code: "E_PAYMENT_BELOW_MINIMUM" };
  return { ok: true, paidMicroTrac: micro, identity: paymentIdentity(t) };
}
