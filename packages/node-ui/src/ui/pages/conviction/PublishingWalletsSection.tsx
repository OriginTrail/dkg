import React, { useState } from 'react';
import { useFetch } from '../../hooks.js';
import { fetchPca, listPcaAgents, describePcaError, type PcaSnapshot } from '../../api.js';
import { usePcaAction } from '../../pca/pcaAction.js';
import { describeDetailWalletError } from '../../pca/detailWalletTx.js';
import { PcaAgentList, AddressCrux, WalletRow } from '../../components/Pca/index.js';
import { ApproveWalletsModal } from './ApproveWalletsModal.js';
import type { OwnerActionSubmitter } from '../../pca/ownerActions.js';
import type { WalletTxProgress } from '../../pca/useWalletTxProgress.js';
import type { DetailDeviceAction } from '../../pca/detailWalletTx.js';
import type { DetailOwnerMode } from '../../pca/detailOwnerMode.js';

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/** Publishing wallets — the never-false-green probe, the B3 approved-list/degrade, remove, approve. */
export function PublishingWalletsSection({
  accountId,
  snapshot,
  wallets,
  explorer,
  ownerMode,
  ownerWritesEnabled,
  ownerTitle,
  owner,
  deviceProgress,
  refresh,
}: {
  accountId: string;
  snapshot: PcaSnapshot;
  wallets: string[];
  explorer: string | null;
  ownerMode: DetailOwnerMode;
  ownerWritesEnabled: boolean;
  ownerTitle?: string;
  owner: OwnerActionSubmitter;
  deviceProgress: WalletTxProgress<DetailDeviceAction>;
  refresh: () => void;
}) {
  const [probe, setProbe] = useState('');
  const [probeResult, setProbeResult] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [removeState, setRemoveState] = usePcaAction();
  const [approveOpen, setApproveOpen] = useState(false);

  // B3 — render the full approved publishing-wallet set when the daemon can enumerate it.
  // Keep the data keyed by account id so a stale response never appears under a new route.
  const { data: agentsData, loading: agentsLoading, refresh: refreshAgents } =
    useFetch(() => listPcaAgents(accountId), [accountId]);
  const agentsForThis = agentsData && agentsData.accountId === accountId ? agentsData : null;

  const runProbe = async () => {
    setProbeResult(null);
    const addr = probe.trim();
    if (!ADDR_RE.test(addr)) { setProbeResult('Enter a valid 0x address.'); return; }
    try {
      const snap = await fetchPca(accountId, addr);
      const reg = snap.probedKey?.registered;
      // M8: a 200 that omits probedKey (or registered:null) means the adapter
      // couldn't answer — render "couldn't determine", NOT a false "✗ NOT approved".
      setProbeResult(
        reg === true
          ? `✓ ${addr} is an approved publishing wallet here.`
          : reg === false
            ? `✗ ${addr} is NOT approved here.`
            : `Couldn’t determine whether ${addr} is approved here — retry.`,
      );
    } catch (err) {
      setProbeResult(describePcaError(err, { accountId })?.message ?? 'Probe failed.');
    }
  };
  const runRemove = async (addr: string) => {
    if (ownerMode === 'wallet') {
      deviceProgress.begin('remove');
    } else {
      deviceProgress.reset();
    }
    setRemoveState({ busy: true, error: null, result: null });
    try {
      await owner.deregisterAgent(accountId, addr);
      setRemoveState({ busy: false, error: null, result: { message: `Removed ${addr}.` } });
      setConfirmRemove(null);
      refresh();
      refreshAgents();
    } catch (err) {
      setRemoveState({
        busy: false,
        error: ownerMode === 'wallet'
          ? describeDetailWalletError(err, 'remove')
          : describePcaError(err, { accountId })?.message ?? (err as Error)?.message ?? 'Remove failed.',
        result: null,
      });
    }
  };

  return (
    <>
      <section className="v10-pca-detail-section">
        <h3 className="v10-pca-detail-section-title">Publishing wallets — {snapshot.agentCount} / 100</h3>
        <div className="v10-pca-detail-form">
          <AddressCrux mode="single" value={probe} onChange={setProbe} label="Check a wallet" cruxNote={null} />
          <button type="button" className="v10-pca-card-btn" onClick={runProbe}>Probe</button>
        </div>
        {probeResult && <p className="v10-pca-detail-hint" role="status">{probeResult}</p>}

        {agentsLoading && !agentsForThis ? (
          <p className="v10-pca-detail-hint" role="status">Loading approved wallets…</p>
        ) : agentsForThis ? (
          // B3 — the FULL approved set (chain enumerator); the count-only caveat is retired.
          <>
            <p className="v10-pca-detail-subhead">Approved publishing wallets:</p>
            {agentsForThis.agents.length > 0 ? (
              <PcaAgentList
                agents={agentsForThis.agents}
                nodeWallets={wallets}
                ownerIsPrimary={ownerWritesEnabled}
                ownerTitle={ownerTitle}
                confirmRemove={confirmRemove}
                onAskRemove={(a) => setConfirmRemove(a)}
                onCancelRemove={() => setConfirmRemove(null)}
                onConfirmRemove={(a) => runRemove(a)}
                removeBusy={removeState.busy}
                explorer={explorer}
              />
            ) : (
              <div className="v10-pca-detail-agentlist" data-testid="pca-agent-list">
                <p className="v10-pca-handshake-empty">No approved publishing wallets yet.</p>
              </div>
            )}
          </>
        ) : (
          // Graceful degrade (B3 route absent / 503 / a 404 race after the snapshot
          // loaded): the P0 probe-only view of THIS node's wallets + the count-only caveat.
          <>
            <p className="v10-pca-detail-subhead">This node’s wallets:</p>
            <div className="v10-pca-detail-agentlist" data-testid="pca-agent-list">
              {wallets.map((w) => (
                <WalletProbeRow
                  key={w}
                  accountId={accountId}
                  wallet={w}
                  ownerIsPrimary={ownerWritesEnabled}
                  ownerTitle={ownerTitle}
                  confirming={confirmRemove === w}
                  onAskRemove={() => setConfirmRemove(w)}
                  onCancelRemove={() => setConfirmRemove(null)}
                  onConfirmRemove={() => runRemove(w)}
                  removeBusy={removeState.busy}
                />
              ))}
              {wallets.length === 0 && <p className="v10-pca-handshake-empty">No operational wallets on this node.</p>}
            </div>
            <p className="v10-pca-overview-caveat">
              ⓘ The chain exposes how many wallets are approved, not the full list — only this node’s
              wallets and any you probe are shown here.
            </p>
          </>
        )}
        {removeState.error && <p className="v10-modal-error" role="alert">{removeState.error}</p>}
        {/* D2 (#1357) — surface the deregister success (was a dead state). */}
        {removeState.result && (
          <p className="v10-pca-detail-result" role="status" data-testid="pca-remove-result">{removeState.result.message}</p>
        )}
        <button
          type="button"
          className="v10-pca-card-btn primary"
          onClick={() => setApproveOpen(true)}
          disabled={!ownerWritesEnabled}
          title={ownerTitle}
        >
          + Approve publishing wallet
        </button>
      </section>

      {approveOpen && (
        <ApproveWalletsModal
          accountId={accountId}
          initialMode="self"
          onClose={() => { setApproveOpen(false); refresh(); refreshAgents(); }}
        />
      )}
    </>
  );
}

function WalletProbeRow({
  accountId, wallet, ownerIsPrimary, ownerTitle, confirming, onAskRemove, onCancelRemove, onConfirmRemove, removeBusy,
}: {
  accountId: string;
  wallet: string;
  ownerIsPrimary: boolean;
  ownerTitle?: string;
  confirming: boolean;
  onAskRemove: () => void;
  onCancelRemove: () => void;
  onConfirmRemove: () => void;
  removeBusy: boolean;
}) {
  const { data: snap, loading, error } = useFetch(() => fetchPca(accountId, wallet), [accountId, wallet]);
  const registered = snap?.probedKey?.registered;
  // M8: a settled probe that errored or returned 200-without-probedKey is
  // "couldn’t determine" — never silently stuck on "checking…" or false-negative.
  const probeUnknown = !loading && (error != null || (snap != null && registered == null));
  return (
    <div className="v10-pca-agent-row" data-testid="pca-agent-row">
      <WalletRow
        address={wallet}
        status={registered === true ? 'approved' : registered === false ? 'not approved' : probeUnknown ? 'couldn’t determine' : 'checking…'}
        statusTone={registered === true ? 'success' : registered === false ? 'danger' : 'neutral'}
        trailing={
          registered === true ? (
            confirming ? (
              <span className="v10-pca-agent-confirm">
                {/* D (#1357) — these degrade-path rows are ALL this node's own wallets, so
                    name that consequence explicitly (deregistering your own signer degrades
                    your own publishes). */}
                <span>This is one of this node’s own signing wallets — its publishes will pay the direct cost (and revert if it holds no TRAC). Remove?</span>
                <button type="button" className="v10-pca-card-btn" data-testid="pca-deregister-btn" aria-label={`Confirm removing ${wallet}`} onClick={onConfirmRemove} disabled={removeBusy}>
                  {removeBusy ? 'Removing…' : 'Yes, remove'}
                </button>
                <button type="button" className="v10-pca-card-btn" aria-label={`Cancel removing ${wallet}`} onClick={onCancelRemove} disabled={removeBusy}>Cancel</button>
              </span>
            ) : (
              <button
                type="button"
                className="v10-pca-card-btn"
                aria-label={`Remove ${wallet}`}
                onClick={onAskRemove}
                disabled={!ownerIsPrimary}
                title={ownerTitle}
              >
                Remove
              </button>
            )
          ) : undefined
        }
      />
    </div>
  );
}
