import React, { useId, useState } from 'react';
import { usePcaStore } from '../../stores/pca.js';
import { usePublishEligibility } from '../../hooks/usePublishEligibility.js';
import { EligibilityVerdictBanner, WalletRow, CopyButton } from '../../components/Pca/index.js';

function ConditionRow({ ok, label, info }: { ok: boolean; label: string; info?: boolean }) {
  const glyph = info ? 'ⓘ' : ok ? '✓' : '⚠';
  const tone = info ? 'neutral' : ok ? 'success' : 'warn';
  return (
    <li className="v10-pca-publish-cond" data-tone={tone}>
      <span aria-hidden="true">{glyph}</span> {label}
    </li>
  );
}

/**
 * S5 — the condensed PCA eligibility chip on the SWM→VM publish CTA, plus the
 * "why?" preflight popover (per-condition AND-across-wallets breakdown + per-wallet
 * status + fix-it). The chip is the load-bearing fall-through guard at the moment
 * of spend; it carries its own aria-live (via EligibilityVerdictBanner: amber AND
 * danger = role=alert/assertive). Rendered only when the node tracks ≥1 PCA — a
 * node not using conviction gets no chip noise.
 *
 * `id` lets the publish button reference the verdict via aria-describedby so a
 * screen-reader user activating Publish hears the direct-cost/fail state.
 */
export function PublishEligibilityChip({ contextGraphId, id }: { contextGraphId: string; id?: string }) {
  const trackedIds = usePcaStore((s) => s.trackedIds);
  const elig = usePublishEligibility(contextGraphId, 30_000);
  const [open, setOpen] = useState(false);
  const popId = useId();

  // No tracked PCA → no expectation of a discount → no chip.
  if (trackedIds.length === 0) return null;

  return (
    <div className="v10-pca-publish-chip" id={id} data-testid="pca-publish-eligibility">
      <EligibilityVerdictBanner
        variant="chip"
        verdict={elig.verdict}
        accountId={elig.accountId}
        discountBps={elig.discountBps}
        ownerPublish={elig.ownerPublish}
        onWhy={() => setOpen((o) => !o)}
        whyExpanded={open}
        controlsId={popId}
      />
      {open && (
        <div className="v10-pca-publish-popover" id={popId} role="region" aria-label="Publish eligibility details">
          <EligibilityVerdictBanner
            verdict={elig.verdict}
            accountId={elig.accountId}
            discountBps={elig.discountBps}
            reasons={elig.reasons}
            ownerPublish={elig.ownerPublish}
          />
          <ul className="v10-pca-publish-conditions">
            <ConditionRow ok={elig.conditions.approved} label="All signing wallets approved on a PCA" />
            {/* L8: gas is excluded from the verdict (§6.3/#6/#7), so it's an
                informational nudge — never a ⚠ pass/fail that contradicts a GREEN chip. */}
            <ConditionRow
              info
              ok={elig.conditions.gasFunded}
              label={
                elig.conditions.gasFunded
                  ? 'All signing wallets gas-funded (gas is separate from the PCA discount)'
                  : 'Gas is separate from the PCA discount — fund any wallet with no gas before publishing'
              }
            />
            <ConditionRow ok={elig.conditions.notExpired} label="Account not expired" />
            <ConditionRow ok={elig.conditions.solvent} label="Account solvent" />
            <ConditionRow ok info label="Publish lifetime auto-matched to the lock period (informational)" />
          </ul>
          <div className="v10-pca-publish-wallets">
            {elig.wallets.map((w) => (
              <WalletRow
                key={w.wallet}
                address={w.wallet}
                status={
                  w.covered
                    ? 'covered'
                    : w.inconclusive
                      ? 'couldn’t check PCA coverage — retry'
                      : w.deadAccountId
                        ? w.hasTrac
                          ? `approved on PCA #${w.deadAccountId}, but it’s swept/expired → pays direct cost`
                          : `approved on PCA #${w.deadAccountId}, but it’s swept/expired → would FAIL (no TRAC)`
                        : w.hasTrac
                          ? 'no PCA → pays direct cost'
                          : 'no PCA + no TRAC → would FAIL'
                }
                statusTone={w.covered ? 'success' : w.inconclusive ? 'neutral' : w.hasTrac ? 'warn' : 'danger'}
                trailing={!w.covered ? <CopyButton value={w.wallet} label={`Copy wallet ${w.wallet}`} /> : undefined}
              />
            ))}
          </div>
          <p className="v10-pca-publish-foot">
            {elig.verdict === 'eligible'
              ? 'Predicted — confirmed on-chain after publish (pending the discount-applied signal).'
              : elig.verdict === 'fallthrough-no-funds'
                ? // QA #2 — DANGER is blocking ("will FAIL"), so the amber "won’t block" note is wrong here.
                  'Publishing now would fail on-chain — fund this wallet with TRAC, or get it approved on a healthy PCA, before you publish.'
                : 'Fix: approve the un-approved wallet(s) on your PCA (Conviction tab), or pin publishing to an approved wallet. This won’t block the publish.'}
          </p>
        </div>
      )}
    </div>
  );
}
