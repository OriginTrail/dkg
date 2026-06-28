import { useMemo } from 'react';
import { useFetch } from '../hooks.js';
import { fetchWalletsBalances, fetchPca, fetchContextGraphs } from '../api.js';
import { usePcaStore } from '../stores/pca.js';
import { healthForSnapshot } from '../components/Pca/HealthChip.js';
import type { PcaVerdict } from '../components/Pca/EligibilityVerdictBanner.js';

const eq = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

interface WalletDetail {
  wallet: string;
  covered: boolean;
  accountId?: string;
  discountBps?: number;
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
        const { contextGraphs } = await fetchContextGraphs();
        const cg = (contextGraphs ?? []).find((c: any) => c?.id === contextGraphId);
        // Owner heuristic: the node curates the target CG (escrow is owner-scoped).
        ownerPublish = !!(cg && (cg.isCurator === true || cg.role === 'curator'));
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
          for (const id of trackedIds) {
            const snap = await fetchPca(id, w).catch(() => null);
            if (!snap?.probedKey?.registered) continue;
            const h = healthForSnapshot(snap);
            const solvent = bigGt0(snap.topUpBuffer) || bigGt0(snap.baseEpochAllowance);
            if (h !== 'expired' && h !== 'swept' && solvent) {
              cover = { accountId: id, discountBps: snap.discountBps };
              break;
            }
            if (h === 'expired' || h === 'swept') sawExpired = true;
            if (!solvent) sawInsolvent = true;
          }
          return {
            wallet: w,
            covered: !!cover,
            accountId: cover?.accountId,
            discountBps: cover?.discountBps,
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
    const conditions = {
      approved: uncovered.length === 0,
      gasFunded: wallets.every((w) => w.gasFunded),
      notExpired: !wallets.some((w) => w.sawExpired),
      solvent: !wallets.some((w) => w.sawInsolvent),
    };

    let verdict: PcaVerdict;
    const reasons: string[] = [];
    if (uncovered.length === 0) {
      verdict = 'eligible';
    } else {
      const anyNoTrac = uncovered.some((w) => !w.hasTrac);
      verdict = anyNoTrac ? 'fallthrough-no-funds' : 'fallthrough';
      reasons.push(`${covered.length} of ${wallets.length} signing wallets approved`);
      if (wallets.some((w) => w.sawExpired)) reasons.push('a conviction account has expired');
      if (wallets.some((w) => w.sawInsolvent)) reasons.push('a conviction account is out of budget');
      if (!conditions.gasFunded) reasons.push('a signing wallet has no gas');
    }

    const best = covered[0];
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
