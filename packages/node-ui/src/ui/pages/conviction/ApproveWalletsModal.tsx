import React, { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useFetch } from '../../hooks.js';
import {
  fetchWalletsBalances,
  fetchPca,
  describePcaError,
} from '../../api.js';
import { useResolvedOwnerActionSubmitter, useResolvingOwnerActionSubmitter } from '../../pca/ownerActions.js';
import { usePcaOwnerAccess } from '../../pca/usePcaOwnerAccess.js';
import { resolveWalletBinding, planSelfCoverage } from '../../pca/walletBinding.js';
import {
  approveBatchReducer,
  initialApproveBatchState,
  selectApprovedWallets,
  selectCounts,
  runApproveBatch,
  ROW_LABEL,
  ROW_TONE,
} from '../../pca/approveBatch.js';
import { PcaModalShell } from './PcaModalShell.js';
import {
  AddressCrux,
  DeviceConfirmProgress,
  WalletRow,
  SponsorshipHandshake,
  CopyButton,
} from '../../components/Pca/index.js';
import { isWrongNetwork, useWalletStore } from '../../stores/wallet.js';
import { eqAddress as sameAddress } from '../../pca/address.js';

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Approve publishing wallets (self · sponsor). Self prefills this node's operational
 * wallets ("0/100 covers nothing" framing); sponsor is the address bulk paste.
 * Approvals run as a SEQUENTIAL per-row loop in a `role="status"` region with a Stop
 * control. The 409-AgentAlreadyRegistered branch re-probes THIS account: registered
 * here → benign "skipped"; otherwise it's a cross-account CONFLICT (never a benign skip)
 * naming the existing PCA when the daemon surfaces its existingAccountId.
 */
export function ApproveWalletsModal({
  accountId,
  initialMode = 'sponsor',
  onClose,
  onApproved,
  seedBulk,
  deregisterFrom,
  seedAgentsResolved,
  selfCoverage,
}: {
  accountId: string;
  initialMode?: 'self' | 'sponsor';
  onClose: () => void;
  onApproved?: () => void;
  /** Renew — prefill the sponsor bulk-paste with the replaced account's agents,
   *  so re-approving the same wallets on the new account is one step. */
  seedBulk?: string;
  /**
   * Renew (deregister-first, #1344) — the OLD account these seeded wallets are still bound
   * to on-chain. Account EXPIRY does NOT clear `agentToAccountId`, so re-approving a
   * seeded wallet on the new account would revert `AgentAlreadyRegistered`. When set,
   * each row is DEREGISTERED from this old account before being registered on the new
   * one. Its presence also marks the renew re-approval context (honest copy).
   */
  deregisterFrom?: string;
  /** Renew — whether the old account's agents loaded (`listPcaAgents`). `false` →
   *  the seed couldn't be pre-filled; the copy stops promising it and prompts manual entry. */
  seedAgentsResolved?: boolean;
  /**
   * Self-coverage — set when this is the post-create self-coverage of THIS node's
   * own wallets. Each wallet is binding-probed at run start before any owner write: a wallet on a
   * PCA the node OWNS is deregistered-first; a wallet on a PCA the node CAN'T own (a sponsor's)
   * is SKIPPED (already discounted free), never burning a register. Distinct from `deregisterFrom`
   * (renew's single old account) — here the old account varies per wallet.
   */
  selfCoverage?: boolean;
}) {
  const { data: wb } = useFetch(fetchWalletsBalances, [], 0);
  const { data: snapshot } = useFetch(() => fetchPca(accountId), [accountId]);
  // Renew — the OLD account's owner-action submitter (free the wallet there first). Resolved
  // separately, via the async re-fetching path, because the old PCA can have a different
  // owner/signing branch than THIS account.
  const deregisterOwner = useResolvingOwnerActionSubmitter({ accountId: deregisterFrom });
  const nodeWallets = wb?.wallets ?? [];
  const ownerWallet = nodeWallets[0]; // the daemon EOA — what it can deregister-from
  const connectedWallet = useWalletStore((s) => s.address);
  const walletWrongNetwork = useWalletStore((s) => isWrongNetwork(s));
  // #1375 — the shared owner-access model for THIS account (drives the managed-target display
  // predicate + the signer candidates). The async, per-account signerKindForAccount below
  // deliberately stays a separate re-fetching seam (inv-16 / P4).
  // `walletsUnknown` while the wallet balances are still loading: without it, a snapshot that
  // loads BEFORE the wallets would see owner + an undefined primaryWallet and misclassify a
  // daemon-owned PCA as external → pin read-only → fail a valid owner approval. Marking it
  // unknown routes the resolved submitter through the re-fetching path (which self-heals to
  // daemon once wallets[0] is readable).
  const access = usePcaOwnerAccess({ owner: snapshot?.owner, primaryWallet: ownerWallet, walletsUnknown: !wb });
  // Item 3 (#1375) — resolve THIS account's owner submitter ONCE from `access`, so the batch's
  // registerAgent (ALWAYS on the TARGET) submits directly with no per-write owner/wallet re-fetch.
  // The wallet branch keeps its per-prompt loadContext / assertStillConnected liveness guards.
  const owner = useResolvedOwnerActionSubmitter({ access });
  // Self-coverage's deregisterSelf frees a wallet from its OWN-bound `prevAccountId`, which VARIES
  // per wallet and can be owned DIFFERENTLY than THIS target (daemon vs connected wallet). So it
  // must resolve the submitter PER-ACCOUNT (the resolving path, keyed on the passed accountId) —
  // the access-path `owner` would misroute it to the target's signer → NotAccountOwner revert. No
  // onWalletProgress: the batch drives its own device prompts.
  const crossAccountDeregister = useResolvingOwnerActionSubmitter({});
  const agentCount = snapshot?.agentCount ?? 0;
  const cap = Math.max(0, 100 - agentCount);

  const [mode, setMode] = useState<'self' | 'sponsor'>(initialMode);
  const [unchecked, setUnchecked] = useState<Record<string, boolean>>({}); // self: opt-OUT set
  const [alreadyApprovedHere, setAlreadyApprovedHere] = useState<Record<string, boolean>>({});
  const [bulk, setBulk] = useState(seedBulk ?? ''); // S2b renew prefills the old account's agents
  // The sequential batch machine (rows/order/running/done/aborted/verificationDelayed/
  // deviceSteps/deviceLabel/walletBatchSigning) lives in a pure reducer; `runApproveBatch`
  // (pca/approveBatch.ts) drives it. Input selection above stays local component state.
  const [batch, dispatch] = useReducer(approveBatchReducer, initialApproveBatchState);
  const stopRef = useRef(false);

  const parsed = useMemo(() => {
    const seen = new Set<string>();
    const valid: string[] = [];
    let invalid = 0;
    for (const line of bulk.split('\n').map((s) => s.trim()).filter(Boolean)) {
      if (!ADDR_RE.test(line)) {
        invalid += 1;
        continue;
      }
      const key = line.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      valid.push(line);
    }
    return { valid, invalid };
  }, [bulk]);

  useEffect(() => {
    let cancelled = false;
    async function probeAlreadyApprovedHere() {
      const entries = await Promise.all(
        nodeWallets.map(async (wallet) => {
          try {
            const snap = await fetchPca(accountId, wallet, { extended: true });
            return [wallet, String(snap.accountId) === String(accountId) && snap.probedKey?.registered === true] as const;
          } catch {
            return [wallet, false] as const;
          }
        }),
      );
      if (cancelled) return;
      const confirmed = Object.fromEntries(entries) as Record<string, boolean>;
      setAlreadyApprovedHere(confirmed);
      setUnchecked((prev) => {
        const next = { ...prev };
        for (const [wallet, registered] of entries) {
          if (registered && next[wallet] === undefined) next[wallet] = true;
        }
        return next;
      });
    }
    if (nodeWallets.length === 0) {
      setAlreadyApprovedHere({});
      return () => {
        cancelled = true;
      };
    }
    void probeAlreadyApprovedHere();
    return () => {
      cancelled = true;
    };
  }, [accountId, nodeWallets.join('|')]);

  const selfSelected = useMemo(
    () => nodeWallets.filter((w) => !alreadyApprovedHere[w] && !unchecked[w]),
    [alreadyApprovedHere, nodeWallets, unchecked],
  );
  const addresses = mode === 'self' ? selfSelected : parsed.valid;
  const overCap = addresses.length > cap;
  const targetWalletManaged = access.mode === 'wallet' && access.writesEnabled;
  const signableOwners = access.signableOwners;

  const signerKindForAccount = async (id?: string): Promise<'daemon' | 'wallet' | undefined> => {
    if (!id) return undefined;
    const oldSnapshot = await fetchPca(id).catch(() => null);
    if (!oldSnapshot?.owner) return undefined;
    if (sameAddress(oldSnapshot.owner, ownerWallet)) return 'daemon';
    if (connectedWallet && !walletWrongNetwork && sameAddress(oldSnapshot.owner, connectedWallet)) return 'wallet';
    return undefined;
  };

  const run = async () => {
    // U1 — do NOT hard-block on the raw count > cap: already-approved-here addresses
    // consume NO slot (resolved per-row as 'skipped' after submit) and the FE can't
    // know that pre-probe. Cap correctness stays via the per-row AgentCapReached
    // handling (the shipped daemon/contract enforce it).
    if (addresses.length === 0) return;
    stopRef.current = false;
    await runApproveBatch(
      { addresses, accountId, mode, selfCoverage, deregisterFrom, targetWalletManaged, signableOwners },
      {
        registerAgent: owner.registerAgent,
        // Both deregister submitters resolve the owner PER-ACCOUNT at call time (the account they
        // free VARIES and can be owned differently than the target): renew frees from the single
        // OLD `deregisterFrom`; self-coverage frees from each wallet's own-bound prevAccount.
        deregisterRenew: deregisterOwner.deregisterAgent,
        deregisterSelf: crossAccountDeregister.deregisterAgent,
        resolveWalletBinding,
        planSelfCoverage,
        signerKindForAccount,
        probePca: fetchPca,
        describePcaError,
        onApproved,
      },
      dispatch,
      () => stopRef.current,
    );
  };

  const {
    order,
    rows,
    running,
    done,
    aborted,
    verificationDelayed,
    deviceSteps,
    deviceLabel,
    walletBatchSigning,
  } = batch;

  const counts = useMemo(() => selectCounts(batch), [batch.order, batch.rows]);
  const approvedWallets = selectApprovedWallets(batch);

  const showResults = order.length > 0;
  const alreadyApprovedCount = nodeWallets.filter((w) => alreadyApprovedHere[w]).length;

  return (
    <PcaModalShell
      onClose={onClose}
      testId="pca-approve-modal"
      title={`Approve publishing wallets — PCA #${accountId}`}
      dismissDisabled={walletBatchSigning}
    >
      <div className="v10-modal-body">
        {/* Mode */}
        <div className="v10-form-group">
          <div className="v10-form-radio-group" role="radiogroup" aria-label="Approval mode">
            <label className="v10-form-radio">
              <input type="radio" checked={mode === 'self'} onChange={() => setMode('self')} disabled={running} />
              Approve my own node’s wallets
            </label>
            <label className="v10-form-radio">
              <input type="radio" checked={mode === 'sponsor'} onChange={() => setMode('sponsor')} disabled={running} />
              Approve another node’s wallets
            </label>
          </div>
        </div>

        {mode === 'self' ? (
          <section className="v10-pca-approve-self">
            <p className="v10-pca-create-warn">
              {agentCount} / 100 slots used — {alreadyApprovedCount} of this node&apos;s wallets are
              already approved here. Unapproved wallets pay the direct cost until you approve them.
            </p>
            <div className="v10-pca-approve-checklist">
              {nodeWallets.map((w, i) => (
                <label key={w} className="v10-pca-approve-self-row">
                  <input
                    type="checkbox"
                    checked={!alreadyApprovedHere[w] && !unchecked[w]}
                    onChange={(e) => setUnchecked((u) => ({ ...u, [w]: !e.target.checked }))}
                    disabled={running || alreadyApprovedHere[w]}
                    aria-label={`Approve ${w}`}
                  />
                  <WalletRow
                    address={w}
                    status={alreadyApprovedHere[w] ? 'already approved here' : i === 0 ? 'primary signer' : undefined}
                    statusTone={alreadyApprovedHere[w] ? 'success' : 'neutral'}
                  />
                </label>
              ))}
              {nodeWallets.length === 0 && (
                <p className="v10-pca-handshake-empty">No operational wallets detected on this node.</p>
              )}
            </div>
            <div className="v10-modal-tip">
              A new PCA covers NOTHING until you approve your own signing wallets. Each is a separate
              on-chain tx you sign (~30s, owner gas).
            </div>
          </section>
        ) : (
          <section className="v10-pca-approve-sponsor">
            <AddressCrux
              mode="bulk"
              testId="pca-approve-address"
              value={bulk}
              onChange={setBulk}
              label="Wallet address(es) — one per line"
              disabled={running}
            />
            <p className="v10-pca-approve-counts">
              {parsed.valid.length} valid · {parsed.invalid} invalid ·{' '}
              {agentCount} → {agentCount + parsed.valid.length} of 100 after this
            </p>
            {deregisterFrom ? (
              // Renew (#1344) — these are the node's OWN carried-over wallets,
              // not a third party, so the sponsor-can't-verify warning is wrong here.
              <div className="v10-modal-warning" data-testid="pca-renew-reapprove-note">
                ⓘ Re-approving PCA #{deregisterFrom}’s wallets on #{accountId}. Each wallet is MOVED —
                deregistered from #{deregisterFrom}, then approved on #{accountId} (two txs per wallet,
                owner gas). Account expiry alone doesn’t free a wallet, so this is required to re-use them.
                {seedAgentsResolved === false && (
                  <>
                    {' '}
                    <strong>Couldn’t load PCA #{deregisterFrom}’s wallets — add them manually below.</strong>
                  </>
                )}
              </div>
            ) : (
              <div className="v10-modal-warning">
                ⚠ We can only check the address is well-formed — we can’t verify it’s the node’s real
                signing wallet. A typo / admin / author address still “approves” and burns a cap slot.
                Confirm it shows as approved in the other operator&apos;s Get added to a PCA panel.
              </div>
            )}
          </section>
        )}

        {overCap && (
          // U1 — SOFT heads-up, not a command to remove: some of these may already be
          // approved here (no slot consumed), so we don't know the real overage pre-probe.
          <div className="v10-modal-warning" role="status">
            ⚠ Up to {cap} of these can be approved. Any already approved here are skipped (no slot
            used); any genuinely beyond the {cap}-slot cap are marked “cap reached”.
          </div>
        )}

        {aborted && (
          <div className="v10-modal-error" role="alert">{aborted}</div>
        )}

        {verificationDelayed && (
          <div className="v10-modal-warning" role="status">{verificationDelayed}</div>
        )}

        {deviceSteps.length > 0 && (
          <DeviceConfirmProgress
            steps={deviceSteps}
            currentLabel={deviceLabel ?? 'Confirm on your device'}
          />
        )}

        {/* Per-row results */}
        {showResults && (
          <div className="v10-pca-approve-results" role="status" aria-live="polite">
            {order.map((a) => {
              const row = rows[a];
              if (!row) return null;
              return (
                <WalletRow
                  key={a}
                  address={a}
                  status={row.message && (row.status === 'conflict' || row.status === 'error' || row.status === 'sponsored' || row.status === 'stranded' || row.status === 'submitted' || row.status === 'aborted') ? row.message : ROW_LABEL[row.status]}
                  statusTone={ROW_TONE[row.status]}
                />
              );
            })}
            {done && (
              <p className="v10-pca-approve-summary">
                Approved {counts.confirmed} confirmed
                {counts.submitted > 0 ? ` · ${counts.submitted} submitted (verify)` : ''}
                {' '}· {counts.skipped} already here · {counts.conflict} conflict
                {counts.sponsored > 0 ? ` · ${counts.sponsored} left on another PCA` : ''}
                {counts.stranded > 0 ? ` · ${counts.stranded} need a retry` : ''}
                {counts.error > 0 ? ` · ${counts.error} failed` : ''}
                {counts.unverified > 0 ? ` · ${counts.unverified} unverified` : ''} (of {order.length}).
              </p>
            )}
          </div>
        )}

        {/* Stranded recovery: a wallet was deregistered from its old PCA but its re-register
            failed, so it's temporarily UNCOVERED. Surface it loudly + offer the one-click re-run
            (the footer "Retry to finish" button re-runs the loop; the now-unbound wallet registers). */}
        {done && counts.stranded > 0 && (
          <div className="v10-modal-warning" role="alert" data-testid="pca-approve-stranded">
            ⚠ {counts.stranded} wallet{counts.stranded === 1 ? ' was' : 's were'} removed from the old
            PCA but not yet re-approved on #{accountId} — temporarily UNCOVERED. Click “Retry to finish”
            to complete the move.
          </div>
        )}

        {/* Sponsor handoff after a run — third-party only; a renew re-approves the node's
            OWN wallets (#1344), so the "remind the other operator" handshake is off. */}
        {done && mode === 'sponsor' && !deregisterFrom && (
          <div className="v10-pca-approve-handoff">
            <div className="v10-modal-warning">
              Remind the other operator: these wallets must hold NATIVE GAS to publish — the account
              covers TRAC, never gas.
            </div>
            <SponsorshipHandshake wallets={approvedWallets} accountId={accountId} role="core" />
            <p className="v10-pca-approve-counts">
              Account id to share back: <strong>#{accountId}</strong>{' '}
              <CopyButton value={accountId} label={`Copy account id ${accountId}`} />
            </p>
          </div>
        )}
      </div>

      <div className="v10-modal-footer">
        <button type="button" className="v10-modal-btn" onClick={onClose} disabled={walletBatchSigning}>
          {done ? 'Done' : 'Cancel'}
        </button>
        {running ? (
          <button type="button" className="v10-modal-btn" onClick={() => { stopRef.current = true; }}>
            Stop
          </button>
        ) : !done ? (
          <button
            type="button"
            className="v10-modal-btn primary"
            data-testid="pca-approve-submit"
            onClick={run}
            disabled={addresses.length === 0}
          >
            Approve {addresses.length} wallet{addresses.length === 1 ? '' : 's'}
          </button>
        ) : counts.stranded > 0 ? (
          // One-click re-run to finish the stranded migrations. `run()` re-processes the
          // selected wallets; a stranded one is now UNBOUND (we deregistered it) → it registers.
          <button type="button" className="v10-modal-btn primary" data-testid="pca-approve-retry-stranded" onClick={run}>
            Retry to finish
          </button>
        ) : null}
      </div>
    </PcaModalShell>
  );
}
