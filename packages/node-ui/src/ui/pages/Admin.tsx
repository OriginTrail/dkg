import React, { useState, useCallback } from 'react';
import { parseEther } from 'viem';
import { useFetch } from '../hooks.js';
import { useModalDismiss } from '../components/Modals/useModalDismiss.js';
import { formatTrac, formatTracTooltip } from '../lib/formatTrac.js';
import { WalletProvider, useWallet } from '../wallet/WalletContext.js';
import { chainByChainId, chainLabel } from '../wallet/chains.js';
import { publicClientFromProvider, walletClientFromProvider } from '../wallet/clients.js';
import {
  walletRegisterAgent,
  walletDeregisterAgent,
  walletSetPrimaryNode,
  walletTopUp,
  walletCreatePca,
  type WalletCtx,
  type WritePhase,
} from '../wallet/pcaWrites.js';
import {
  fetchCurrentAgent,
  type AgentIdentity,
  // PCA
  fetchPcas,
  fetchPcaInfo,
  fetchPcaContracts,
  type PcaContractContext,
  createPca,
  addPcaFunds,
  settlePca,
  registerPcaAgent,
  deregisterPcaAgent,
  setPcaPrimaryNode,
  type PcaSnapshot,
  // Operational wallets
  fetchOperationalWallets,
  addOperationalWallet,
  removeOperationalWallet,
  type OperationalWallet,
  // Agent keys
  fetchAgentEncryptionKeys,
  rotateAgentEncryptionKey,
  revokeAgentEncryptionKey,
  publishAgentProfile,
  type AgentEncryptionKey,
} from '../api.js';

// ───────────────────────── shared primitives ─────────────────────────

function truncate(addr: string | null | undefined, head = 6, tail = 4): string {
  if (!addr) return '—';
  if (addr.length <= head + tail + 1) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

const errMsg = (e: unknown, fallback = 'Action failed'): string =>
  (e as { message?: string })?.message ?? fallback;

/** Inline write-action state: in-flight flag, persistent error, transient "saved", live phase. */
function useAction() {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [phase, setPhase] = useState<string | null>(null);
  const run = useCallback(
    async (fn: () => Promise<void>, successMsg = 'Done') => {
      setError(null);
      setSaving(true);
      setPhase(null);
      try {
        await fn();
        setSaved(successMsg);
        setTimeout(() => setSaved(null), 2500);
        return true;
      } catch (e) {
        setError(errMsg(e));
        return false;
      } finally {
        setSaving(false);
        setPhase(null);
      }
    },
    [],
  );
  return { saving, error, saved, phase, setPhase, run, setError };
}

function StatusLine({ saved, error, phase }: { saved: string | null; error: string | null; phase?: string | null }) {
  return (
    <span aria-live="polite" style={{ marginLeft: 10 }}>
      {phase && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{phase}</span>}
      {saved && <span style={{ fontSize: 11, color: 'var(--green)', fontWeight: 600 }}>{saved}</span>}
      {error && <span style={{ fontSize: 11, color: 'var(--red)' }}>{error}</span>}
    </span>
  );
}

// ───────────────────────── wallet-connect (PCA owner signing) ─────────────────────────

function buildWalletCtx(
  contracts: PcaContractContext,
  conn: { provider: import('../wallet/eip6963.js').Eip1193Provider; address: `0x${string}` },
): WalletCtx | null {
  const chain = chainByChainId(contracts.chainId);
  if (!chain) return null;
  return {
    walletClient: walletClientFromProvider(chain, conn.provider),
    publicClient: publicClientFromProvider(chain, conn.provider),
    account: conn.address,
    chain,
    nftAddress: contracts.nftAddress as `0x${string}`,
    tokenAddress: contracts.tokenAddress as `0x${string}`,
  };
}

function shortPhase(p: WritePhase): string {
  switch (p) {
    case 'checking-allowance': return 'Checking allowance…';
    case 'signing-approve': return 'Approve TRAC in wallet…';
    case 'mining-approve': return 'Approving TRAC…';
    case 'signing': return 'Confirm in wallet…';
    case 'mining': return 'Submitting…';
  }
}

/**
 * Returns a function that builds a wallet signing context, switching the
 * wallet to the node's chain first if needed. Reads the LIVE connection so an
 * account switch mid-session signs as the current account.
 */
function useEnsureWalletCtx(contracts: PcaContractContext | null) {
  const w = useWallet();
  return useCallback(async (): Promise<WalletCtx> => {
    if (!contracts) throw new Error('Contract addresses unavailable — reload.');
    let conn = w.getConnection();
    if (!conn) throw new Error('Connect your wallet first.');
    if (conn.chainId !== contracts.chainId) {
      await w.switchChain(contracts.chainId);
      conn = w.getConnection();
      if (!conn || conn.chainId !== contracts.chainId) {
        throw new Error(`Switch your wallet to ${chainLabel(contracts.chainId)} and retry.`);
      }
    }
    const ctx = buildWalletCtx(contracts, conn);
    if (!ctx) throw new Error(`Unsupported chain ${contracts.chainId}.`);
    return ctx;
  }, [contracts, w]);
}

function WalletBar({ contracts }: { contracts: PcaContractContext | null }) {
  const w = useWallet();
  const [menu, setMenu] = useState(false);
  const wrongChain = contracts != null && w.chainId != null && w.chainId !== contracts.chainId;

  if (!w.connected) {
    if (w.availableProviders.length === 0) {
      return <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>No browser wallet detected</span>;
    }
    if (w.availableProviders.length === 1) {
      const p = w.availableProviders[0];
      return (
        <button className="dkg-btn-secondary" style={{ fontSize: 11 }} onClick={() => void w.connect(p)}>
          Connect {p.info.name}
        </button>
      );
    }
    return (
      <div style={{ position: 'relative' }}>
        <button className="dkg-btn-secondary" style={{ fontSize: 11 }} onClick={() => setMenu((m) => !m)}>Connect Wallet ▾</button>
        {menu && (
          <div style={{ position: 'absolute', right: 0, top: '110%', zIndex: 20, background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', borderRadius: 6, padding: 4, minWidth: 160 }}>
            {w.availableProviders.map((p) => (
              <button key={p.info.uuid} className="dkg-btn-secondary" style={{ fontSize: 11, display: 'block', width: '100%', textAlign: 'left' }}
                onClick={() => { setMenu(false); void w.connect(p); }}>{p.info.name}</button>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      {wrongChain && (
        <button className="dkg-btn-secondary" style={{ fontSize: 11, color: 'var(--amber)' }}
          onClick={() => contracts && void w.switchChain(contracts.chainId)}>
          Switch to {chainLabel(contracts?.chainId)}
        </button>
      )}
      <span style={{ fontSize: 11, color: 'var(--text-muted)' }} title={w.address ?? ''}>
        {chainLabel(w.chainId)} · <span className="mono">{truncate(w.address, 6, 4)}</span>
      </span>
      <button className="dkg-btn-secondary" style={{ fontSize: 11 }} onClick={() => w.disconnect()}>Disconnect</button>
    </div>
  );
}

function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  const dismiss = useModalDismiss(open, onClose);
  if (!open) return null;
  return (
    <div className="v10-modal-overlay" onClick={dismiss.onBackdropClick} role="presentation">
      <div
        className="v10-modal-box"
        ref={dismiss.dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <button type="button" className="v10-modal-close" onClick={onClose} aria-label="Close" title="Close (Esc)">
          ×
        </button>
        <div className="v10-modal-header">
          <div className="v10-modal-title">{title}</div>
          {subtitle && <div className="v10-modal-subtitle">{subtitle}</div>}
        </div>
        <div className="v10-modal-body">{children}</div>
        <div className="v10-modal-footer">{footer}</div>
      </div>
    </div>
  );
}

function Badge({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'green' | 'amber' | 'blue' }) {
  const colors: Record<string, { fg: string; bg: string }> = {
    neutral: { fg: 'var(--text-muted)', bg: 'var(--bg-elevated)' },
    green: { fg: 'var(--green)', bg: 'var(--green-dim)' },
    amber: { fg: 'var(--amber)', bg: 'var(--amber-dim)' },
    blue: { fg: 'var(--accent-blue)', bg: 'var(--bg-elevated)' },
  };
  const c = colors[tone] ?? colors.neutral;
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 600,
        color: c.fg,
        background: c.bg,
        borderRadius: 4,
        padding: '1px 6px',
        marginLeft: 6,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

const inputStyle: React.CSSProperties = { fontFamily: 'var(--font-mono)' };

// ───────────────────────── operational wallets ─────────────────────────

function OperationalWalletsSection() {
  const { data, loading, error, refresh } = useFetch(fetchOperationalWallets, [], 30_000);
  const action = useAction();
  const [showAdd, setShowAdd] = useState(false);
  const [addAddr, setAddAddr] = useState('');
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);

  const canManage = data?.canManage ?? false;

  const onAdd = async () => {
    const ok = await action.run(async () => {
      await addOperationalWallet(addAddr.trim());
      refresh();
    }, 'Wallet authorized');
    if (ok) {
      setShowAdd(false);
      setAddAddr('');
    }
  };

  const onRemove = async (address: string) => {
    const ok = await action.run(async () => {
      await removeOperationalWallet(address);
      refresh();
    }, 'Wallet removed');
    if (ok) setRemoveTarget(null);
  };

  return (
    <section className="card">
      <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 className="card-title">Operational Wallets</h2>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <StatusLine saved={action.saved} error={action.error} />
          <button
            className="dkg-btn"
            disabled={!canManage || action.saving}
            title={canManage ? 'Authorize a new operational wallet' : 'Requires an admin key and an on-chain profile'}
            onClick={() => {
              action.setError(null);
              setShowAdd(true);
            }}
            style={{ marginLeft: 10 }}
          >
            Authorize Wallet
          </button>
        </div>
      </div>
      <div className="card-body">
        <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 0 }}>
          Wallets the node holds locally and their on-chain authorization status. Add/remove require the
          node&apos;s admin key (in <span className="mono">~/.dkg/wallets.json</span>) and an on-chain profile.
        </p>

        {loading && !data && <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>}
        {error && <div style={{ color: 'var(--red)', fontSize: 12 }}>{error}</div>}

        {data && (
          <>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>
              Identity: <span className="mono">{data.hasProfile ? `#${data.identityId}` : 'no on-chain profile'}</span>
              {!data.adminKeyConfigured && <Badge tone="amber">no admin key — read-only</Badge>}
              {data.adminKeyConfigured && !data.hasProfile && <Badge tone="amber">no profile</Badge>}
            </div>
            {data.wallets.length === 0 && (
              <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No operational wallets configured.</div>
            )}
            {data.wallets.map((w: OperationalWallet) => (
              <div
                key={w.address}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '8px 0',
                  borderBottom: '1px solid var(--border-subtle)',
                }}
              >
                <div>
                  <span className="mono" style={{ fontSize: 12 }} title={w.address}>
                    {truncate(w.address, 10, 8)}
                  </span>
                  {w.isPrimary && <Badge tone="blue">primary</Badge>}
                  {w.isAdmin && <Badge tone="blue">admin</Badge>}
                  {w.registered === true && <Badge tone="green">on-chain ✓</Badge>}
                  {w.registered === false && <Badge tone="amber">not registered</Badge>}
                  {w.registered === null && <Badge>status unknown</Badge>}
                </div>
                <button
                  className="dkg-btn-secondary"
                  disabled={!canManage || w.isPrimary || action.saving}
                  title={w.isPrimary ? 'The primary wallet anchors identity resolution and cannot be removed' : 'Remove this operational wallet'}
                  onClick={() => {
                    action.setError(null);
                    setRemoveTarget(w.address);
                  }}
                  style={{ fontSize: 11 }}
                >
                  Remove
                </button>
              </div>
            ))}
          </>
        )}
      </div>

      <Modal
        open={showAdd}
        onClose={() => setShowAdd(false)}
        title="Authorize Operational Wallet"
        subtitle="Registers the address as an operational key on this node's on-chain identity (admin-signed)."
        footer={
          <>
            <button className="v10-modal-btn" onClick={() => setShowAdd(false)}>
              Cancel
            </button>
            <button
              className="v10-modal-btn primary"
              disabled={!addAddr.trim() || action.saving}
              onClick={onAdd}
            >
              {action.saving ? 'Authorizing…' : 'Authorize'}
            </button>
          </>
        }
      >
        {action.error && <div className="v10-modal-error">{action.error}</div>}
        <div className="v10-form-group">
          <label className="v10-form-label" htmlFor="opw-addr">Wallet Address</label>
          <input
            id="opw-addr"
            className="v10-form-input"
            style={inputStyle}
            type="text"
            value={addAddr}
            onChange={(e) => setAddAddr(e.target.value)}
            placeholder="0x…"
            autoFocus
            autoComplete="off"
          />
        </div>
      </Modal>

      <Modal
        open={removeTarget !== null}
        onClose={() => setRemoveTarget(null)}
        title="Remove Operational Wallet?"
        subtitle="De-authorizes the key on-chain (admin-signed). This cannot be undone here — re-authorize to restore."
        footer={
          <>
            <button className="v10-modal-btn" onClick={() => setRemoveTarget(null)}>
              Cancel
            </button>
            <button
              className="v10-modal-btn primary"
              disabled={action.saving}
              onClick={() => removeTarget && onRemove(removeTarget)}
            >
              {action.saving ? 'Removing…' : 'Remove Wallet'}
            </button>
          </>
        }
      >
        {action.error && <div className="v10-modal-error">{action.error}</div>}
        <div className="mono" style={{ fontSize: 12 }}>{removeTarget}</div>
      </Modal>
    </section>
  );
}

// ───────────────────────── agent encryption keys ─────────────────────────

function AgentKeysSection({ identity }: { identity: AgentIdentity | null }) {
  const address = identity?.agentAddress ?? null;
  const { data, loading, error, refresh } = useFetch(
    () => (address ? fetchAgentEncryptionKeys(address) : Promise.resolve(null)),
    [address],
  );
  const action = useAction();
  const [showRotate, setShowRotate] = useState(false);
  const [retireOld, setRetireOld] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<AgentEncryptionKey | null>(null);
  const [profileWarning, setProfileWarning] = useState<string | null>(null);

  const onRotate = async () => {
    const ok = await action.run(async () => {
      if (!address) throw new Error('No agent address');
      const r = await rotateAgentEncryptionKey(address, retireOld);
      setProfileWarning(r.profilePublished ? null : (r.profilePublishError ?? 'Profile re-publish failed — peers may still use the old key.'));
      refresh();
    }, 'Key rotated');
    if (ok) {
      setShowRotate(false);
      setRetireOld(false);
    }
  };

  const onRevoke = async (keyId: string) => {
    const ok = await action.run(async () => {
      if (!address) throw new Error('No agent address');
      const r = await revokeAgentEncryptionKey(address, keyId);
      setProfileWarning(r.profilePublished ? null : (r.profilePublishError ?? 'Profile re-publish failed — peers may still encrypt to the revoked key.'));
      refresh();
    }, 'Key revoked');
    if (ok) setRevokeTarget(null);
  };

  const onRepublish = () =>
    action.run(async () => {
      await publishAgentProfile();
      setProfileWarning(null);
    }, 'Profile re-published');

  const activeCount = (data?.keys ?? []).filter((k) => k.status === 'active').length;

  return (
    <section className="card">
      <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 className="card-title">Agent Encryption Keys</h2>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <StatusLine saved={action.saved} error={action.error} />
          <button
            className="dkg-btn"
            disabled={!address || action.saving}
            onClick={() => {
              action.setError(null);
              setShowRotate(true);
            }}
            style={{ marginLeft: 10 }}
          >
            Rotate Key
          </button>
        </div>
      </div>
      <div className="card-body">
        <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 0 }}>
          Workspace encryption keys for this node&apos;s default agent (used for shared/private memory). Rotating mints
          a fresh key and re-publishes the profile so peers learn it.
        </p>
        {identity && (
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>
            Agent: <span className="mono" title={identity.agentAddress}>{truncate(identity.agentAddress, 10, 8)}</span>
          </div>
        )}

        {profileWarning && (
          <div className="v10-modal-warning" style={{ marginBottom: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
            <span>{profileWarning}</span>
            <button className="dkg-btn-secondary" disabled={action.saving} onClick={onRepublish} style={{ fontSize: 11 }}>
              Re-publish profile
            </button>
          </div>
        )}

        {loading && !data && <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>}
        {error && <div style={{ color: 'var(--red)', fontSize: 12 }}>{error}</div>}
        {data && data.keys.length === 0 && (
          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No encryption keys found.</div>
        )}
        {data?.keys.map((k) => (
          <div
            key={k.encryptionKeyId}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '8px 0',
              borderBottom: '1px solid var(--border-subtle)',
            }}
          >
            <div>
              <span className="mono" style={{ fontSize: 11 }} title={k.encryptionKeyId}>
                {truncate(k.encryptionKeyId, 28, 8)}
              </span>
              {k.status === 'active' ? <Badge tone="green">active</Badge> : <Badge tone="amber">revoked</Badge>}
              <span style={{ fontSize: 10, color: 'var(--text-dim)', marginLeft: 8 }}>{k.encryptionKeyAlgorithm}</span>
            </div>
            {k.status === 'active' && (
              <button
                className="dkg-btn-secondary"
                disabled={action.saving || activeCount <= 1}
                title={activeCount <= 1 ? 'Cannot revoke the last active key — rotate first' : 'Revoke this key'}
                onClick={() => {
                  action.setError(null);
                  setRevokeTarget(k);
                }}
                style={{ fontSize: 11 }}
              >
                Revoke
              </button>
            )}
          </div>
        ))}
      </div>

      <Modal
        open={showRotate}
        onClose={() => setShowRotate(false)}
        title="Rotate Encryption Key"
        subtitle="Mints a new workspace key and re-publishes the agent profile."
        footer={
          <>
            <button className="v10-modal-btn" onClick={() => setShowRotate(false)}>Cancel</button>
            <button className="v10-modal-btn primary" disabled={action.saving} onClick={onRotate}>
              {action.saving ? 'Rotating…' : 'Rotate Key'}
            </button>
          </>
        }
      >
        {action.error && <div className="v10-modal-error">{action.error}</div>}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <input type="checkbox" checked={retireOld} onChange={(e) => setRetireOld(e.target.checked)} />
          Also retire the previous key now (only after propagation has settled, or for compromise)
        </label>
      </Modal>

      <Modal
        open={revokeTarget !== null}
        onClose={() => setRevokeTarget(null)}
        title="Revoke Encryption Key?"
        subtitle="Peers keep encrypting to this key until the profile re-publishes. This cannot be undone."
        footer={
          <>
            <button className="v10-modal-btn" onClick={() => setRevokeTarget(null)}>Cancel</button>
            <button
              className="v10-modal-btn primary"
              disabled={action.saving}
              onClick={() => revokeTarget && onRevoke(revokeTarget.encryptionKeyId)}
            >
              {action.saving ? 'Revoking…' : 'Revoke Key'}
            </button>
          </>
        }
      >
        {action.error && <div className="v10-modal-error">{action.error}</div>}
        <div className="mono" style={{ fontSize: 11 }}>{revokeTarget?.encryptionKeyId}</div>
      </Modal>
    </section>
  );
}

// ───────────────────────── PCAs ─────────────────────────

function PcaCard({
  pca,
  contracts,
  onChanged,
}: {
  pca: PcaSnapshot;
  contracts: PcaContractContext | null;
  onChanged: () => void;
}) {
  const action = useAction();
  const w = useWallet();
  const [modal, setModal] = useState<null | 'funds' | 'addAgent' | 'removeAgent' | 'primaryNode' | 'settle'>(null);
  const [tokens, setTokens] = useState('');
  const [agentAddr, setAgentAddr] = useState('');
  const [node, setNode] = useState('');

  const close = () => {
    setModal(null);
    setTokens('');
    setAgentAddr('');
    setNode('');
  };

  const expired = pca.expiresAtTimestamp > 0 && pca.expiresAtTimestamp * 1000 < Date.now();
  // Two ways to manage a PCA: the node's server key owns it (server-signed), OR
  // the CONNECTED wallet owns it (client-signed). `owned` is false only for
  // looked-up cross-owner PCAs; absent ⇒ node-owned (back-compat).
  const nodeOwns = pca.owned !== false;
  const walletOwns = w.connected && w.address != null && w.address.toLowerCase() === pca.owner.toLowerCase();
  const canManage = nodeOwns || walletOwns;
  const useWalletPath = !nodeOwns && walletOwns; // external PCA we own via the connected wallet
  const ownerGatedTitle = canManage
    ? (useWalletPath ? 'Signed by your connected wallet' : undefined)
    : `Owned by ${truncate(pca.owner, 8, 6)} — connect that wallet to manage it`;

  const ensureWalletReady = useEnsureWalletCtx(contracts);

  // Run an owner-gated action via the right path (server vs connected wallet).
  const exec = (
    serverFn: () => Promise<unknown>,
    walletFn: (ctx: WalletCtx, onPhase: (p: WritePhase) => void) => Promise<unknown>,
    successMsg: string,
  ) =>
    action.run(async () => {
      if (useWalletPath) {
        const ctx = await ensureWalletReady();
        await walletFn(ctx, (p) => action.setPhase(shortPhase(p)));
      } else {
        await serverFn();
      }
      onChanged();
    }, successMsg);

  return (
    <div style={{ border: '1px solid var(--border-default)', borderRadius: 6, padding: 12, marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div>
          <span style={{ fontWeight: 600 }}>PCA #{pca.accountId}</span>
          {pca.fundsThisNode && <Badge tone="green">funds this node</Badge>}
          {useWalletPath && <Badge tone="blue">wallet-managed</Badge>}
          {!canManage && <Badge tone="amber">owned elsewhere</Badge>}
          {expired && <Badge tone="amber">expired</Badge>}
        </div>
        <StatusLine saved={action.saved} error={action.error} phase={action.phase} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 16px', fontSize: 12, marginTop: 8 }}>
        <span style={{ color: 'var(--text-muted)' }}>Committed</span>
        <span className="mono" title={formatTracTooltip(pca.committedTRACTrac)}>{formatTrac(pca.committedTRACTrac)} TRAC</span>
        <span style={{ color: 'var(--text-muted)' }}>Top-up buffer</span>
        <span className="mono" title={formatTracTooltip(pca.topUpBufferTrac)}>{formatTrac(pca.topUpBufferTrac)} TRAC</span>
        <span style={{ color: 'var(--text-muted)' }}>Discount</span>
        <span>{(pca.discountBps / 100).toFixed(pca.discountBps % 100 ? 2 : 0)}%</span>
        <span style={{ color: 'var(--text-muted)' }}>Agents</span>
        <span>{pca.agentCount}</span>
        <span style={{ color: 'var(--text-muted)' }}>Expires (epoch)</span>
        <span>{pca.expiresAtEpoch}</span>
        <span style={{ color: 'var(--text-muted)' }}>Primary node</span>
        <span className="mono">{pca.primaryNode && pca.primaryNode !== '0' ? `#${pca.primaryNode}` : 'none'}</span>
        <span style={{ color: 'var(--text-muted)' }}>Owner</span>
        <span className="mono" title={pca.owner}>{truncate(pca.owner, 10, 8)}</span>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <button className="dkg-btn-secondary" style={{ fontSize: 11 }} disabled={!canManage || action.saving} title={ownerGatedTitle} onClick={() => { action.setError(null); setModal('funds'); }}>Top up</button>
        <button className="dkg-btn-secondary" style={{ fontSize: 11 }} disabled={!canManage || action.saving} title={ownerGatedTitle} onClick={() => { action.setError(null); setModal('addAgent'); }}>Add agent</button>
        <button className="dkg-btn-secondary" style={{ fontSize: 11 }} disabled={!canManage || action.saving} title={ownerGatedTitle} onClick={() => { action.setError(null); setModal('removeAgent'); }}>Remove agent</button>
        <button className="dkg-btn-secondary" style={{ fontSize: 11 }} disabled={!canManage || action.saving} title={ownerGatedTitle} onClick={() => { action.setError(null); setModal('primaryNode'); }}>Set primary node</button>
        <button className="dkg-btn-secondary" style={{ fontSize: 11 }} onClick={() => { action.setError(null); setModal('settle'); }}>Settle</button>
      </div>

      <Modal
        open={modal === 'funds'}
        onClose={close}
        title={`Top up PCA #${pca.accountId}`}
        subtitle="Adds TRAC to the account's top-up buffer (owner-gated)."
        footer={
          <>
            <button className="v10-modal-btn" onClick={close}>Cancel</button>
            <button className="v10-modal-btn primary" disabled={!tokens.trim() || action.saving} onClick={async () => {
              if (await exec(
                () => addPcaFunds(pca.accountId, tokens.trim()),
                (ctx, onPhase) => walletTopUp(ctx, BigInt(pca.accountId), parseEther(tokens.trim()), onPhase),
                'Topped up',
              )) close();
            }}>{action.saving ? (action.phase ?? 'Topping up…') : 'Top up'}</button>
          </>
        }
      >
        {action.error && <div className="v10-modal-error">{action.error}</div>}
        <div className="v10-form-group">
          <label className="v10-form-label" htmlFor={`funds-${pca.accountId}`}>TRAC amount</label>
          <input id={`funds-${pca.accountId}`} className="v10-form-input" style={inputStyle} inputMode="decimal" value={tokens} onChange={(e) => setTokens(e.target.value)} placeholder="50000" autoFocus autoComplete="off" />
        </div>
      </Modal>

      <Modal
        open={modal === 'addAgent'}
        onClose={close}
        title={`Add agent to PCA #${pca.accountId}`}
        subtitle="Authorize a wallet to publish against this PCA's funds (owner-gated)."
        footer={
          <>
            <button className="v10-modal-btn" onClick={close}>Cancel</button>
            <button className="v10-modal-btn primary" disabled={!agentAddr.trim() || action.saving} onClick={async () => {
              if (await exec(
                () => registerPcaAgent(pca.accountId, agentAddr.trim()),
                (ctx, onPhase) => walletRegisterAgent(ctx, BigInt(pca.accountId), agentAddr.trim() as `0x${string}`, onPhase),
                'Agent added',
              )) close();
            }}>{action.saving ? (action.phase ?? 'Adding…') : 'Add agent'}</button>
          </>
        }
      >
        {action.error && <div className="v10-modal-error">{action.error}</div>}
        <div className="v10-form-group">
          <label className="v10-form-label" htmlFor={`addagent-${pca.accountId}`}>Agent wallet address</label>
          <input id={`addagent-${pca.accountId}`} className="v10-form-input" style={inputStyle} value={agentAddr} onChange={(e) => setAgentAddr(e.target.value)} placeholder="0x…" autoFocus autoComplete="off" />
        </div>
      </Modal>

      <Modal
        open={modal === 'removeAgent'}
        onClose={close}
        title={`Remove agent from PCA #${pca.accountId}`}
        subtitle="De-authorize a publishing agent wallet (owner-gated)."
        footer={
          <>
            <button className="v10-modal-btn" onClick={close}>Cancel</button>
            <button className="v10-modal-btn primary" disabled={!agentAddr.trim() || action.saving} onClick={async () => {
              if (await exec(
                () => deregisterPcaAgent(pca.accountId, agentAddr.trim()),
                (ctx, onPhase) => walletDeregisterAgent(ctx, BigInt(pca.accountId), agentAddr.trim() as `0x${string}`, onPhase),
                'Agent removed',
              )) close();
            }}>{action.saving ? (action.phase ?? 'Removing…') : 'Remove agent'}</button>
          </>
        }
      >
        {action.error && <div className="v10-modal-error">{action.error}</div>}
        <div className="v10-form-group">
          <label className="v10-form-label" htmlFor={`rmagent-${pca.accountId}`}>Agent wallet address</label>
          <input id={`rmagent-${pca.accountId}`} className="v10-form-input" style={inputStyle} value={agentAddr} onChange={(e) => setAgentAddr(e.target.value)} placeholder="0x…" autoFocus autoComplete="off" />
        </div>
      </Modal>

      <Modal
        open={modal === 'primaryNode'}
        onClose={close}
        title={`Re-designate primary node — PCA #${pca.accountId}`}
        subtitle="OT-RFC-51: moves future-epoch publishing allocation to a new node. Rate-limited to once per epoch."
        footer={
          <>
            <button className="v10-modal-btn" onClick={close}>Cancel</button>
            <button className="v10-modal-btn primary" disabled={!node.trim() || action.saving} onClick={async () => {
              if (await exec(
                () => setPcaPrimaryNode(pca.accountId, node.trim()),
                (ctx, onPhase) => walletSetPrimaryNode(ctx, BigInt(pca.accountId), BigInt(node.trim()), onPhase),
                'Primary node set',
              )) close();
            }}>{action.saving ? (action.phase ?? 'Setting…') : 'Set primary node'}</button>
          </>
        }
      >
        {action.error && <div className="v10-modal-error">{action.error}</div>}
        <div className="v10-form-group">
          <label className="v10-form-label" htmlFor={`node-${pca.accountId}`}>Node identityId</label>
          <input id={`node-${pca.accountId}`} className="v10-form-input" style={inputStyle} inputMode="numeric" value={node} onChange={(e) => setNode(e.target.value)} placeholder="42" autoFocus autoComplete="off" />
        </div>
      </Modal>

      <Modal
        open={modal === 'settle'}
        onClose={close}
        title={`Settle PCA #${pca.accountId}?`}
        subtitle="Runs the lazy-settlement sweep (permissionless). Safe to run anytime."
        footer={
          <>
            <button className="v10-modal-btn" onClick={close}>Cancel</button>
            <button className="v10-modal-btn primary" disabled={action.saving} onClick={async () => {
              if (await action.run(async () => { await settlePca(pca.accountId); onChanged(); }, 'Settled')) close();
            }}>{action.saving ? 'Settling…' : 'Settle'}</button>
          </>
        }
      >
        {action.error && <div className="v10-modal-error">{action.error}</div>}
        <div style={{ fontSize: 13 }}>Sweep elapsed billing windows for this account.</div>
      </Modal>
    </div>
  );
}

function PcaSection({ identity }: { identity: AgentIdentity | null }) {
  const { data, loading, error, refresh } = useFetch(fetchPcas, [], 30_000);
  const { data: contracts } = useFetch(fetchPcaContracts, [], 0);
  const w = useWallet();
  const ensureCtx = useEnsureWalletCtx(contracts ?? null);
  const action = useAction();
  const [showCreate, setShowCreate] = useState(false);
  const [tokens, setTokens] = useState('');
  const [node, setNode] = useState('');
  const [lookupId, setLookupId] = useState('');
  const [looked, setLooked] = useState<PcaSnapshot | null>(null);
  const [lookupErr, setLookupErr] = useState<string | null>(null);

  const defaultNode = identity?.nodeIdentityId && identity.nodeIdentityId !== '0' ? identity.nodeIdentityId : '';

  const onCreate = async () => {
    const ok = await action.run(async () => {
      const nodeId = (node || defaultNode).trim();
      if (w.connected) {
        // Wallet-signed → the new PCA is owned by the connected wallet.
        const ctx = await ensureCtx();
        await walletCreatePca(ctx, parseEther(tokens.trim()), BigInt(nodeId), (p) => action.setPhase(shortPhase(p)));
      } else {
        // Server-signed → owned by the node's operational wallet.
        await createPca(tokens.trim(), nodeId);
      }
      refresh();
    }, 'PCA created');
    if (ok) {
      setShowCreate(false);
      setTokens('');
      setNode('');
    }
  };

  const onLookup = async () => {
    setLookupErr(null);
    setLooked(null);
    try {
      const info = await fetchPcaInfo(lookupId.trim());
      setLooked(info);
    } catch (e) {
      setLookupErr(errMsg(e, 'Not found'));
    }
  };

  return (
    <section className="card">
      <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h2 className="card-title">Publishing Conviction Accounts</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <WalletBar contracts={contracts ?? null} />
          <StatusLine saved={action.saved} error={action.error} phase={action.phase} />
          <button
            className="dkg-btn"
            disabled={action.saving}
            onClick={() => {
              action.setError(null);
              setNode(defaultNode);
              setShowCreate(true);
            }}
          >
            Create PCA
          </button>
        </div>
      </div>
      <div className="card-body">
        <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 0 }}>
          PCAs owned by this node&apos;s wallet, with their OT-RFC-51 node association. A PCA&apos;s committed TRAC funds
          a designated node&apos;s publishing allocation and discounts its agents&apos; publishes.
          {' '}<strong>Connect a wallet</strong> to manage a PCA owned by an external wallet (it signs the owner-gated txs directly).
        </p>

        {loading && !data && <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>}
        {error && <div style={{ color: 'var(--red)', fontSize: 12 }}>{error}</div>}
        {data && data.accounts.length === 0 && (
          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>This node owns no PCAs. Create one, or look one up by id below.</div>
        )}
        {data?.accounts.map((p) => (
          <PcaCard key={p.accountId} pca={p} contracts={contracts ?? null} onChanged={refresh} />
        ))}

        <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border-subtle)' }}>
          <div className="settings-field-label">Look up a PCA by account id</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
            <input className="input" style={{ ...inputStyle, maxWidth: 180 }} inputMode="numeric" value={lookupId} onChange={(e) => setLookupId(e.target.value)} placeholder="accountId" />
            <button className="dkg-btn-secondary" style={{ fontSize: 11 }} disabled={!lookupId.trim()} onClick={onLookup}>Look up</button>
          </div>
          {lookupErr && <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 6 }}>{lookupErr}</div>}
          {looked && <div style={{ marginTop: 10 }}><PcaCard pca={looked} contracts={contracts ?? null} onChanged={onLookup} /></div>}
        </div>
      </div>

      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="Create Publishing Conviction Account"
        subtitle="Locks committed TRAC to fund a node's publishing allocation. The primary node is required."
        footer={
          <>
            <button className="v10-modal-btn" onClick={() => setShowCreate(false)}>Cancel</button>
            <button className="v10-modal-btn primary" disabled={!tokens.trim() || !(node || defaultNode).trim() || action.saving} onClick={onCreate}>
              {action.saving ? (action.phase ?? 'Creating…') : 'Create PCA'}
            </button>
          </>
        }
      >
        {action.error && <div className="v10-modal-error">{action.error}</div>}
        <div className="v10-modal-tip" style={{ marginBottom: 10 }}>
          {w.connected
            ? <>Signed by your connected wallet — the new PCA will be owned by <span className="mono">{truncate(w.address, 6, 4)}</span>. Requires TRAC in that wallet.</>
            : <>Signed by this node&apos;s wallet — the new PCA will be node-owned and managed server-side.</>}
        </div>
        <div className="v10-form-group">
          <label className="v10-form-label" htmlFor="create-tokens">Committed TRAC</label>
          <input id="create-tokens" className="v10-form-input" style={inputStyle} inputMode="decimal" value={tokens} onChange={(e) => setTokens(e.target.value)} placeholder="100000" autoFocus autoComplete="off" />
        </div>
        <div className="v10-form-group">
          <label className="v10-form-label" htmlFor="create-node">Primary node identityId</label>
          <input id="create-node" className="v10-form-input" style={inputStyle} inputMode="numeric" value={node} onChange={(e) => setNode(e.target.value)} placeholder={defaultNode || 'node identityId'} autoComplete="off" />
          {defaultNode && <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4 }}>Defaults to this node (#{defaultNode}).</div>}
        </div>
      </Modal>
    </section>
  );
}

// ───────────────────────── page ─────────────────────────

export function AdminPage() {
  const { data: identity } = useFetch(fetchCurrentAgent, [], 0);

  return (
    <WalletProvider>
      <div className="page-section">
        <div style={{ marginBottom: 20 }}>
          <h1 className="page-title" style={{ marginBottom: 0 }}>Admin</h1>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
            Manage node keys, operational wallets, and Publishing Conviction Accounts. Node-owned actions are signed by
            the node&apos;s wallets; connect a browser wallet to manage PCAs you own externally.
          </p>
        </div>
        <div className="settings-stack">
          <OperationalWalletsSection />
          <PcaSection identity={identity ?? null} />
          <AgentKeysSection identity={identity ?? null} />
        </div>
      </div>
    </WalletProvider>
  );
}
