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
import { Badge, StatusGlyph } from '../components/ds/Badge.js';
import { PcaSettingsCard } from './conviction/PcaSettingsCard.js';
import { IdentityWalletsSection } from './identity-wallets/IdentityWalletsSection.js';
import { Toggle } from '../components/ds/Toggle.js';
import { Button } from '../components/ds/Button.js';
import { useModalDismiss } from '../components/Modals/useModalDismiss.js';
import { formatNodeRole, truncateAddress } from '../lib/format.js';
import { PageHeader } from '../components/ds/PageHeader.js';

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="settings-field">
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
    <div className="settings-field">
      <div className="settings-field-label settings-field-label-row">
        <span>RPC</span>
        <button
          type="button"
          className="ds-btn ds-ghost ds-sm"
          onClick={() => setReveal((v) => !v)}
          aria-label={reveal ? 'Redact RPC URL' : 'Reveal RPC URL'}
          title={reveal ? 'Hide the path-token (recommended for screen-shares)' : 'Show full URL — careful, may contain a tenant secret'}
        >
          {reveal ? 'Redact' : 'Reveal'}
        </button>
      </div>
      <div className="settings-field-value mono settings-field-value-break">{display}</div>
    </div>
  );
}

function NetworkTelemetrySection() {
  const { data: telemetryData } = useFetch(fetchTelemetrySettings, [], 60_000);

  const [telemetryEnabled, setTelemetryEnabled] = useState(false);
  const [telemetrySaving, setTelemetrySaving] = useState(false);
  const [telemetryError, setTelemetryError] = useState<string | null>(null);
  const [showConsentModal, setShowConsentModal] = useState(false);
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

  const closeConsent = useCallback(() => setShowConsentModal(false), []);
  const { dialogRef } = useModalDismiss(showConsentModal, closeConsent);

  return (
    <section className="card ds-card">
      <div className="card-header"><h2 className="card-title">Network telemetry</h2></div>
      <div className="card-body">
        <div className="settings-intro">
          Local metrics are stored in SQLite and displayed in the Observability page.
        </div>

        <div className="settings-toggle-row">
          <div>
            <div className="settings-toggle-title">Share telemetry with the network</div>
            <div className="settings-toggle-desc">
              When enabled, metrics and logs are streamed to the OriginTrail network dashboard for network-wide diagnostics.
            </div>
          </div>
          <Toggle
            ref={toggleRef}
            checked={telemetryEnabled}
            busy={telemetrySaving}
            aria-label="Share telemetry with the network"
            onClick={toggleTelemetry}
            className="settings-toggle-control"
          />
        </div>
        <div aria-live="polite">
          {telemetryError && (
            <div className="settings-error">{telemetryError}</div>
          )}
        </div>
      </div>

      {showConsentModal && (
        <div className="settings-confirm-scrim">
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Enable Telemetry Streaming?"
            className="settings-confirm"
          >
            <div className="settings-confirm-title">
              Enable Telemetry Streaming?
            </div>
            <div className="settings-confirm-text">
              When enabled, the following data is streamed to the OriginTrail team:
            </div>
            <ul className="settings-confirm-list">
              <li>Operation logs (publish, query, sync, gossip events)</li>
              <li>Performance metrics (durations, throughput, error rates)</li>
              <li>Node identity (peer ID, node name, network)</li>
            </ul>
            <div className="settings-confirm-text">
              The following data is <strong className="settings-confirm-strong">NEVER</strong> shared via telemetry:
            </div>
            <ul className="settings-confirm-list-last">
              <li>Private keys or wallet credentials</li>
              <li>Authentication tokens or API keys</li>
              <li>Private triple content or personal data</li>
              <li>File system paths or environment variables</li>
            </ul>
            <div className="settings-confirm-note">
              You can disable streaming at any time from this page.
            </div>
            <div className="settings-confirm-actions">
              <Button onClick={() => { setShowConsentModal(false); toggleRef.current?.focus(); }}>
                Cancel
              </Button>
              <Button variant="primary" onClick={confirmTelemetry}>
                Enable streaming
              </Button>
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
        <label htmlFor="retention-select" className="settings-field-label settings-select-label">
          Keep local data for
        </label>
        <div className="settings-select-row">
          <select
            id="retention-select"
            className="input settings-select"
            value={pendingRetention ?? retentionDays}
            onChange={e => handleRetentionChange(Number(e.target.value))}
          >
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
            <option value={180}>180 days</option>
            <option value={365}>365 days</option>
          </select>
          <span aria-live="polite">
            {retentionSaved && (
              <span className="settings-saved">Saved</span>
            )}
          </span>
          {storeBytes != null && (
            <span className="mono settings-micro">
              Store: {formatBytes(storeBytes)}
            </span>
          )}
        </div>
        {pendingRetention != null && (
          <div
            role="group"
            aria-label="Confirm retention reduction"
            className="settings-warning"
          >
            <div className="settings-warning-title">
              Reduce retention to {pendingRetention} days?
            </div>
            <div className="settings-warning-text">
              Operations, logs, and metrics older than {pendingRetention} days will be permanently deleted.
            </div>
            <div className="settings-warning-actions">
              <Button ref={confirmRef} variant="danger" size="sm" onClick={confirmRetention}>
                Prune &amp; Save
              </Button>
              <Button size="sm" onClick={() => setPendingRetention(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
        {pendingRetention == null && (
          <div className="settings-hint">
            Operations and metric snapshots older than this are pruned automatically. Warning and error logs
            keep this window; high-volume routine logs also have a size safety cap.
          </div>
        )}
        <div aria-live="polite">
          {retentionError && (
            <div className="settings-error">{retentionError}</div>
          )}
        </div>
      </div>
    </section>
  );
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
    <div className="ds-page">
      <PageHeader title="Settings" description="Node configuration and preferences" />
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
          <Field label="Role" value={formatNodeRole(s?.nodeRole)} />
          <Field label="Network" value={s?.networkName ?? (s?.networkId ? `Network ${s.networkId}` : '—')} />
          <Field label="Store" value={s?.storeBackend ?? '—'} mono />
          <div className="settings-node-status ds-card-nested">
            <Badge tone={nodeState.tone}>{nodeState.word}</Badge>
            <div
              className="settings-note"
              title="Peers = unique remote nodes. Direct + Relayed counts are connections — a single peer can hold both a direct and a relayed link, so they sum to ≥ Peers, not exactly equal to it."
            >
              {nodeState.tooltip ?? `${peerCount} peer${peerCount !== 1 ? 's' : ''}: ${s?.connections?.direct ?? 0} direct, ${s?.connections?.relayed ?? 0} relayed. Up ${formatUptime(s?.uptimeMs ?? 0)}.`}
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
              <div key={b.address} className="settings-block">
                <Field label={w.balances.length > 1 ? `Wallet ${i + 1}` : 'Operational wallet'} value={b.address} mono />
                <div className="settings-meta-row">
                  <span
                    className="mono settings-meta"
                    title={formatEthTooltip(b.eth)}
                  >
                    {formatEth(b.eth)} ETH
                  </span>
                  <span className="mono settings-meta" title={formatTracTooltip(b.trac)}>
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
            <div className="settings-danger-note">
              <div className="settings-danger-title"><StatusGlyph tone="danger" /> Error</div>
              <div className="settings-meta">{w.error}</div>
            </div>
          ) : w?.chainId?.includes('84532') || w?.chainId?.includes('31337') || w?.chainId?.includes('11155111') ? (
            <div className="settings-warn-note">
              <div className="settings-warn-title"><StatusGlyph tone="warning" /> Testnet mode</div>
              <div className="settings-meta">No real TRAC is spent. Perfect for development.</div>
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
      <section className="card ds-card settings-danger-card">
        <div className="card-header"><h2 className="card-title settings-danger-heading">Danger zone</h2></div>
        <div className="card-body">
          <div className="settings-danger-actions">
            <button
              onClick={handleShutdown}
              disabled={shuttingDown}
              className={shutdownConfirm ? 'ds-btn settings-shutdown settings-shutdown-confirm' : 'ds-btn settings-shutdown'}
            >
              {shuttingDown ? 'Shutting down…' : shutdownConfirm ? 'Confirm shutdown' : 'Shut down node'}
            </button>
            <span aria-live="polite">
              {shutdownConfirm && (
                <span className="settings-meta">Click again to confirm. The node process will terminate.</span>
              )}
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}
