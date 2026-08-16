// PINNED CONTRACT — DO NOT EDIT.
//
// Source of truth: contract-freeze/layer-vectors.mjs (P0 freeze, v1.5,
// double-passed by adversarial review 2026-08-11). The `resolve` and
// `makeRegistry` function bodies below are BYTE-IDENTICAL copies from the
// frozen artifact; only the test harness (which calls `process.exit` and
// cannot run in a browser) is omitted. Per the freeze contract and reviewer
// condition (OpenClaw): the UI CONSUMES this resolver — it never reimplements
// or reinterprets placement. Any semantic change here reopens the P0 gate.
//
// Frozen artifact canonical sha256 (incl. final newline):
//   see contract-freeze/ manifest — v1.5 set declared in-channel (c29fc8b4…).
const E = (code) => ({ refuse: code });
export function resolve(a, vmIndex = new Set()) {
  // vmIndex: the set of digests currently present in VM (stateful input).
  if (a.cg?.metered && a.cg?.onChainId == null) return E('E_UNANCHORED_METERED_CG');
  switch (a.kind) {
    case 'cg-identity': return a.cg?.metered ? { layer: 'VM', via: 'cg-registration+assertion-roots' } : { layer: 'SWM' };
    case 'offering':
      if (a.discoverable) {                                  // fail CLOSED (v1.3, Hermes round 3)
        if (typeof a.quoteDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(a.quoteDigest)) return E('E_OFFERING_QUOTE_DIGEST_REQUIRED');
        if (!vmIndex.has(a.quoteDigest)) return E('E_QUOTE_DIGEST_ABSENT_FROM_VM');
        return { layer: 'VM', via: 'batch' };
      }
      return { layer: 'SWM' };
    case 'quote':    return a.referencedByVmOffering ? { layer: 'VM', via: 'offering-batch' } : { layer: 'SWM' };
    case 'receipt':  return a.dedicatedPublish ? E('E_RECEIPT_DEDICATED_PUBLISH') : { layer: 'SWM', anchoredVia: 'batch-root' };
    case 'close':    return a.feedsPublicReputation ? { layer: 'VM', via: 'batch' } : { layer: 'SWM' };
    case 'trace':    return { layer: 'SWM' };
    case 'transfer': return { layer: 'CHAIN', thresholdGated: true };
    default:         return E('E_UNKNOWN_ARTIFACT_CLASS');
  }
}
// Threshold rule — PINNED from contract-freeze/cost-vectors.mjs (v1.5):
// settlement fires when accumulated earnings ≥ gasCostTRAC(t)/ε, all money math
// integer wei with ceiling (can never understate). Display-only in the UI.
export const GAS_TOTAL = 34_779 + 34_420;      // measured txs 0x66823b33…, 0x24241fa7…
export const EPS_NUM = 1n, EPS_DEN = 1000n;    // ε = 0.1% exactly
export const ceilDiv = (a, b) => (a + b - 1n) / b;
export function thresholdWei(feeWeiPerGas, rateNum, rateDen) {
  const gasCostWeiTrac = ceilDiv(BigInt(GAS_TOTAL) * feeWeiPerGas * rateNum, rateDen);
  return ceilDiv(gasCostWeiTrac * EPS_DEN, EPS_NUM);
}
