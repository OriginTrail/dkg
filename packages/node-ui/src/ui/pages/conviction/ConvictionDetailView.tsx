import React, { useState } from 'react';
import { useFetch } from '../../hooks.js';
import {
  fetchPca,
  fetchWalletsBalances,
  fetchContextGraphs,
  registerContextGraph,
  describePcaError,
  isRpcTransportError,
  HttpError,
  type PcaSnapshot,
} from '../../api.js';
import { useOwnerActionSubmitter } from '../../pca/ownerActions.js';
import { useAgentsStore } from '../../stores/agents.js';
import { formatTrac } from '../../lib/formatTrac.js';
import {
  HealthChip,
  WalletRow,
  AddressCrux,
  healthForSnapshot,
  formatWeiToTrac,
  formatRelativeExpiry,
} from '../../components/Pca/index.js';
import { StatStrip } from '../../components/ContextGraphPrimitives.js';
import { ApproveWalletsModal } from './ApproveWalletsModal.js';

const eq = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * M7 — CG-bind goes through `POST /api/context-graph/register` whose classifier
 * differs from the PCA routes (Backend-confirmed caveat set), so it needs its
 * own mapping rather than `describePcaError`:
 *  - transport RPC_* / TIMEOUT → transient retry
 *  - 501 → soft "can't verify PCA ownership" (introspection gap, not a hard error)
 *  - 403 signer≠owner → "bind from the PCA owner wallet"
 *  - 404 / 409 / 400 (engine validation sentence) → surfaced verbatim-ish
 *  - 503 "no known creator" → creator not synced yet (vs generic transport)
 */
function describeCgBindError(err: unknown): string {
  if (isRpcTransportError(err)) return 'The chain RPC is temporarily unavailable — try again.';
  if (err instanceof HttpError) {
    const raw = (err.body as { error?: string } | undefined)?.error ?? err.message ?? '';
    switch (err.status) {
      case 501:
        return 'Couldn’t verify PCA ownership on this node — its chain adapter doesn’t support the lookup, so binding can’t be completed here.';
      case 403:
        return 'Bind from the PCA owner wallet — this node’s chain signer isn’t the account owner.';
      case 404:
        return 'That context graph or PCA account doesn’t exist.';
      case 409:
        return /already/i.test(raw) ? 'This context graph is already registered.' : raw || 'Already registered.';
      case 400:
        return raw || 'Invalid request — the context graph must be curated and the PCA id a positive integer.';
      case 503:
        return /no known creator/i.test(raw)
          ? 'The context graph’s creator isn’t synced on this node yet — try again shortly.'
          : 'The chain RPC is temporarily unavailable — try again.';
    }
  }
  return (err as Error)?.message ?? 'Bind failed.';
}

interface ActionState {
  busy: boolean;
  error: string | null;
  result: { txHash?: string; message: string } | null;
}
const IDLE: ActionState = { busy: false, error: null, result: null };

/**
 * S3 PCA Detail (Manage). Owner actions (top-up / approve / deregister / bind)
 * are pre-disabled unless the owner is this node's PRIMARY operational wallet
 * (§8A — the only key the daemon signs owner writes with); Settlement and the
 * probe stay enabled for everyone (permissionless). Every write surfaces its
 * txHash + a "still pending… verify here" escape.
 */
export function ConvictionDetailView({ accountId }: { accountId: string }) {
  const { data: snapshot, loading, error, refresh } = useFetch(() => fetchPca(accountId), [accountId]);
  const { data: wb, error: wbError, refresh: refreshWallets } = useFetch(fetchWalletsBalances, [], 0);
  const nodeStatus = useAgentsStore((s) => s.nodeStatus) as { blockExplorerUrl?: string | null } | null;
  const explorer = nodeStatus?.blockExplorerUrl ?? null;
  const wallets = wb?.wallets ?? [];
  // L3: a transient balances blip (wb null + error) must NOT reclassify
  // owned→not-owner and flicker the owner controls into a definitive "you're not
  // the owner" — show "can't confirm" instead and keep the retry.
  const walletsUnknown = !wb && !!wbError;

  if (loading && !snapshot) return <div className="lazy-spinner">Loading PCA #{accountId}…</div>;
  if (error || !snapshot) {
    return (
      <div className="v10-pca-detail">
        <div className="card">
          <div className="card-body v10-pca-card-error">
            <p>Couldn’t load PCA #{accountId}.</p>
            <button type="button" className="v10-pca-card-btn" onClick={() => refresh()}>Retry</button>
          </div>
        </div>
      </div>
    );
  }

  const ownerIsPrimary = !walletsUnknown && eq(wallets[0], snapshot.owner);
  const ownerInPool = wallets.some((w) => eq(w, snapshot.owner));
  const ownerOnlyReason = walletsUnknown
    ? `Couldn’t load this node’s wallets — can’t confirm ownership of PCA #${accountId}.`
    : ownerInPool
      ? `Owner-only — PCA #${accountId} is owned by ${snapshot.owner}, not this node’s primary operational wallet, so node-UI can’t sign for it.`
      : `Owner-only — this node isn’t the owner of PCA #${accountId}.`;

  return (
    <DetailBody
      accountId={accountId}
      snapshot={snapshot}
      wallets={wallets}
      ownerTrac={wb?.balances?.find((b) => eq(b.address, snapshot.owner))?.trac}
      explorer={explorer}
      ownerIsPrimary={ownerIsPrimary}
      ownerOnlyReason={ownerOnlyReason}
      walletsUnknown={walletsUnknown}
      onRetryWallets={refreshWallets}
      refresh={refresh}
    />
  );
}

function DetailBody({
  accountId, snapshot, wallets, ownerTrac, explorer, ownerIsPrimary, ownerOnlyReason, walletsUnknown, onRetryWallets, refresh,
}: {
  accountId: string;
  snapshot: PcaSnapshot;
  wallets: string[];
  ownerTrac?: string;
  explorer: string | null;
  ownerIsPrimary: boolean;
  ownerOnlyReason: string;
  walletsUnknown: boolean;
  onRetryWallets: () => void;
  refresh: () => void;
}) {
  const owner = useOwnerActionSubmitter(accountId); // owner-action seam (P0: daemon submitter)
  const [topUp, setTopUp] = useState('');
  const [fund, setFund] = useState<ActionState>(IDLE);
  const [settle, setSettle] = useState<ActionState>(IDLE);
  const [probe, setProbe] = useState('');
  const [probeResult, setProbeResult] = useState<string | null>(null);
  const [bindCg, setBindCg] = useState('');
  const [bind, setBind] = useState<ActionState>(IDLE);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [removeState, setRemoveState] = useState<ActionState>(IDLE);
  const [approveOpen, setApproveOpen] = useState(false);

  const { data: cgData } = useFetch(fetchContextGraphs, [], 0);
  // N3 — bind == register an UNREGISTERED CURATED CG with a PCA (there's no
  // update-authority route). Filter the dropdown to bindable CGs so a registered
  // one can't be picked and silently false-"Bound" (#9). The list endpoint already
  // returns onChainId + accessPolicy.
  const cgs = (cgData?.contextGraphs ?? []) as Array<{
    id: string;
    name?: string;
    onChainId?: string;
    accessPolicy?: string;
  }>;
  const bindable = cgs.filter((cg) => !cg.onChainId && cg.accessPolicy === 'private');
  const health = healthForSnapshot(snapshot);
  const ownerTitle = ownerIsPrimary ? undefined : ownerOnlyReason;

  const runFund = async () => {
    setFund({ busy: true, error: null, result: null });
    try {
      const res = await owner.topUp(accountId, topUp.trim());
      setFund({ busy: false, error: null, result: { txHash: res.txHash, message: `Added ${formatTrac(res.addedTokens)} TRAC.` } });
      setTopUp('');
      refresh();
    } catch (err) {
      setFund({ busy: false, error: describePcaError(err, { accountId })?.message ?? (err as Error)?.message ?? 'Top-up failed.', result: null });
    }
  };
  const runSettle = async () => {
    setSettle({ busy: true, error: null, result: null });
    try {
      const res = await owner.settle(accountId);
      setSettle({ busy: false, error: null, result: { txHash: res.txHash, message: 'Settlement sweep submitted.' } });
      refresh();
    } catch (err) {
      setSettle({ busy: false, error: describePcaError(err, { accountId })?.message ?? (err as Error)?.message ?? 'Settle failed.', result: null });
    }
  };
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
  const runBind = async () => {
    setBind({ busy: true, error: null, result: null });
    try {
      const res = await registerContextGraph(bindCg, { pcaAccountId: accountId });
      // N3 — a 200 with NO txHash means the CG was already registered on-chain and
      // the daemon took the idempotent path WITHOUT applying the new pcaAccountId.
      // Never claim "Bound" (a #9 false confirmation) — say it plainly.
      if (!res.txHash) {
        setBind({
          busy: false,
          error:
            'This context graph is already registered on-chain — its publishing authority can’t be changed from here. Bind a PCA when first registering the graph.',
          result: null,
        });
        return;
      }
      setBind({ busy: false, error: null, result: { txHash: res.txHash, message: `Bound ${bindCg} to PCA #${accountId}.` } });
    } catch (err) {
      setBind({ busy: false, error: describeCgBindError(err), result: null });
    }
  };
  const runRemove = async (addr: string) => {
    setRemoveState({ busy: true, error: null, result: null });
    try {
      await owner.deregisterAgent(accountId, addr);
      setRemoveState({ busy: false, error: null, result: { message: `Removed ${addr}.` } });
      setConfirmRemove(null);
      refresh();
    } catch (err) {
      setRemoveState({ busy: false, error: describePcaError(err, { accountId })?.message ?? (err as Error)?.message ?? 'Remove failed.', result: null });
    }
  };

  const pct = (snapshot.discountBps / 100).toFixed(snapshot.discountBps % 100 === 0 ? 0 : 1);

  return (
    <div className="v10-pca-detail" data-testid="pca-detail">
      <div className="v10-pca-detail-band">
        <span className="v10-pca-detail-id">PCA #{accountId}</span>
        <span className="badge badge-info">◉ {pct}% discount</span>
        <span className="v10-pca-detail-committed">{formatTrac(snapshot.committedTRACTrac)} TRAC committed</span>
        <span className="v10-pca-card-spacer" />
        <HealthChip state={health} />
      </div>

      {!ownerIsPrimary && (
        <div className="v10-modal-warning" role="status">
          ⓘ {ownerOnlyReason}{' '}
          {walletsUnknown ? (
            <button type="button" className="v10-pca-card-btn" onClick={onRetryWallets}>Retry</button>
          ) : (
            'Settlement and the wallet probe stay available.'
          )}
        </div>
      )}

      <StatStrip
        items={[
          { id: 'buffer', label: 'Top-up buffer', value: `${formatTrac(snapshot.topUpBufferTrac)} TRAC` },
          { id: 'per-epoch', label: 'TRAC per epoch', value: `${formatWeiToTrac(snapshot.baseEpochAllowance)} TRAC` },
          { id: 'wallets', label: 'Publishing wallets', value: `${snapshot.agentCount} / 100` },
          { id: 'expires', label: 'Expires', value: formatRelativeExpiry(snapshot.expiresAtTimestamp), tooltip: `Expiry epoch ${snapshot.expiresAtEpoch}` },
        ]}
      />
      <div className="v10-pca-detail-owner">
        <span className="v10-pca-card-owner-lbl">Owner</span>
        <WalletRow
          address={snapshot.owner}
          trailing={explorer ? <a className="v10-pca-card-explorer" href={`${explorer}/address/${snapshot.owner}`} target="_blank" rel="noreferrer" aria-label="View owner on explorer">↗</a> : undefined}
        />
      </div>

      {/* Funding */}
      <section className="v10-pca-detail-section">
        <h3 className="v10-pca-detail-section-title">Funding</h3>
        <p className="v10-pca-detail-hint">
          Top-up raises the spendable buffer. It does <strong>not</strong> extend the lock period —
          when the account expires you create a new one.
        </p>
        {ownerTrac != null && <p className="v10-pca-detail-hint">Owner balance: {formatTrac(ownerTrac)} TRAC</p>}
        <div className="v10-pca-detail-form">
          <input
            className="v10-form-input"
            type="text"
            inputMode="decimal"
            value={topUp}
            onChange={(e) => setTopUp(e.target.value)}
            placeholder="Top up (TRAC)"
            disabled={!ownerIsPrimary || fund.busy}
            aria-label="Top-up amount in TRAC"
          />
          <button
            type="button"
            className="v10-pca-card-btn primary"
            data-testid="pca-topup-btn"
            onClick={runFund}
            disabled={!ownerIsPrimary || fund.busy || !/^\d+(\.\d+)?$/.test(topUp.trim()) || Number(topUp.trim()) <= 0}
            title={ownerTitle}
          >
            {fund.busy ? 'Adding…' : 'Add funds'}
          </button>
        </div>
        <ActionFeedback state={fund} explorer={explorer} />
      </section>

      {/* Settlement (permissionless) */}
      <section className="v10-pca-detail-section">
        <h3 className="v10-pca-detail-section-title">Settlement</h3>
        <p className="v10-pca-detail-hint">
          Sweeps each epoch’s unspent budget to the staker reward pool. It’s lazy and permissionless —
          anyone can trigger it; it only moves already-earmarked funds. Last settled epoch{' '}
          {snapshot.lastSettledWindow} · fully swept {snapshot.fullySwept ? '✓' : '✗'}.
        </p>
        <button
          type="button"
          className="v10-pca-card-btn"
          data-testid="pca-settle-btn"
          onClick={runSettle}
          disabled={settle.busy || snapshot.fullySwept}
          title={snapshot.fullySwept ? 'Already fully swept.' : undefined}
        >
          {settle.busy ? 'Sweeping…' : 'Run settlement sweep'}
        </button>
        <ActionFeedback state={settle} explorer={explorer} />
      </section>

      {/* Publishing wallets */}
      <section className="v10-pca-detail-section">
        <h3 className="v10-pca-detail-section-title">Publishing wallets — {snapshot.agentCount} / 100</h3>
        <div className="v10-pca-detail-form">
          <AddressCrux mode="single" value={probe} onChange={setProbe} label="Check a wallet" cruxNote={null} />
          <button type="button" className="v10-pca-card-btn" onClick={runProbe}>Probe</button>
        </div>
        {probeResult && <p className="v10-pca-detail-hint" role="status">{probeResult}</p>}

        <p className="v10-pca-detail-subhead">This node’s wallets:</p>
        <div className="v10-pca-detail-agentlist" data-testid="pca-agent-list">
          {wallets.map((w) => (
            <WalletProbeRow
              key={w}
              accountId={accountId}
              wallet={w}
              ownerIsPrimary={ownerIsPrimary}
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
        {removeState.error && <p className="v10-modal-error" role="alert">{removeState.error}</p>}
        <p className="v10-pca-overview-caveat">
          ⓘ The chain exposes how many wallets are approved, not the full list — only this node’s
          wallets and any you probe are shown here.
        </p>
        <button
          type="button"
          className="v10-pca-card-btn primary"
          onClick={() => setApproveOpen(true)}
          disabled={!ownerIsPrimary}
          title={ownerTitle}
        >
          + Approve publishing wallet
        </button>
      </section>

      {/* Context-graph binding (curated only) */}
      <section className="v10-pca-detail-section">
        <h3 className="v10-pca-detail-section-title">Context-graph binding</h3>
        <p className="v10-pca-detail-hint">
          Binding authorizes publishing into a graph under this account — separate from the primary
          node and from which wallets pay. <strong>Curated/private policy only</strong>, and the
          binding node’s signer must equal the PCA owner.
        </p>
        {bindable.length === 0 ? (
          <p className="v10-pca-detail-hint" role="status">
            No unregistered curated context graphs to bind. Binding sets a graph’s publishing authority
            at its first on-chain registration; an already-registered graph can’t be changed from here.
          </p>
        ) : (
          <div className="v10-pca-detail-form">
            <select
              className="v10-form-select"
              value={bindCg}
              onChange={(e) => setBindCg(e.target.value)}
              disabled={!ownerIsPrimary || bind.busy}
              aria-label="Context graph to bind"
            >
              <option value="">Select a context graph…</option>
              {bindable.map((cg) => (
                <option key={cg.id} value={cg.id}>{cg.name ?? cg.id}</option>
              ))}
            </select>
            <button
              type="button"
              className="v10-pca-card-btn"
              onClick={runBind}
              disabled={!ownerIsPrimary || bind.busy || !bindCg}
              title={ownerTitle}
            >
              {bind.busy ? 'Binding…' : 'Bind context graph'}
            </button>
          </div>
        )}
        <ActionFeedback state={bind} explorer={explorer} />
      </section>

      {/* Lifecycle / danger */}
      <section className="v10-pca-detail-section">
        <h3 className="v10-pca-detail-section-title">Lifecycle</h3>
        {(health === 'expiring' || health === 'expired') && (
          <p className="v10-pca-card-warn">
            {formatRelativeExpiry(snapshot.expiresAtTimestamp)}. Top-up can’t extend the lock period —
            create a replacement account from the overview when it expires.
          </p>
        )}
        <p className="v10-pca-detail-hint">
          ⓘ Transferring this account’s NFT to another wallet clears every approved publishing wallet —
          the new owner starts clean. (Out-of-band wallet op — no button here.)
        </p>
        <button type="button" className="v10-pca-card-btn" disabled title="Coming soon (not yet available from the node UI)">
          Re-point primary node — Coming soon
        </button>
      </section>

      {approveOpen && (
        <ApproveWalletsModal
          accountId={accountId}
          initialMode="self"
          onClose={() => { setApproveOpen(false); refresh(); }}
        />
      )}
    </div>
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
                <span>Publishes from this wallet will pay the direct cost (and revert if it holds no TRAC). Remove?</span>
                <button type="button" className="v10-pca-card-btn" data-testid="pca-deregister-btn" onClick={onConfirmRemove} disabled={removeBusy}>
                  {removeBusy ? 'Removing…' : 'Yes, remove'}
                </button>
                <button type="button" className="v10-pca-card-btn" onClick={onCancelRemove} disabled={removeBusy}>Cancel</button>
              </span>
            ) : (
              <button
                type="button"
                className="v10-pca-card-btn"
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

function ActionFeedback({ state, explorer }: { state: ActionState; explorer: string | null }) {
  if (state.error) return <p className="v10-modal-error" role="alert">{state.error}</p>;
  if (!state.result) return null;
  const txUrl = explorer && state.result.txHash ? `${explorer}/tx/${state.result.txHash}` : undefined;
  return (
    <p className="v10-pca-detail-result" data-testid="pca-action-result" role="status">
      {state.result.message}{' '}
      {txUrl && <a href={txUrl} target="_blank" rel="noreferrer">tx ↗</a>}{' '}
      Still pending? You can close this and verify here.
    </p>
  );
}
