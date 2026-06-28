import { useMemo } from 'react';
import { useFetch } from '../hooks.js';
import { fetchWalletsBalances, fetchPca, fetchContextGraphs, fetchCurrentAgent } from '../api.js';
import { usePcaStore } from '../stores/pca.js';
import { healthForSnapshot } from '../components/Pca/HealthChip.js';
import { canonicalAgentDid } from '../lib/contextGraphSidebar.js';
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

function bigGt0(wei: string | undefined): boolean {
  if (!wei) return false;
  try {
    return BigInt(wei) > 0n;
  } catch {
    return false;
  }
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
            if (!snap.probedKey?.registered) continue;
            const h = healthForSnapshot(snap);
            // reverted L2 — see capstone finding. INTENTIONAL coarse P0 solvency
            // proxy: a funded PCA holds its per-epoch budget in `baseEpochAllowance`
            // (the cap), and `topUpBuffer` is only the EXTRA above that cap — 0 on a
            // fresh, un-topped-up account. A topUpBuffer-only check therefore
            // false-DANGERed every approved+funded PCA (live capstone: PCA #2, 5
            // agents approved, chip showed "out of budget"). So ANY budget capacity
            // ⇒ GREEN-eligible (a prediction, #9 "pending confirmation"); swept/
            // expired are excluded SEPARATELY by the health check below; precise
            // mid-epoch remaining is P2 via the extended snapshot's `remainingAllowance`.
            const solvent = bigGt0(snap.topUpBuffer) || bigGt0(snap.baseEpochAllowance);
            if (h !== 'expired' && h !== 'swept' && solvent) {
              cover = { accountId: id, discountBps: snap.discountBps };
              break;
            }
            // Registered here but the account can't cover (swept/expired) — remember
            // it so the copy distinguishes "approved-but-dead" from "no PCA" (#3).
            if (h === 'expired' || h === 'swept') {
              sawExpired = true;
              if (!deadAccountId) deadAccountId = id;
            }
            if (!solvent) sawInsolvent = true;
          }
          return {
            wallet: w,
            covered: !!cover,
            accountId: cover?.accountId,
            discountBps: cover?.discountBps,
            deadAccountId: cover ? undefined : deadAccountId,
            inconclusive: !cover && probeError,
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
    // C1/#9 — drive amber/danger off CONFIRMED uncovered only; a wallet that's
    // uncovered merely because its probe failed is inconclusive, never a definitive
    // fall-through.
    const confirmedUncovered = uncovered.filter((w) => !w.inconclusive);
    const inconclusive = uncovered.filter((w) => w.inconclusive);
    const conditions = {
      approved: uncovered.length === 0,
      gasFunded: wallets.every((w) => w.gasFunded),
      notExpired: !wallets.some((w) => w.sawExpired),
      solvent: !wallets.some((w) => w.sawInsolvent),
    };

    let verdict: PcaVerdict;
    const reasons: string[] = [];
    if (uncovered.length === 0) {
      verdict = 'eligible'; // inconclusive still blocks GREEN (uncovered includes it)
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
      verdict = anyCanFund ? 'fallthrough' : 'fallthrough-no-funds';
      reasons.push(`${covered.length} of ${wallets.length} signing wallets approved`);
      if (wallets.some((w) => w.sawExpired)) reasons.push('a conviction account has expired or been fully swept');
      if (wallets.some((w) => w.sawInsolvent)) reasons.push('a conviction account is out of budget');
      if (!conditions.gasFunded) reasons.push('a signing wallet has no gas');
      if (inconclusive.length > 0) reasons.push('a wallet’s PCA coverage couldn’t be checked');
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
