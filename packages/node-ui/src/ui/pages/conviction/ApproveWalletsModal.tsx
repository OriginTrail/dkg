import React, { useMemo, useRef, useState } from 'react';
import { useFetch } from '../../hooks.js';
import {
  fetchWalletsBalances,
  fetchPca,
  pcaAddAgent,
  describePcaError,
  HttpError,
} from '../../api.js';
import { PcaModalShell } from './PcaModalShell.js';
import {
  AddressCrux,
  WalletRow,
  SponsorshipHandshake,
  CopyButton,
  type WalletRowTone,
} from '../../components/Pca/index.js';

type RowStatus = 'pending' | 'approved' | 'submitted' | 'skipped' | 'conflict' | 'cap' | 'error' | 'unverified';
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
}: {
  accountId: string;
  initialMode?: 'self' | 'sponsor';
  onClose: () => void;
  onApproved?: () => void;
}) {
  const { data: wb } = useFetch(fetchWalletsBalances, [], 0);
  const { data: snapshot } = useFetch(() => fetchPca(accountId), [accountId]);
  const nodeWallets = wb?.wallets ?? [];
  const agentCount = snapshot?.agentCount ?? 0;
  const cap = Math.max(0, 100 - agentCount);

  const [mode, setMode] = useState<'self' | 'sponsor'>(initialMode);
  const [unchecked, setUnchecked] = useState<Record<string, boolean>>({}); // self: opt-OUT set
  const [bulk, setBulk] = useState('');
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
    if (addresses.length === 0 || overCap) return;
    stopRef.current = false;
    setRunning(true);
    setDone(false);
    setAborted(null);
    setOrder(addresses);
    setRows(Object.fromEntries(addresses.map((a) => [a, { address: a, status: 'pending' as RowStatus }])));

    for (const addr of addresses) {
      if (stopRef.current) {
        setRows((r) => ({ ...r, [addr]: { address: addr, status: 'error', message: 'stopped' } }));
        continue;
      }
      try {
        const res = await pcaAddAgent(accountId, addr);
        setRows((r) => ({
          ...r,
          [addr]: { address: addr, status: res.registered ? 'approved' : 'submitted', txHash: res.txHash },
        }));
      } catch (err) {
        // 403 → owner-gate failure: abort the WHOLE operation.
        if (err instanceof HttpError && err.status === 403) {
          setAborted(`This node isn’t the owner of PCA #${accountId} — approval aborted.`);
          setRows((r) => ({ ...r, [addr]: { address: addr, status: 'error', message: 'owner-only' } }));
          break;
        }
        const info = describePcaError(err, { accountId });
        if (info?.code === 'AgentCapReached') {
          setRows((r) => ({ ...r, [addr]: { address: addr, status: 'cap', message: info.message } }));
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
            [addr]: { address: addr, status: 'error', message: info?.message ?? (err as Error)?.message },
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
            <div className="v10-modal-warning">
              ⚠ We can only check the address is well-formed — we can’t verify it’s the node’s real
              signing wallet. A typo / admin / author address still “approves” and burns a cap slot.
              Confirm it shows ✓ in the other operator’s Get-sponsored panel.
            </div>
          </section>
        )}

        {overCap && (
          <div className="v10-modal-warning" role="alert">
            ⚠ {addresses.length} wallets exceeds the {cap} remaining slots on this account. Remove some
            or deregister existing wallets first.
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
                  status={row.message && (row.status === 'conflict' || row.status === 'error') ? row.message : ROW_LABEL[row.status]}
                  statusTone={ROW_TONE[row.status]}
                />
              );
            })}
            {done && (
              <p className="v10-pca-approve-summary">
                Approved {counts.confirmed} confirmed
                {counts.submitted > 0 ? ` · ${counts.submitted} submitted (verify)` : ''}
                {' '}· {counts.skipped} already here · {counts.conflict} conflict
                {counts.error > 0 ? ` · ${counts.error} failed` : ''}
                {counts.unverified > 0 ? ` · ${counts.unverified} unverified` : ''} (of {order.length}).
              </p>
            )}
          </div>
        )}

        {/* Sponsor handoff after a run */}
        {done && mode === 'sponsor' && (
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
            disabled={addresses.length === 0 || overCap}
          >
            Approve {addresses.length} wallet{addresses.length === 1 ? '' : 's'}
          </button>
        ) : null}
      </div>
    </PcaModalShell>
  );
}
