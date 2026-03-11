import React, { useState, useCallback, useEffect } from 'react';
import { useFetch } from '../hooks.js';
import {
  fetchStatus,
  fetchLlmSettings,
  updateLlmSettings,
  fetchWalletsBalances,
  fetchApps,
  shutdownNode,
  fetchParanets,
  fetchCatchupStatus,
  type CatchupStatusResponse,
} from '../api.js';

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div className="prov-field-label">{label}</div>
      <div className={`prov-field-value${mono ? ' mono' : ''}`}>{value}</div>
    </div>
  );
}

function Toggle({ label, desc, on, disabled }: { label: string; desc: string; on: boolean; disabled?: boolean }) {
  const [active, setActive] = useState(on);
  useEffect(() => { setActive(on); }, [on]);
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid var(--border)', opacity: disabled ? 0.5 : 1 }}>
      <div>
        <div style={{ fontSize: 12, fontWeight: 600 }}>{label}</div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.5 }}>{desc}</div>
      </div>
      <button
        onClick={() => !disabled && setActive(a => !a)}
        disabled={disabled}
        style={{
          width: 38, height: 22, borderRadius: 11, border: 'none', flexShrink: 0,
          background: active ? 'var(--green)' : 'var(--border)',
          transition: 'background .2s', position: 'relative', marginLeft: 16,
          cursor: disabled ? 'not-allowed' : 'pointer',
        }}
      >
        <span style={{
          position: 'absolute', top: 3, left: active ? 19 : 3,
          width: 16, height: 16, borderRadius: '50%', background: '#fff',
          transition: 'left .2s', display: 'block',
        }} />
      </button>
    </div>
  );
}

function LlmSection() {
  const { data: llm, refresh } = useFetch(fetchLlmSettings, []);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [baseURL, setBaseURL] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    if (llm) {
      setModel(llm.model ?? '');
      setBaseURL(llm.baseURL ?? '');
    }
  }, [llm]);

  const save = useCallback(async () => {
    setSaving(true);
    setMessage(null);
    try {
      const payload: { apiKey?: string; model: string; baseURL: string } = {
        model,
        baseURL,
      };
      if (apiKey.trim()) payload.apiKey = apiKey.trim();
      const res = await updateLlmSettings(payload);
      if (res.ok) {
        setMessage({
          type: 'ok',
          text: apiKey.trim()
            ? 'LLM configuration saved. Agent Hub now uses your API key.'
            : 'LLM settings updated.',
        });
        setApiKey('');
        refresh();
      } else {
        setMessage({ type: 'err', text: 'Failed to save' });
      }
    } catch (err: any) {
      setMessage({ type: 'err', text: err.message ?? 'Failed to save' });
    } finally {
      setSaving(false);
    }
  }, [apiKey, model, baseURL, refresh]);

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '8px 12px',
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--bg)',
    color: 'var(--text)',
    fontSize: 12,
    fontFamily: 'JetBrains Mono, monospace',
    outline: 'none',
    boxSizing: 'border-box',
  };

  return (
    <div className="settings-card">
      <div className="settings-title">LLM Configuration</div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 16, lineHeight: 1.6 }}>
        Connect an OpenAI-compatible LLM to power the Agent Hub with natural language understanding,
        SPARQL generation, and DKG tool calling. Without an API key, the agent uses rule-based responses only.
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, padding: '8px 12px', borderRadius: 8, background: llm?.configured ? 'var(--green-dim)' : 'rgba(255,255,255,.03)', border: `1px solid ${llm?.configured ? 'rgba(74,222,128,.2)' : 'var(--border)'}` }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: llm?.configured ? 'var(--green)' : 'var(--text-dim)', display: 'inline-block' }} />
        <span style={{ fontSize: 11, fontWeight: 600, color: llm?.configured ? 'var(--green)' : 'var(--text-muted)' }}>
          {llm?.configured ? 'LLM Connected' : 'Not Configured'}
        </span>
        {llm?.configured && llm.model && (
          <span className="mono" style={{ fontSize: 10, color: 'var(--text-dim)', marginLeft: 'auto' }}>{llm.model}</span>
        )}
      </div>

      <div style={{ marginBottom: 12 }}>
        <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: 5 }}>API Key</label>
        <div style={{ position: 'relative' }}>
          <input
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            placeholder={llm?.configured ? '••••••••  (key saved — paste new to replace)' : 'sk-...'}
            style={inputStyle}
          />
          <button
            onClick={() => setShowKey(v => !v)}
            style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', fontSize: 10, fontWeight: 600 }}
          >
            {showKey ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
        <div>
          <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: 5 }}>Model</label>
          <input
            value={model}
            onChange={e => setModel(e.target.value)}
            placeholder="gpt-4o-mini"
            style={inputStyle}
          />
        </div>
        <div>
          <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: 5 }}>Base URL</label>
          <input
            value={baseURL}
            onChange={e => setBaseURL(e.target.value)}
            placeholder="https://api.openai.com/v1"
            style={inputStyle}
          />
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button
          onClick={save}
          disabled={saving}
          style={{
            padding: '8px 20px',
            borderRadius: 8,
            border: '1px solid rgba(74,222,128,.3)',
            background: 'var(--green-dim)',
            color: 'var(--green)',
            fontSize: 12,
            fontWeight: 700,
            cursor: saving ? 'not-allowed' : 'pointer',
            opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {llm?.configured && (
          <button
            onClick={async () => {
              setSaving(true);
              try {
                await updateLlmSettings({ clear: true });
                setApiKey('');
                setModel('');
                setBaseURL('');
                setMessage({ type: 'ok', text: 'LLM configuration cleared.' });
                refresh();
              } catch (err: any) {
                setMessage({ type: 'err', text: err.message });
              } finally {
                setSaving(false);
              }
            }}
            disabled={saving}
            style={{
              padding: '8px 16px',
              borderRadius: 8,
              border: '1px solid rgba(248,113,113,.2)',
              background: 'rgba(248,113,113,.05)',
              color: 'var(--red)',
              fontSize: 12,
              fontWeight: 600,
              cursor: saving ? 'not-allowed' : 'pointer',
            }}
          >
            Disconnect
          </button>
        )}
        {message && (
          <span style={{ fontSize: 11, color: message.type === 'ok' ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
            {message.text}
          </span>
        )}
      </div>
    </div>
  );
}

function formatUptime(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ${min % 60}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
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

function CatchupStatusSection() {
  const { data: paranetData } = useFetch(fetchParanets, [], 30_000);
  const paranets = ((paranetData as any)?.paranets ?? []).filter((p: any) => p?.id);
  const [selectedParanet, setSelectedParanet] = useState('');

  useEffect(() => {
    if (selectedParanet) return;
    if (paranets.length === 0) return;
    const preferred = paranets.find((p: any) => !p.isSystem) ?? paranets[0];
    setSelectedParanet(preferred.id);
  }, [selectedParanet, paranets]);

  const {
    data: catchup,
    loading,
    error,
    refresh,
  } = useFetch<CatchupStatusResponse | null>(
    async () => {
      if (!selectedParanet) return null;
      try {
        return await fetchCatchupStatus(selectedParanet);
      } catch (err: any) {
        const msg = String(err?.message ?? '');
        if (msg.includes('No catch-up job found') || msg.includes('HTTP 404')) return null;
        throw err;
      }
    },
    [selectedParanet],
    4000,
  );

  const statusBadgeClass =
    catchup?.status === 'done'
      ? 'badge-success'
      : catchup?.status === 'failed'
        ? 'badge-warning'
        : catchup?.status === 'running'
          ? 'badge-info'
          : 'badge-info';

  return (
    <div className="settings-card">
      <div className="settings-title">Background Sync Status</div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.5 }}>
        Shows the latest catch-up job for the selected paranet (triggered by subscribe).
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <select
          className="input"
          style={{ flex: 1, backgroundImage: 'none', paddingRight: 12 }}
          value={selectedParanet}
          onChange={(e) => setSelectedParanet(e.target.value)}
        >
          {paranets.length === 0 && <option value="">No paranets available</option>}
          {paranets.map((p: any) => (
            <option key={p.id} value={p.id}>{p.id}{p.isSystem ? ' (system)' : ''}</option>
          ))}
        </select>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => refresh()}
          disabled={!selectedParanet || loading}
        >
          {loading ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {!selectedParanet ? (
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Select a paranet to view sync status.</div>
      ) : !catchup ? (
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No catch-up job recorded yet for this paranet.</div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            <span className={`badge ${statusBadgeClass}`}>status: {catchup.status}</span>
            <span className="badge badge-info">workspace: {catchup.includeWorkspace ? 'on' : 'off'}</span>
            <span className="badge badge-info">job: {catchup.jobId.slice(0, 10)}...</span>
          </div>

          {catchup.result && (
            <div style={{ fontSize: 12, color: 'var(--text)', marginBottom: 8 }}>
              peers {catchup.result.peersTried}/{catchup.result.syncCapablePeers} (connected {catchup.result.connectedPeers}),
              data {catchup.result.dataSynced}, workspace {catchup.result.workspaceSynced}
            </div>
          )}

          <div className="mono" style={{ fontSize: 10, color: 'var(--text-dim)' }}>
            queued {new Date(catchup.queuedAt).toLocaleString()}
            {catchup.startedAt ? ` · started ${new Date(catchup.startedAt).toLocaleString()}` : ''}
            {catchup.finishedAt ? ` · finished ${new Date(catchup.finishedAt).toLocaleString()}` : ''}
          </div>

          {catchup.error && (
            <div style={{ marginTop: 8, fontSize: 11, color: 'var(--red)' }}>
              {catchup.error}
            </div>
          )}
        </>
      )}

      {error && (
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--amber)' }}>
          {error}
        </div>
      )}
    </div>
  );
}

export function SettingsPage() {
  const { data: status } = useFetch(fetchStatus, [], 30_000);
  const { data: wallets } = useFetch(fetchWalletsBalances, [], 60_000);
  const { data: apps } = useFetch(fetchApps, []);
  const s = status as any;
  const w = wallets as any;

  const [shutdownConfirm, setShutdownConfirm] = useState(false);
  const [shuttingDown, setShuttingDown] = useState(false);

  const peerCount = s?.connectedPeers ?? 0;
  const isOnline = s?.peerId != null;
  const primaryWallet = w?.balances?.[0];

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
    <div className="page-section">
      <div style={{ marginBottom: 24 }}>
        <h1 className="serif" style={{ fontSize: 22, fontWeight: 700 }}>Settings</h1>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>Node configuration and preferences</p>
      </div>

      <div className="settings-grid">
        {/* LLM Configuration */}
        <LlmSection />

        {/* Node Identity */}
        <div className="settings-card">
          <div className="settings-title">Node Identity</div>
          <Field label="Name" value={s?.name ?? '—'} />
          <Field label="Peer ID" value={s?.peerId ?? '—'} mono />
          <Field label="Role" value={s?.nodeRole ?? '—'} />
          <Field label="Network" value={s?.networkName ?? (s?.networkId ? `Network ${s.networkId}` : '—')} />
          <Field label="Store" value={s?.storeBackend ?? '—'} mono />
          <div style={{ padding: '10px 14px', borderRadius: 8, background: isOnline ? 'var(--green-dim)' : 'rgba(248,113,113,.05)', border: `1px solid ${isOnline ? 'rgba(74,222,128,.2)' : 'rgba(248,113,113,.2)'}` }}>
            <div className="mono" style={{ fontSize: 10, color: isOnline ? 'var(--green)' : 'var(--red)', fontWeight: 700 }}>
              {isOnline ? '● ONLINE' : '● OFFLINE'}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
              {isOnline
                ? `${peerCount} peer${peerCount !== 1 ? 's' : ''} · ${s?.connections?.direct ?? 0} direct, ${s?.connections?.relayed ?? 0} relayed · up ${formatUptime(s?.uptimeMs ?? 0)}`
                : 'Node is not responding'}
            </div>
          </div>
        </div>

        {/* Blockchain */}
        <div className="settings-card">
          <div className="settings-title">Blockchain Config</div>
          <Field label="Chain" value={chainLabel(w?.chainId)} />
          {w?.balances?.length > 0 ? (
            w.balances.map((b: any, i: number) => (
              <div key={b.address} style={{ marginBottom: 10 }}>
                <Field label={w.balances.length > 1 ? `Wallet ${i + 1}` : 'Operational Wallet'} value={b.address} mono />
                <div style={{ display: 'flex', gap: 16, marginTop: -6 }}>
                  <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>{parseFloat(b.eth).toFixed(6)} ETH</span>
                  <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>{parseFloat(b.trac).toFixed(2)} {b.symbol}</span>
                </div>
              </div>
            ))
          ) : (
            <Field label="Operational Wallet" value={w?.wallets?.[0] ? truncateAddress(w.wallets[0]) : '—'} mono />
          )}
          {w?.rpcUrl && (
            <Field label="RPC" value={w.rpcUrl} mono />
          )}
          {w?.error ? (
            <div style={{ padding: '8px 12px', borderRadius: 8, background: 'rgba(248,113,113,.05)', border: '1px solid rgba(248,113,113,.2)' }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--red)', marginBottom: 2 }}>⚠ Error</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{w.error}</div>
            </div>
          ) : w?.chainId?.includes('84532') || w?.chainId?.includes('31337') || w?.chainId?.includes('11155111') ? (
            <div style={{ padding: '8px 12px', borderRadius: 8, background: 'var(--amber-dim)', border: '1px solid rgba(251,191,36,.2)' }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--amber)', marginBottom: 2 }}>⚠ Testnet Mode</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>No real TRAC is spent. Perfect for development.</div>
            </div>
          ) : null}
        </div>

        {/* Sync status */}
        <CatchupStatusSection />

        {/* Privacy & Memory */}
        <div className="settings-card">
          <div className="settings-title">Privacy & Memory</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.5 }}>
            These settings are not yet configurable via the UI. Edit <span className="mono" style={{ fontSize: 10 }}>~/.dkg/config.json</span> directly.
          </div>
          <Toggle label="Publish by Default" desc="Automatically push new Knowledge Assets to the DKG upon creation." on={true} disabled />
          <Toggle label="Analytics" desc="Share anonymous usage stats to help improve DKG v9." on={false} disabled />
        </div>

        {/* Apps */}
        <div className="settings-card">
          <div className="settings-title">Installed Apps</div>
          {apps && (apps as any[]).length > 0 ? (
            (apps as any[]).map((app: any) => (
              <div key={app.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
                <span style={{ fontSize: 18 }}>🚀</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, fontWeight: 600 }}>{app.label}</div>
                  <div className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>{app.id} · {app.path}</div>
                </div>
                <span className="mono" style={{ fontSize: 9, padding: '2px 7px', borderRadius: 4, background: 'var(--green-dim)', color: 'var(--green)', fontWeight: 700 }}>
                  ACTIVE
                </span>
              </div>
            ))
          ) : (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '12px 0' }}>
              No apps installed. Apps are loaded from <span className="mono" style={{ fontSize: 10 }}>config.json</span> on startup.
            </div>
          )}
        </div>

        {/* Danger zone */}
        <div className="settings-card" style={{ gridColumn: '1 / -1', borderColor: 'rgba(248,113,113,.2)', background: 'rgba(248,113,113,.03)' }}>
          <div className="settings-title" style={{ color: 'var(--red)' }}>Danger Zone</div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <button
              onClick={handleShutdown}
              disabled={shuttingDown}
              style={{
                padding: '8px 16px', borderRadius: 8,
                border: `1px solid ${shutdownConfirm ? 'var(--red)' : 'rgba(251,191,36,.3)'}`,
                background: shutdownConfirm ? 'rgba(248,113,113,.15)' : 'rgba(251,191,36,.07)',
                color: shutdownConfirm ? 'var(--red)' : 'var(--amber)',
                fontSize: 12, fontWeight: 600,
                cursor: shuttingDown ? 'not-allowed' : 'pointer',
                opacity: shuttingDown ? 0.5 : 1,
              }}
            >
              {shuttingDown ? 'Shutting down…' : shutdownConfirm ? 'Confirm Shutdown' : 'Shutdown Node'}
            </button>
            {shutdownConfirm && (
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Click again to confirm. The node process will terminate.</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
