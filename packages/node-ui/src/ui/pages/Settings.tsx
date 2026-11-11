import React, { useState, useCallback, useEffect } from 'react';
import { useFetch, formatBytes } from '../hooks.js';
import {
  fetchWalletsBalances,
  shutdownNode,
  fetchMetrics,
  fetchRetentionSettings,
  updateRetentionSettings,
  fetchTelemetrySettings,
  updateTelemetrySettings,
} from '../api.js';
import { formatEth, formatEthTooltip } from '../lib/formatEth.js';
import { formatTracSymbol, formatTrac, formatTracTooltip } from '../lib/formatTrac.js';
import { redactRpcUrl } from '../lib/redactRpcUrl.js';
import { formatUptime } from '../lib/formatPeerStatus.js';
import { useNodeState } from '../hooks/useNodeState.js';
import { Badge } from '../components/ds/Badge.js';
import { PcaSettingsCard } from './conviction/PcaSettingsCard.js';
import { IdentityWalletsSection } from './identity-wallets/IdentityWalletsSection.js';

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div className="settings-field-label">{label}</div>
      <div className={`settings-field-value${mono ? ' mono' : ''}`}>{value}</div>
    </div>
  );
}

function RpcUrlField({ rpcUrl }: { rpcUrl: string }) {
  const [reveal, setReveal] = useState(false);
  // Always redact on first render — operators frequently screen-share
  // Settings without realising the path-token segment is a tenant
  // secret (BUG-012). Exposing the full URL requires an explicit click,
  // and we never persist that choice across renders.
  const display = reveal ? rpcUrl : redactRpcUrl(rpcUrl);
  return (
    <div style={{ marginBottom: 14 }}>
      <div className="settings-field-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span>RPC</span>
        <button
          type="button"
          onClick={() => setReveal((v) => !v)}
          style={{ background: 'none', border: '1px solid var(--border-default)', color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: 'var(--fs-micro)', fontWeight: 600, padding: '1px 6px', borderRadius: 'var(--radius-xs)' }}
          aria-label={reveal ? 'Redact RPC URL' : 'Reveal RPC URL'}
          title={reveal ? 'Hide the path-token (recommended for screen-shares)' : 'Show full URL — careful, may contain a tenant secret'}
        >
          {reveal ? 'Redact' : 'Reveal'}
        </button>
      </div>
      <div className="settings-field-value mono" style={{ wordBreak: 'break-all' }}>{display}</div>
    </div>
  );
}

function NetworkTelemetrySection() {
  const { data: telemetryData } = useFetch(fetchTelemetrySettings, [], 60_000);

  const [telemetryEnabled, setTelemetryEnabled] = useState(false);
  const [telemetrySaving, setTelemetrySaving] = useState(false);
  const [telemetryError, setTelemetryError] = useState<string | null>(null);
  const [showConsentModal, setShowConsentModal] = useState(false);
  const modalRef = React.useRef<HTMLDivElement>(null);
  const toggleRef = React.useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (telemetryData != null) setTelemetryEnabled(telemetryData.enabled);
  }, [telemetryData]);

  const toggleTelemetry = useCallback(() => {
    // Guard in the handler rather than `disabled` so the toggle stays
    // focusable — confirmTelemetry's finally restores focus here, which a
    // `disabled` button (removed from the tab order) would silently no-op
    // (Codex). aria-busy conveys the in-flight state to assistive tech.
    if (telemetrySaving) return;
    setTelemetryError(null);
    if (telemetryEnabled) {
      // Turning OFF — no confirmation needed.
      setTelemetryEnabled(false);
      setTelemetrySaving(true);
      updateTelemetrySettings(false)
        .catch(() => { setTelemetryEnabled(true); setTelemetryError('Couldn’t update telemetry — try again.'); })
        .finally(() => setTelemetrySaving(false));
    } else {
      setShowConsentModal(true);
    }
  }, [telemetryEnabled, telemetrySaving]);

  const confirmTelemetry = useCallback(async () => {
    setShowConsentModal(false);
    setTelemetryError(null);
    setTelemetryEnabled(true);
    setTelemetrySaving(true);
    try {
      await updateTelemetrySettings(true);
    } catch {
      setTelemetryEnabled(false);
      setTelemetryError('Couldn’t update telemetry — try again.');
    } finally {
      setTelemetrySaving(false);
      toggleRef.current?.focus();
    }
  }, []);

  // Consent modal a11y: focus first control on open, Escape cancels,
  // restore focus to the toggle on close.
  useEffect(() => {
    if (!showConsentModal) return;
    const first = modalRef.current?.querySelector<HTMLElement>('button');
    first?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setShowConsentModal(false); toggleRef.current?.focus(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [showConsentModal]);

  return (
    <section className="card ds-card">
      <div className="card-header"><h2 className="card-title">Network telemetry</h2></div>
      <div className="card-body">
        <div style={{ fontSize: 'var(--fs-label)', color: 'var(--text-secondary)', marginBottom: 16, lineHeight: 1.6 }}>
          Local metrics are stored in SQLite and displayed in the Observability page.
        </div>

        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '10px 0' }}>
          <div>
            <div style={{ fontSize: 'var(--fs-control)', fontWeight: 600 }}>Share telemetry with the network</div>
            <div style={{ fontSize: 'var(--fs-label)', color: 'var(--text-secondary)', marginTop: 2, lineHeight: 1.5 }}>
              When enabled, metrics and logs are streamed to the OriginTrail network dashboard for network-wide diagnostics.
            </div>
          </div>
          <button
            ref={toggleRef}
            type="button"
            role="switch"
            aria-checked={telemetryEnabled}
            aria-busy={telemetrySaving}
            aria-disabled={telemetrySaving}
            aria-label="Share telemetry with the network"
            onClick={toggleTelemetry}
            style={{
              width: 38, height: 22, borderRadius: 'var(--radius-pill)', border: 'none', flexShrink: 0,
              background: telemetryEnabled ? 'var(--accent-green)' : 'var(--border-default)',
              transition: 'background .2s', position: 'relative', marginLeft: 16,
              cursor: telemetrySaving ? 'wait' : 'pointer', opacity: telemetrySaving ? 0.6 : 1,
            }}
          >
            <span style={{
              position: 'absolute', top: 3, left: telemetryEnabled ? 19 : 3,
              width: 16, height: 16, borderRadius: '50%', background: 'var(--text-on-identity)',
              transition: 'left .2s', display: 'block',
            }} />
          </button>
        </div>
        <div aria-live="polite">
          {telemetryError && (
            <div style={{ fontSize: 'var(--fs-label)', color: 'var(--accent-red)', marginTop: 4 }}>{telemetryError}</div>
          )}
        </div>
      </div>

      {showConsentModal && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          background: 'var(--scrim)', display: 'flex',
          alignItems: 'center', justifyContent: 'center',
        }}>
          <div
            ref={modalRef}
            role="dialog"
            aria-modal="true"
            aria-label="Enable Telemetry Streaming?"
            style={{
              background: 'var(--bg-surface)', border: '1px solid var(--border-default)',
              borderRadius: 'var(--radius-overlay)', padding: '24px 28px', maxWidth: 440, width: '90%',
              boxShadow: 'var(--shadow-popover)',
            }}
          >
            <div style={{ fontSize: 'var(--fs-title)', fontWeight: 700, marginBottom: 16 }}>
              Enable Telemetry Streaming?
            </div>
            <div style={{ fontSize: 'var(--fs-control)', color: 'var(--text-secondary)', lineHeight: 1.7, marginBottom: 12 }}>
              When enabled, the following data is streamed to the OriginTrail team:
            </div>
            <ul style={{ fontSize: 'var(--fs-control)', color: 'var(--text-primary)', lineHeight: 1.8, margin: '0 0 14px 18px', padding: 0 }}>
              <li>Operation logs (publish, query, sync, gossip events)</li>
              <li>Performance metrics (durations, throughput, error rates)</li>
              <li>Node identity (peer ID, node name, network)</li>
            </ul>
            <div style={{ fontSize: 'var(--fs-control)', color: 'var(--text-secondary)', lineHeight: 1.7, marginBottom: 12 }}>
              The following data is <strong style={{ color: 'var(--text-primary)' }}>NEVER</strong> shared via telemetry:
            </div>
            <ul style={{ fontSize: 'var(--fs-control)', color: 'var(--text-primary)', lineHeight: 1.8, margin: '0 0 16px 18px', padding: 0 }}>
              <li>Private keys or wallet credentials</li>
              <li>Authentication tokens or API keys</li>
              <li>Private triple content or personal data</li>
              <li>File system paths or environment variables</li>
            </ul>
            <div style={{ fontSize: 'var(--fs-label)', color: 'var(--text-tertiary)', marginBottom: 20, lineHeight: 1.5 }}>
              You can disable streaming at any time from this page.
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button
                type="button"
                onClick={() => { setShowConsentModal(false); toggleRef.current?.focus(); }}
                style={{
                  padding: '7px 18px', borderRadius: 'var(--radius-control)', fontSize: 'var(--fs-control)', fontWeight: 600,
                  cursor: 'pointer', border: '1px solid var(--border-default)',
                  background: 'var(--bg-surface)', color: 'var(--text-secondary)',
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmTelemetry}
                style={{
                  padding: '7px 18px', borderRadius: 'var(--radius-control)', fontSize: 'var(--fs-control)', fontWeight: 700,
                  cursor: 'pointer', border: '1px solid var(--success-border)',
                  background: 'var(--success-bg)', color: 'var(--accent-green)',
                }}
              >
                Enable Streaming
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function LocalDataRetentionSection() {
  const { data: metrics } = useFetch(fetchMetrics, [], 30_000);
  const { data: retentionData } = useFetch(fetchRetentionSettings, [], 60_000);

  const [retentionDays, setRetentionDays] = useState(90);
  const [retentionSaved, setRetentionSaved] = useState(false);
  const [retentionError, setRetentionError] = useState<string | null>(null);
  const [pendingRetention, setPendingRetention] = useState<number | null>(null);
  const confirmRef = React.useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (retentionData?.retentionDays) setRetentionDays(retentionData.retentionDays);
  }, [retentionData]);

  // Move focus to the destructive confirm action when the reduce-confirm
  // panel appears (safe default + keyboard reachability).
  useEffect(() => {
    if (pendingRetention != null) confirmRef.current?.focus();
  }, [pendingRetention]);

  const confirmRetention = useCallback(async () => {
    if (pendingRetention == null) return;
    const days = pendingRetention;
    setRetentionSaved(false);
    setRetentionError(null);
    setPendingRetention(null);
    try {
      await updateRetentionSettings(days);
      setRetentionDays(days);
      setRetentionSaved(true);
      setTimeout(() => setRetentionSaved(false), 2000);
    } catch {
      setRetentionError('Couldn’t save retention — try again.');
    }
  }, [pendingRetention]);

  const handleRetentionChange = useCallback((days: number) => {
    setRetentionError(null);
    if (days < retentionDays) {
      setRetentionSaved(false);
      setPendingRetention(days);
    } else {
      setRetentionSaved(false);
      setPendingRetention(null);
      updateRetentionSettings(days).then(() => {
        setRetentionDays(days);
        setRetentionSaved(true);
        setTimeout(() => setRetentionSaved(false), 2000);
      }).catch(() => setRetentionError('Couldn’t save retention — try again.'));
    }
  }, [retentionDays]);

  const storeBytes = (metrics as any)?.store_bytes ?? null;

  return (
    <section className="card ds-card">
      <div className="card-header"><h2 className="card-title">Local data retention</h2></div>
      <div className="card-body">
        <label htmlFor="retention-select" className="settings-field-label" style={{ display: 'block', marginBottom: 5 }}>
          Keep local data for
        </label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <select
            id="retention-select"
            className="input"
            value={pendingRetention ?? retentionDays}
            onChange={e => handleRetentionChange(Number(e.target.value))}
            style={{ width: 160 }}
          >
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
            <option value={180}>180 days</option>
            <option value={365}>365 days</option>
          </select>
          <span aria-live="polite">
            {retentionSaved && (
              <span style={{ fontSize: 'var(--fs-micro)', color: 'var(--accent-green)', fontWeight: 600 }}>Saved</span>
            )}
          </span>
          {storeBytes != null && (
            <span className="mono" style={{ fontSize: 'var(--fs-micro)', color: 'var(--text-tertiary)' }}>
              Store: {formatBytes(storeBytes)}
            </span>
          )}
        </div>
        {pendingRetention != null && (
          <div
            role="group"
            aria-label="Confirm retention reduction"
            style={{
              marginTop: 8, padding: '10px 14px', borderRadius: 'var(--radius-nested)',
              background: 'var(--warning-bg)', border: '1px solid var(--warning-border)',
            }}
          >
            <div style={{ fontSize: 'var(--fs-label)', color: 'var(--accent-amber)', fontWeight: 600, marginBottom: 4 }}>
              Reduce retention to {pendingRetention} days?
            </div>
            <div style={{ fontSize: 'var(--fs-label)', color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 8 }}>
              Operations, logs, and metrics older than {pendingRetention} days will be permanently deleted.
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                ref={confirmRef}
                type="button"
                onClick={confirmRetention}
                style={{
                  padding: '5px 14px', borderRadius: 'var(--radius-control)', fontSize: 'var(--fs-label)', fontWeight: 700, cursor: 'pointer',
                  border: '1px solid var(--warning-border)', background: 'var(--warning-bg)', color: 'var(--accent-amber)',
                }}
              >
                Prune &amp; Save
              </button>
              <button
                type="button"
                onClick={() => setPendingRetention(null)}
                style={{
                  padding: '5px 14px', borderRadius: 'var(--radius-control)', fontSize: 'var(--fs-label)', fontWeight: 600, cursor: 'pointer',
                  border: '1px solid var(--border-default)', background: 'var(--bg-surface)', color: 'var(--text-secondary)',
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        {pendingRetention == null && (
          <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--text-tertiary)', marginTop: 4 }}>
            Operations and metric snapshots older than this are pruned automatically. Warning and error logs
            keep this window; high-volume routine logs also have a size safety cap.
          </div>
        )}
        <div aria-live="polite">
          {retentionError && (
            <div style={{ fontSize: 'var(--fs-label)', color: 'var(--accent-red)', marginTop: 4 }}>{retentionError}</div>
          )}
        </div>
      </div>
    </section>
  );
}

function truncateAddress(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function chainLabel(chainId: string | null | undefined): string {
  if (!chainId) return 'Unknown';
  const id = chainId.includes(':') ? chainId.split(':')[1] : chainId;
  switch (id) {
    case '84532': return 'Base Sepolia (Testnet)';
    case '8453': return 'Base (Mainnet)';
    case '1': return 'Ethereum Mainnet';
    case '11155111': return 'Sepolia (Testnet)';
    case '31337': return 'Local (Hardhat)';
    default: return `Chain ${id}`;
  }
}

export function SettingsPage() {
  return (
    <div className="page-section">
      <div style={{ marginBottom: 20 }}>
        <h1 className="page-title" style={{ marginBottom: 0 }}>Settings</h1>
        <p style={{ fontSize: 'var(--fs-control)', color: 'var(--text-secondary)', marginTop: 4 }}>Node configuration and preferences</p>
      </div>
      <GeneralSettingsTab />
    </div>
  );
}

function GeneralSettingsTab() {
  const { data: wallets } = useFetch(fetchWalletsBalances, [], 60_000);
  const w = wallets as any;

  const [shutdownConfirm, setShutdownConfirm] = useState(false);
  const [shuttingDown, setShuttingDown] = useState(false);

  // The shell's status poll feeds the whole card, so every field shows the same check.
  const { nodeStatus: s, peers: peerCount, state: nodeState } = useNodeState();

  const handleShutdown = useCallback(async () => {
    if (!shutdownConfirm) {
      setShutdownConfirm(true);
      setTimeout(() => setShutdownConfirm(false), 5000);
      return;
    }
    setShuttingDown(true);
    try {
      await shutdownNode();
    } catch {
      setShuttingDown(false);
      setShutdownConfirm(false);
    }
  }, [shutdownConfirm]);

  return (
    <div className="settings-stack">
      {/* Node Identity */}
      <section className="card ds-card">
        <div className="card-header"><h2 className="card-title">Node identity</h2></div>
        <div className="card-body">
          <Field label="Name" value={s?.name ?? '—'} />
          <Field label="Peer ID" value={s?.peerId ?? '—'} mono />
          <Field label="Role" value={s?.nodeRole ?? '—'} />
          <Field label="Network" value={s?.networkName ?? (s?.networkId ? `Network ${s.networkId}` : '—')} />
          <Field label="Store" value={s?.storeBackend ?? '—'} mono />
          <div className="settings-node-status ds-card-nested">
            <Badge tone={nodeState.tone}>{nodeState.word}</Badge>
            <div
              style={{ fontSize: 'var(--fs-label)', color: 'var(--text-secondary)', marginTop: 4 }}
              title="Peers = unique remote nodes. Direct + Relayed counts are libp2p connections — a single peer can hold both a direct and a relayed link, so they sum to ≥ Peers, not exactly equal to it."
            >
              {nodeState.tooltip ?? `${peerCount} peer${peerCount !== 1 ? 's' : ''} · ${s?.connections?.direct ?? 0} direct, ${s?.connections?.relayed ?? 0} relayed link${(s?.connections?.relayed ?? 0) === 1 ? '' : 's'} · up ${formatUptime(s?.uptimeMs ?? 0)}`}
            </div>
          </div>
        </div>
      </section>

      {/* Node Identity Wallets — independent of Publisher Conviction support. */}
      <IdentityWalletsSection blockExplorerUrl={s?.blockExplorerUrl ?? null} />

      {/* Blockchain Config */}
      <section className="card ds-card">
        <div className="card-header"><h2 className="card-title">Blockchain config</h2></div>
        <div className="card-body">
          <Field label="Chain" value={chainLabel(w?.chainId)} />
          {w?.balances?.length > 0 ? (
            w.balances.map((b: any, i: number) => (
              <div key={b.address} style={{ marginBottom: 10 }}>
                <Field label={w.balances.length > 1 ? `Wallet ${i + 1}` : 'Operational wallet'} value={b.address} mono />
                <div style={{ display: 'flex', gap: 16, marginTop: -6 }}>
                  <span
                    className="mono"
                    style={{ fontSize: 'var(--fs-label)', color: 'var(--text-secondary)' }}
                    title={formatEthTooltip(b.eth)}
                  >
                    {formatEth(b.eth)} ETH
                  </span>
                  <span className="mono" style={{ fontSize: 'var(--fs-label)', color: 'var(--text-secondary)' }} title={formatTracTooltip(b.trac)}>
                    {formatTrac(b.trac)} {formatTracSymbol(b.symbol, w?.chainId)}
                  </span>
                </div>
              </div>
            ))
          ) : (
            <Field label="Operational wallet" value={w?.wallets?.[0] ? truncateAddress(w.wallets[0]) : '—'} mono />
          )}
          {w?.rpcUrl && (
            <RpcUrlField rpcUrl={w.rpcUrl} />
          )}
          {w?.error ? (
            <div style={{ padding: '8px 12px', borderRadius: 'var(--radius-nested)', background: 'var(--danger-bg)', border: '1px solid var(--danger-border)' }}>
              <div style={{ fontSize: 'var(--fs-micro)', fontWeight: 700, color: 'var(--accent-red)', marginBottom: 2 }}>⚠ Error</div>
              <div style={{ fontSize: 'var(--fs-label)', color: 'var(--text-secondary)' }}>{w.error}</div>
            </div>
          ) : w?.chainId?.includes('84532') || w?.chainId?.includes('31337') || w?.chainId?.includes('11155111') ? (
            <div style={{ padding: '8px 12px', borderRadius: 'var(--radius-nested)', background: 'var(--warning-bg)', border: '1px solid var(--warning-border)' }}>
              <div style={{ fontSize: 'var(--fs-micro)', fontWeight: 700, color: 'var(--accent-amber)', marginBottom: 2 }}>⚠ Testnet Mode</div>
              <div style={{ fontSize: 'var(--fs-label)', color: 'var(--text-secondary)' }}>No real TRAC is spent. Perfect for development.</div>
            </div>
          ) : null}
        </div>
      </section>

      {/* Publisher Conviction */}
      <PcaSettingsCard />

      {/* Network Telemetry */}
      <NetworkTelemetrySection />

      {/* Local Data Retention */}
      <LocalDataRetentionSection />

      {/* Danger Zone (full-width footer; last in the stack) */}
      <section className="card ds-card" style={{ borderColor: 'var(--danger-border)', background: 'var(--danger-bg)' }}>
        <div className="card-header"><h2 className="card-title" style={{ color: 'var(--accent-red)' }}>Danger zone</h2></div>
        <div className="card-body">
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <button
              onClick={handleShutdown}
              disabled={shuttingDown}
              style={{
                padding: '8px 16px', borderRadius: 'var(--radius-nested)',
                border: `1px solid ${shutdownConfirm ? 'var(--accent-red)' : 'var(--warning-border)'}`,
                background: shutdownConfirm ? 'var(--danger-bg-strong)' : 'var(--warning-bg)',
                color: shutdownConfirm ? 'var(--accent-red)' : 'var(--accent-amber)',
                fontSize: 'var(--fs-control)', fontWeight: 600,
                cursor: shuttingDown ? 'not-allowed' : 'pointer',
                opacity: shuttingDown ? 0.5 : 1,
              }}
            >
              {shuttingDown ? 'Shutting down…' : shutdownConfirm ? 'Confirm Shutdown' : 'Shutdown Node'}
            </button>
            <span aria-live="polite">
              {shutdownConfirm && (
                <span style={{ fontSize: 'var(--fs-label)', color: 'var(--text-secondary)' }}>Click again to confirm. The node process will terminate.</span>
              )}
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}
