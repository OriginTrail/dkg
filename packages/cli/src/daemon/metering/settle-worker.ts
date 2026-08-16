// P2 — the ONLY sanctioned driver for provider-elected NETTED settlement.
//
// Hermes wiring v4 HOLD #2: "the settlement scripts WILL call
// recordNettedSettlement" is operational discipline, not a structural
// guarantee — a loopback worker could still bypass the economics binding even
// though HTTP cannot. This module is the structural answer:
//
//   * Settlement scripts invoke THIS worker; they carry evidence, not policy.
//   * The settle-gate verdict and the execution bind through ONE value:
//     `nettedSettleVerdict` returns the digest of the exact config bytes the
//     verdict used, and `runNettedSettlement` REQUIRES that digest — the
//     mutation (recordNettedSettlement) re-reads the bytes immediately before
//     its first state change and refuses on any drift. Propagation is by
//     construction: there is no worker path that re-derives or samples.
//   * This module never touches settleTab. The settle-worker gate suite scans
//     the whole built tree: settleTab is referenceable ONLY from its
//     declaration (ledger.js), the netting core (netting.js: zero-value carry
//     terminalization + the digest-bound recordNettedSettlement), and the
//     Iteration-1 buyer-close-driven withdrawal path (settlement.js —
//     confirmWithdrawal, whose amount is bound to the two-sided signed close
//     statement, a DIFFERENT lifecycle than provider-elected netting: no
//     economics verdict exists in that flow to bind). Everything else —
//     including this worker — is refused by the scan.
//
// SCOPE: bookkeeping only. Nothing here signs, broadcasts, or moves funds;
// callers record evidence of a payout the operator already executed.
import { readJournal } from "./ledger.js";
import { recordNettedSettlement, recordEarnedRelease, providerMaySettle } from "./netting.js";
import { loadNettingEconomics } from "./netting-http-core.js";

/** The provider-election verdict + the ONE digest execution must present.
 *  Fails closed without recorded economics — a worker cannot invent inputs. */
export function nettedSettleVerdict(home: string, principal: string):
  | { ok: true; gate: ReturnType<typeof providerMaySettle>; expectedConfigDigest: string }
  | { ok: false; code: string } {
  const econ = loadNettingEconomics(home);
  if (!econ) return { ok: false, code: "E_NO_RECORDED_ECONOMICS" };
  const gate = providerMaySettle(home, principal, econ.feeGweiDecimal, econ.ethTracDecimal);
  return { ok: true, gate, expectedConfigDigest: econ.configDigest };
}

/** Record a netted payout the operator has broadcast + confirmed: the bound
 *  settlement first, then (optionally) each named close's earned release
 *  against the SAME payout evidence — so the settled record and every release
 *  record provably carry the same authorizing digest. */
export function runNettedSettlement(home: string, args: {
  principal: string;
  withdrawalId: string;
  txHash: string;
  netPaidMicroTrac: number;
  expectedEpoch?: number;
  closes: string[];
  /** REQUIRED: the verdict's configDigest from nettedSettleVerdict — never re-derived here. */
  expectedConfigDigest: string;
  /** REQUIRED: the structural release authority (metering/release-authority.token). */
  authorityToken: string;
  /** Also release each close's earned amount against this payout. */
  releaseEarned?: boolean;
}): {
  ok: boolean; code?: string; alreadySettled?: boolean; economicsConfigDigest?: string;
  released?: Array<{ closeDigest: string; ok: boolean; code?: string }>;
  /** true only when the settlement is recorded AND every named close's earned
   *  is released (or was zero). Partial state is EXPLICIT and replay-safe:
   *  re-running the same record is the documented recovery — the settlement
   *  short-circuits as alreadySettled and only the pending releases execute
   *  (release dedup makes double-release impossible). */
  complete?: boolean;
  pendingReleases?: string[];
  election?: { allowed: boolean; unsettledEarned: number; thresholdMicroTrac: number };
  conflict?: string[];
} {
  // Belt to the type system's braces: a JS caller skipping the required fields
  // must still fail closed BEFORE any mutation is attempted.
  if (typeof args.expectedConfigDigest !== "string" || !args.expectedConfigDigest.startsWith("sha256:")) {
    return { ok: false, code: "E_WORKER_DIGEST_REQUIRED" };
  }
  if (typeof args.authorityToken !== "string" || args.authorityToken.length === 0) {
    return { ok: false, code: "E_WORKER_AUTHORITY_REQUIRED" };
  }
  const st = recordNettedSettlement(home, {
    principal: args.principal, withdrawalId: args.withdrawalId, txHash: args.txHash,
    netPaidMicroTrac: args.netPaidMicroTrac, expectedEpoch: args.expectedEpoch,
    closes: args.closes, expectedConfigDigest: args.expectedConfigDigest,
    authorityToken: args.authorityToken,
  });
  if (!st.ok) return { ok: false, code: st.code, ...(st.election ? { election: st.election } : {}), ...(st.conflict ? { conflict: st.conflict } : {}) };
  const released: Array<{ closeDigest: string; ok: boolean; code?: string }> = [];
  if (args.releaseEarned) {
    for (const closeDigest of args.closes) {
      const close = readJournal(home).find((r) => r.kind === "nsm-close" && String(r.closeDigest) === closeDigest);
      const earned = Number((close as Record<string, unknown> | undefined)?.earnedMicroTrac ?? NaN);
      if (!Number.isSafeInteger(earned) || earned < 0) { released.push({ closeDigest, ok: false, code: "E_CLOSE_NOT_FOUND" }); continue; }
      if (earned === 0) { released.push({ closeDigest, ok: true }); continue; }
      // amount comes from the CLOSE record, never a caller figure (P2 v6), and
      // the release inherits the payout's digest inside recordEarnedRelease.
      // An already-recorded release is COMPLETION, not failure (replay path).
      const r = recordEarnedRelease(home, args.principal, closeDigest, earned, args.txHash, args.authorityToken);
      const done = r.ok || r.code === "E_RELEASE_ALREADY_RECORDED";
      released.push({ closeDigest, ok: done, ...(!done && r.code ? { code: r.code } : {}) });
    }
  }
  // EXPLICIT completion contract (Hermes wiring v4.2 atomicity point): the
  // caller always learns whether liability is fully closed. Pending set is
  // derived from the JOURNAL, not the loop results — restart-faithful.
  const post = readJournal(home);
  const pendingReleases = args.closes.filter((cd) => {
    const close = post.find((r) => r.kind === "nsm-close" && String(r.closeDigest) === cd);
    const earned = Number((close as Record<string, unknown> | undefined)?.earnedMicroTrac ?? 0);
    if (!(earned > 0)) return false;
    return !post.some((r) => r.kind === "nsm-earned-released" && String(r.closeDigest) === cd);
  });
  return {
    ok: true, alreadySettled: st.alreadySettled, economicsConfigDigest: st.economicsConfigDigest,
    released, complete: pendingReleases.length === 0, pendingReleases,
  };
}
