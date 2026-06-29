import React, { useMemo, useRef, useState } from 'react';
import { useFetch } from '../../hooks.js';
import {
  fetchWalletsBalances,
  fetchPca,
  describePcaError,
  HttpError,
} from '../../api.js';
import { useOwnerActionSubmitter } from '../../pca/ownerActions.js';
import { resolveWalletBinding, planSelfCoverage } from '../../pca/walletBinding.js';
import { PcaModalShell } from './PcaModalShell.js';
import {
  AddressCrux,
  WalletRow,
  SponsorshipHandshake,
  CopyButton,
  type WalletRowTone,
} from '../../components/Pca/index.js';

type RowStatus = 'pending' | 'approved' | 'submitted' | 'skipped' | 'sponsored' | 'stranded' | 'conflict' | 'cap' | 'error' | 'unverified';
interface Row {
  address: string;
  status: RowStatus;
  message?: string;
  txHash?: string;
}

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

const ROW_LABEL: Record<RowStatus, string> = {
  pending: 'approving…',
  approved: 'approved on-chain',
  submitted: 'submitted — verify',
  skipped: 'already approved here (skipped)',
  // B1 self-coverage — bound to a sponsor's PCA; intentionally left there (already discounted
  // free), NOT moved. Distinct from 'skipped' (= already approved HERE).
  sponsored: 'left on a sponsor’s PCA (already discounted free)',
  // M5 — deregistered from the old PCA but the re-register failed: currently uncovered, recoverable.
  stranded: 'removed from the old PCA, not yet on the new one — retry to finish',
  conflict: 'on another conviction account',
  cap: 'cap reached',
  error: 'failed',
  // N5/#9 — couldn't confirm whether the AgentAlreadyRegistered is on THIS account
  // (transient probe failure or adapter capability gap). Neutral, not a false conflict.
  unverified: 'already approved somewhere — couldn’t verify; retry',
};
const ROW_TONE: Record<RowStatus, WalletRowTone> = {
  pending: 'neutral',
  approved: 'success',
  submitted: 'neutral',
  skipped: 'neutral',
  sponsored: 'neutral',
  stranded: 'warn',
  conflict: 'danger',
  cap: 'warn',
  error: 'danger',
  unverified: 'neutral',
};

/**
 * S4 — Approve publishing wallets (self · sponsor). Self prefills this node's
 * operational wallets (the #11 "0/100 covers nothing" framing); sponsor is the
 * AddressCrux bulk paste. Approvals run as a SEQUENTIAL per-row loop in a
 * `role="status"` region with a Stop control. The 409-AgentAlreadyRegistered
 * branch re-probes THIS account: registered here → benign "skipped"; otherwise
 * it's a cross-account CONFLICT (never a benign skip) naming PCA #M when the
 * daemon surfaces existingAccountId (B10).
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
  /** S2b renew — prefill the sponsor bulk-paste with the replaced account's agents,
   *  so re-approving the same wallets on the new account is one step. */
  seedBulk?: string;
  /**
   * S2b renew (#1344 gate-HIGH) — the OLD account these seeded wallets are still bound
   * to on-chain. Account EXPIRY does NOT clear `agentToAccountId`, so re-approving a
   * seeded wallet on the new account would revert `AgentAlreadyRegistered`. When set,
   * each row is DEREGISTERED from this old account before being registered on the new
   * one. Its presence also marks the renew re-approval context (honest copy).
   */
  deregisterFrom?: string;
  /** S2b renew — whether the old account's agents loaded (`listPcaAgents`). `false` →
   *  the seed couldn't be pre-filled; the copy stops promising it and prompts manual entry. */
  seedAgentsResolved?: boolean;
  /**
   * B1 self-coverage (§9.5) — set when this is the post-create self-coverage of THIS node's
   * own wallets. Each wallet is binding-probed PER-ROW just before its register: a wallet on a
   * PCA the node OWNS is deregistered-first; a wallet on a PCA the node CAN'T own (a sponsor's)
   * is SKIPPED (already discounted free), never burning a register. Distinct from `deregisterFrom`
   * (renew's single old account) — here the old account varies per wallet.
   */
  selfCoverage?: boolean;
}) {
  const { data: wb } = useFetch(fetchWalletsBalances, [], 0);
  const { data: snapshot } = useFetch(() => fetchPca(accountId), [accountId]);
  const owner = useOwnerActionSubmitter(accountId); // owner-action seam (P0: daemon submitter)
  // S2b renew — the OLD account's owner-action submitter (free the wallet there first).
  // Same daemon submitter in P0; keyed separately for the §9 wallet-owned future.
  const deregisterOwner = useOwnerActionSubmitter(deregisterFrom);
  const nodeWallets = wb?.wallets ?? [];
  const ownerWallet = nodeWallets[0]; // the daemon EOA — what it can deregister-from (B1)
  const agentCount = snapshot?.agentCount ?? 0;
  const cap = Math.max(0, 100 - agentCount);

  const [mode, setMode] = useState<'self' | 'sponsor'>(initialMode);
  const [unchecked, setUnchecked] = useState<Record<string, boolean>>({}); // self: opt-OUT set
  const [bulk, setBulk] = useState(seedBulk ?? ''); // S2b renew prefills the old account's agents
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [order, setOrder] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [aborted, setAborted] = useState<string | null>(null);
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

  const selfSelected = useMemo(
    () => nodeWallets.filter((w) => !unchecked[w]),
    [nodeWallets, unchecked],
  );
  const addresses = mode === 'self' ? selfSelected : parsed.valid;
  const overCap = addresses.length > cap;

  const run = async () => {
    // U1 — do NOT hard-block on the raw count > cap: already-approved-here addresses
    // consume NO slot (resolved per-row as 'skipped' after submit) and the FE can't
    // know that pre-probe. Cap correctness stays via the per-row AgentCapReached
    // handling (the shipped daemon/contract enforce it).
    if (addresses.length === 0) return;
    stopRef.current = false;
    setRunning(true);
    setDone(false);
    setAborted(null);
    setOrder(addresses);
    setRows(Object.fromEntries(addresses.map((a) => [a, { address: a, status: 'pending' as RowStatus }])));

    // W1/U1 — set `current` AND sweep every still-'pending' (not-yet-processed) row to
    // `status` before a loop `break`, so a break never leaves later rows on "approving…".
    const markRemaining = (
      prev: Record<string, Row>,
      current: Row,
      status: RowStatus,
      message?: string,
    ): Record<string, Row> => {
      const next: Record<string, Row> = { ...prev, [current.address]: current };
      for (const a of addresses) {
        if (next[a]?.status === 'pending') next[a] = { address: a, status, message };
      }
      return next;
    };

    for (const addr of addresses) {
      if (stopRef.current) {
        setRows((r) => ({ ...r, [addr]: { address: addr, status: 'error', message: 'stopped' } }));
        continue;
      }
      // M5 — the old PCA we DEREGISTERED this wallet from (set only on a SUCCESSFUL deregister),
      // so a subsequent register failure can be flagged "stranded" (off old, not on new) for retry.
      let strandedFrom: string | null = null;
      try {
        // S2b renew (deregister-first, #1344 gate-HIGH): expiry doesn't clear
        // `agentToAccountId`, so a seeded old-PCA wallet is still bound there and
        // registerAgent(newId) would revert AgentAlreadyRegistered. Free it from the OLD
        // account FIRST. Best-effort — an already-free wallet (AgentNotRegistered) or a
        // transient failure just falls through to the register, whose AgentAlreadyRegistered
        // handling below surfaces a still-bound wallet as a conflict (#old) for recovery.
        if (deregisterFrom) {
          await deregisterOwner.deregisterAgent(deregisterFrom, addr).catch(() => {});
        } else if (selfCoverage && mode === 'self') {
          // H2 (#9 safety) — gate on mode==='self': the mode radios stay enabled, so running this
          // self-coverage logic on THIRD-PARTY (sponsor-mode) addresses would mis-classify them.
          // R5 — the per-wallet classification lives in the planner (walletBinding.ts); this loop
          // just EXECUTES the plan. (Old account varies per wallet, unlike renew's deregisterFrom.)
          const plan = planSelfCoverage(await resolveWalletBinding(addr, ownerWallet));
          if (plan.kind === 'skipSponsored') {
            // Bound to a LIVE sponsor PCA → already discounted free; don't burn a register/conflict.
            setRows((r) => ({
              ...r,
              [addr]: { address: addr, status: 'sponsored', message: `Stays on PCA #${plan.prevAccountId} — already discounted free.` },
            }));
            continue;
          }
          if (plan.kind === 'conflictSponsorDead') {
            // R1 (#9) — bound to an EXPIRED/swept sponsor PCA: NOT covering, and this node can't free
            // it (not the owner). A distinct conflict — NEVER the benign "already discounted free" skip.
            setRows((r) => ({
              ...r,
              [addr]: { address: addr, status: 'conflict', message: `Approved on PCA #${plan.prevAccountId}, but it’s expired/swept (not covering) — ask its owner to deregister you; this node can’t free it.` },
            }));
            continue;
          }
          if (plan.kind === 'deregisterThenRegister') {
            // M5 — record a SUCCESSFUL deregister so a later register failure reads as "stranded"
            // (off old, not on new) with a retry, not a generic error. A FAILED deregister leaves
            // the wallet on old → register conflicts → the B10 handling below recovers it.
            try { await owner.deregisterAgent(plan.prevAccountId, addr); strandedFrom = plan.prevAccountId; }
            catch { /* still bound to old — not stranded; register's conflict path recovers */ }
          }
          // plan.kind === 'register' (unbound / inconclusive) → fall through to register.
        }
        const res = await owner.registerAgent(accountId, addr);
        setRows((r) => ({
          ...r,
          [addr]: { address: addr, status: res.registered ? 'approved' : 'submitted', txHash: res.txHash },
        }));
      } catch (err) {
        // M5 — if we'd already deregistered this wallet off its old PCA, a register failure leaves
        // it off old + not on new (stranded). Tag it so the row offers "retry to finish" instead of
        // a dead-end error. (NOT used for AgentAlreadyRegistered, which means it's still bound.)
        const strandRow = (): Row => ({
          address: addr,
          status: 'stranded',
          message: `Removed from PCA #${strandedFrom}, not yet on #${accountId} — retry to finish.`,
        });
        // 403 → owner-gate failure: abort the WHOLE operation. W1 — sweep the later
        // not-yet-processed rows too, else they stay stuck on "approving…".
        if (err instanceof HttpError && err.status === 403) {
          setAborted(`This node isn’t the owner of PCA #${accountId} — approval aborted.`);
          setRows((r) => markRemaining(r, strandedFrom ? strandRow() : { address: addr, status: 'error', message: 'owner-only' }, 'error', 'aborted'));
          break;
        }
        const info = describePcaError(err, { accountId });
        if (info?.code === 'AgentCapReached') {
          // U1 — mark the current row AND every NOT-YET-processed row 'cap' before the
          // break, else the later rows would stay stuck on 'pending' ("approving…").
          setRows((r) => markRemaining(r, { address: addr, status: 'cap', message: info.message }, 'cap'));
          break;
        }
        if (info?.code === 'AgentAlreadyRegistered') {
          // Resolve the ambiguity: already approved HERE, bound ELSEWHERE, or
          // UNVERIFIABLE? N5/#9 — only assert a cross-account CONFLICT (danger,
          // "deregister there first") when the probe POSITIVELY says not-registered
          // -here with a working adapter. A transient probe failure (null) or a
          // capability gap (adapterSupported===false) is "couldn't verify" — neutral,
          // never a false DANGER pointing at the wrong fix. (A real conflict is still
          // NEVER downgraded to a benign skip.)
          const probe = await fetchPca(accountId, addr).catch(() => null);
          const pk = probe?.probedKey;
          if (pk?.registered === true) {
            setRows((r) => ({
              ...r,
              [addr]: { address: addr, status: 'skipped', message: 'Already an approved publishing wallet here.' },
            }));
          } else if (pk?.registered === false && pk.adapterSupported !== false) {
            // Cross-account conflict — NEVER a benign skip.
            setRows((r) => ({ ...r, [addr]: { address: addr, status: 'conflict', message: info.message } }));
          } else {
            setRows((r) => ({ ...r, [addr]: { address: addr, status: 'unverified' } }));
          }
        } else {
          setRows((r) => ({
            ...r,
            [addr]: strandedFrom ? strandRow() : { address: addr, status: 'error', message: info?.message ?? (err as Error)?.message },
          }));
        }
      }
    }
    setRunning(false);
    setDone(true);
    onApproved?.();
  };

  const counts = useMemo(() => {
    const list = order.map((a) => rows[a]).filter(Boolean);
    return {
      // #9 — confirmed (chain re-read) vs submitted (verify) kept separate so the
      // roll-up never overstates on-chain confirmation.
      confirmed: list.filter((r) => r.status === 'approved').length,
      submitted: list.filter((r) => r.status === 'submitted').length,
      skipped: list.filter((r) => r.status === 'skipped').length,
      sponsored: list.filter((r) => r.status === 'sponsored').length,
      stranded: list.filter((r) => r.status === 'stranded').length,
      conflict: list.filter((r) => r.status === 'conflict').length,
      error: list.filter((r) => r.status === 'error' || r.status === 'cap').length,
      unverified: list.filter((r) => r.status === 'unverified').length,
    };
  }, [order, rows]);

  const approvedWallets = order.filter((a) => {
    const s = rows[a]?.status;
    return s === 'approved' || s === 'submitted';
  });

  const showResults = order.length > 0;

  return (
    <PcaModalShell
      onClose={onClose}
      testId="pca-approve-modal"
      title={`Approve publishing wallets — PCA #${accountId}`}
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
              {agentCount} / 100 slots used — none of YOUR wallets are approved until you do this, so
              your own publishes pay the direct cost.
            </p>
            <div className="v10-pca-approve-checklist">
              {nodeWallets.map((w, i) => (
                <label key={w} className="v10-pca-approve-self-row">
                  <input
                    type="checkbox"
                    checked={!unchecked[w]}
                    onChange={(e) => setUnchecked((u) => ({ ...u, [w]: !e.target.checked }))}
                    disabled={running}
                    aria-label={`Approve ${w}`}
                  />
                  <WalletRow address={w} status={i === 0 ? 'primary signer' : undefined} />
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
              // S2b renew (#1344 [MEDIUM]) — these are the node's OWN carried-over wallets,
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
                Confirm it shows ✓ in the other operator’s Get-sponsored panel.
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
                  status={row.message && (row.status === 'conflict' || row.status === 'error' || row.status === 'sponsored' || row.status === 'stranded') ? row.message : ROW_LABEL[row.status]}
                  statusTone={ROW_TONE[row.status]}
                />
              );
            })}
            {done && (
              <p className="v10-pca-approve-summary">
                Approved {counts.confirmed} confirmed
                {counts.submitted > 0 ? ` · ${counts.submitted} submitted (verify)` : ''}
                {' '}· {counts.skipped} already here · {counts.conflict} conflict
                {counts.sponsored > 0 ? ` · ${counts.sponsored} left on a sponsor’s PCA` : ''}
                {counts.stranded > 0 ? ` · ${counts.stranded} need a retry` : ''}
                {counts.error > 0 ? ` · ${counts.error} failed` : ''}
                {counts.unverified > 0 ? ` · ${counts.unverified} unverified` : ''} (of {order.length}).
              </p>
            )}
          </div>
        )}

        {/* M5 — stranded recovery: a wallet was deregistered from its old PCA but its re-register
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
            OWN wallets (#1344 [MEDIUM]), so the "remind the other operator" handshake is off. */}
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
        <button type="button" className="v10-modal-btn" onClick={onClose}>
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
          // M5 — one-click re-run to finish the stranded migrations. `run()` re-processes the
          // selected wallets; a stranded one is now UNBOUND (we deregistered it) → it registers.
          <button type="button" className="v10-modal-btn primary" data-testid="pca-approve-retry-stranded" onClick={run}>
            Retry to finish
          </button>
        ) : null}
      </div>
    </PcaModalShell>
  );
}
