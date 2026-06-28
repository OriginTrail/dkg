import { useMemo } from 'react';
import { useFetch } from '../hooks.js';
import { fetchWalletsBalances, fetchPca, fetchContextGraphs, fetchCurrentAgent } from '../api.js';
import { usePcaStore } from '../stores/pca.js';
import { canonicalAgentDid } from '../lib/contextGraphSidebar.js';
import { classifyCoverage } from '../pca/coverage.js';
import type { PcaVerdict } from '../components/Pca/EligibilityVerdictBanner.js';

const eq = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

interface WalletDetail {
  wallet: string;
  covered: boolean;
  accountId?: string;
  discountBps?: number;
  /**
   * #3 — the wallet IS an approved publishing wallet on this account, but the
   * account is swept/expired so it doesn't cover the publish. Lets the chip say
   * "approved on PCA #N, but it's swept/expired" instead of a misleading
   * "no PCA → pays direct cost". Only set when `covered` is false.
   */
  deadAccountId?: string;
  /**
   * C1/#9 — the wallet is uncovered ONLY because a coverage probe FAILED (the
   * fetch rejected), not because it's a confirmed not-registered/dead. Must never
   * be folded into a confirmed fall-through; an all-inconclusive verdict resolves
   * neutral ("unknown"), never DANGER, at spend time. Only set when uncovered.
   */
  inconclusive: boolean;
  /**
   * O4/#9 — the wallet's funding is UNREADABLE: the balances route errored (the
   * daemon returns {balances:[], error} at HTTP 200, so the wb=null guard misses
   * it). gasFunded/hasTrac then read false from UNREAD data — must never drive a
   * no-funds DANGER. On UNCOVERED wallets it's treated like `inconclusive` in the
   * verdict (O4); on COVERED wallets it lets GREEN's gas check fail OPEN (Q2).
   */
  balanceUnknown: boolean;
  gasFunded: boolean;
  hasTrac: boolean;
  sawExpired: boolean;
  sawInsolvent: boolean;
}

export interface PublishEligibility {
  verdict: PcaVerdict;
  loading: boolean;
  /** The covering PCA + its discount, when GREEN. */
  accountId?: string;
  discountBps?: number;
  /** #4 — true only when this node owns the target CG (curator). */
  ownerPublish: boolean;
  /** Failed-condition phrases for the amber/danger message. */
  reasons: string[];
  /** Per-condition AND across all signing wallets (the popover breakdown). */
  conditions: { approved: boolean; gasFunded: boolean; notExpired: boolean; solvent: boolean };
  wallets: WalletDetail[];
}

/**
 * S5 publish-eligibility engine (UX §5.5). For a publish into `contextGraphId`,
 * probes every operational wallet × every tracked PCA and resolves the
 * fail-toward-loud 4-state verdict (DRIFT-3 / invariant #6):
 *  - GREEN: every signing wallet is covered by a healthy, solvent, unexpired PCA.
 *  - AMBER: a fall-through exists but every uncovered wallet has TRAC (pays direct).
 *  - DANGER: an uncovered wallet has NO TRAC → the publish would FAIL.
 *  - NEUTRAL: can't confirm (nothing tracked / no wallets / probe error) — never green.
 *
 * The escrow caveat is owner-scoped (#4): `ownerPublish` is true only when this
 * node curates the target CG. Everything is a PREDICTION (#9) — no B8 confirmation.
 */
export function usePublishEligibility(contextGraphId: string, intervalMs = 0): PublishEligibility {
  const trackedIds = usePcaStore((s) => s.trackedIds);
  const idsKey = trackedIds.join(',');

  const { data, loading } = useFetch(
    async () => {
      if (trackedIds.length === 0) {
        return { wallets: [] as WalletDetail[], ownerPublish: false, resolved: false };
      }
      const wb = await fetchWalletsBalances().catch(() => null);
      const wallets = wb?.wallets ?? [];
      let ownerPublish = false;
      try {
        // L12: the CG list item has NO `isCurator`/`role` field — the owner
        // signal is `cg.curator` (a DID) vs this node's agent DID (the exact
        // derivation DashboardView uses for its CURATOR badge). The escrow is
        // owner-scoped (#4), so without this the caveat never fired on owner-CGs.
        const { contextGraphs } = await fetchContextGraphs();
        const cg = (contextGraphs ?? []).find((c: any) => c?.id === contextGraphId);
        const curator = cg?.curator;
        if (curator) {
          const me = await fetchCurrentAgent().catch(() => null);
          ownerPublish = !!(me?.agentDid && canonicalAgentDid(curator) === canonicalAgentDid(me.agentDid));
        }
      } catch {
        ownerPublish = false;
      }

      const details: WalletDetail[] = await Promise.all(
        wallets.map(async (w) => {
          const bal = wb?.balances?.find((b) => eq(b.address, w));
          // O4 — balances is all-or-nothing: the daemon returns a full per-wallet
          // list or [] (+ error) at HTTP 200. A missing entry = UNREAD funding.
          const balanceUnknown = bal == null;
          const gasFunded = bal != null && Number(bal.eth) > 0;
          const hasTrac = bal != null && Number(bal.trac) > 0;
          let cover: { accountId: string; discountBps: number } | undefined;
          let sawExpired = false;
          let sawInsolvent = false;
          let deadAccountId: string | undefined;
          let probeError = false;
          for (const id of trackedIds) {
            const snap = await fetchPca(id, w).catch(() => null);
            // C1/#9 — a REJECTED probe (`null`) is "couldn't read", NOT a confirmed
            // not-registered. Distinguish them: a failed probe is inconclusive (→
            // neutral verdict), never a definitive fall-through DANGER at spend time.
            if (snap === null) { probeError = true; continue; }
            // #1344 round-2 — ONE canonical classification (registration + coarse-P0
            // spendability) instead of bundling the leaf predicates here. Behavior is
            // byte-identical to the prior 4-helper form. Coarse P0, NOT remainingAllowance
            // (P2/#1349).
            const c = classifyCoverage(snap, snap.probedKey);
            // S2/#9 — adapter gap OR an undefined registered → inconclusive ("couldn't
            // determine" → neutral verdict, never a definitive DANGER); a confirmed
            // not-registered → skip.
            if (c.inconclusive) { probeError = true; continue; }
            if (c.registered === false) continue;
            // registered here — coarse spendability decides coverage.
            if (c.covers) {
              cover = { accountId: id, discountBps: snap.discountBps };
              break;
            }
            // Registered here but the account can't cover — break down (dead vs
            // out-of-budget) from the SAME classification, so the copy distinguishes
            // "approved-but-dead" from "no PCA" (#3) and the reasons name the cause. Two
            // INDEPENDENT checks (a dead AND zero-budget account sets both).
            if (c.dead) {
              sawExpired = true;
              if (!deadAccountId) deadAccountId = id;
            }
            if (!c.hasBudget) sawInsolvent = true;
          }
          return {
            wallet: w,
            covered: !!cover,
            accountId: cover?.accountId,
            discountBps: cover?.discountBps,
            deadAccountId: cover ? undefined : deadAccountId,
            inconclusive: !cover && probeError,
            // Q2 — set for COVERED wallets too: GREEN's gas check must tell a
            // confirmed-zero-gas covered wallet from an unreadable-gas one (fail open).
            balanceUnknown,
            gasFunded,
            hasTrac,
            sawExpired,
            sawInsolvent,
          };
        }),
      );
      return { wallets: details, ownerPublish, resolved: wallets.length > 0 };
    },
    [idsKey, contextGraphId],
    intervalMs,
  );

  return useMemo<PublishEligibility>(() => {
    const wallets = data?.wallets ?? [];
    const ownerPublish = data?.ownerPublish ?? false;
    const resolved = data?.resolved ?? false;

    if (trackedIds.length === 0 || !resolved || wallets.length === 0) {
      return {
        verdict: 'unknown',
        loading,
        ownerPublish,
        reasons: [],
        conditions: { approved: false, gasFunded: false, notExpired: false, solvent: false },
        wallets,
      };
    }

    const covered = wallets.filter((w) => w.covered);
    const uncovered = wallets.filter((w) => !w.covered);
    // C1/O4/#9 — drive amber/danger off CONFIRMED uncovered only; a wallet that's
    // uncovered merely because its coverage probe failed (inconclusive) OR whose
    // balance was unreadable (balanceUnknown) is not a definitive fall-through.
    const confirmedUncovered = uncovered.filter((w) => !w.inconclusive && !w.balanceUnknown);
    const inconclusive = uncovered.filter((w) => w.inconclusive || w.balanceUnknown);
    const conditions = {
      approved: uncovered.length === 0,
      gasFunded: wallets.every((w) => w.gasFunded),
      notExpired: !wallets.some((w) => w.sawExpired),
      solvent: !wallets.some((w) => w.sawInsolvent),
    };

    let verdict: PcaVerdict;
    const reasons: string[] = [];
    if (uncovered.length === 0) {
      // Q2/#9 — a PCA covers only the TRAC fee; the signer still needs native GAS or
      // it terminally fails on-chain. GREEN requires ≥1 covered wallet with confirmed
      // gas OR unreadable gas (fail OPEN — mirror the backend's native===null, don't
      // regress O4); ALL-covered-confirmed-zero-gas → DANGER. (inconclusive still
      // blocks GREEN since it keeps wallets in `uncovered`.)
      if (covered.some((w) => w.gasFunded || w.balanceUnknown)) {
        verdict = 'eligible';
      } else {
        verdict = 'fallthrough-no-funds';
        reasons.push('every approved signing wallet is out of gas');
      }
    } else if (confirmedUncovered.length === 0 && inconclusive.length > 0) {
      // Every uncovered wallet is merely UNREADABLE — resolve neutral (fail toward
      // unknown, not a DANGER we can't confirm); self-corrects on the next 30s poll.
      verdict = 'unknown';
    } else {
      // R3 — #1327 made signer selection funding-aware (evm-adapter-base
      // selectFundedSigner): it picks ONE authorized wallet that can pay (PCA-
      // covered OR own-TRAC, + gas) and skips the rest. So the publish FAILS only
      // when NO wallet can fund it — a single uncovered/no-TRAC spare wallet must
      // not assert "will FAIL". DANGER narrows; GREEN stays strict (every wallet
      // covered) so we never promise a discount the picker might not deliver.
      const anyCanFund = wallets.some((w) => (w.covered || w.hasTrac) && w.gasFunded);
      if (!anyCanFund && inconclusive.length > 0) {
        // V3/#9 — a CONFIRMED-broke wallet alongside an UNREADABLE one: don't assert
        // "will fail" — the inconclusive wallet may be the funded signer once readable.
        // Resolve neutral (like the all-inconclusive branch; push no definitive reasons).
        verdict = 'unknown';
      } else {
        verdict = anyCanFund ? 'fallthrough' : 'fallthrough-no-funds';
        reasons.push(`${covered.length} of ${wallets.length} signing wallets approved`);
        if (wallets.some((w) => w.sawExpired)) reasons.push('a conviction account has expired or been fully swept');
        if (wallets.some((w) => w.sawInsolvent)) reasons.push('a conviction account is out of budget');
        if (!conditions.gasFunded) reasons.push('a signing wallet has no gas');
        if (uncovered.some((w) => w.inconclusive)) reasons.push('a wallet’s PCA coverage couldn’t be checked');
        if (uncovered.some((w) => w.balanceUnknown)) reasons.push('a signing wallet’s balance couldn’t be checked');
      }
    }

    // L1: the GREEN chip should advertise the BEST covering discount (wallets may
    // draw from different PCAs), matching bestCoveringDiscountBps — not covered[0].
    const best = covered.reduce<WalletDetail | undefined>(
      (m, w) => ((w.discountBps ?? -1) > (m?.discountBps ?? -1) ? w : m),
      undefined,
    );
    return {
      verdict,
      loading,
      accountId: best?.accountId,
      discountBps: best?.discountBps,
      ownerPublish,
      reasons,
      conditions,
      wallets,
    };
  }, [data, loading, trackedIds.length]);
}
