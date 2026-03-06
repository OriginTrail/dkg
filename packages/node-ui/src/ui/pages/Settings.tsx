import React, { useState, useCallback, useEffect } from 'react';
import { useFetch } from '../hooks.js';
import { fetchStatus, fetchLlmSettings, updateLlmSettings } from '../api.js';

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div className="prov-field-label">{label}</div>
      <div className={`prov-field-value${mono ? ' mono' : ''}`}>{value}</div>
    </div>
  );
}

function Toggle({ label, desc, on }: { label: string; desc: string; on: boolean }) {
  const [active, setActive] = useState(on);
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
      <div>
        <div style={{ fontSize: 12, fontWeight: 600 }}>{label}</div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.5 }}>{desc}</div>
      </div>
      <button
        onClick={() => setActive(a => !a)}
        style={{
          width: 38, height: 22, borderRadius: 11, border: 'none', flexShrink: 0,
          background: active ? 'var(--green)' : 'var(--border)',
          transition: 'background .2s', position: 'relative', marginLeft: 16,
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
      const res = await updateLlmSettings({
        apiKey: apiKey || '',
        model: model || undefined,
        baseURL: baseURL || undefined,
      });
      if (res.ok) {
        setMessage({ type: 'ok', text: apiKey.trim() ? 'LLM configuration saved. Agent Hub now uses your API key.' : 'LLM configuration cleared.' });
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
                await updateLlmSettings({ apiKey: '' });
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

export function SettingsPage() {
  const { data: status } = useFetch(fetchStatus, [], 30_000);
  const s = status as any;

  return (
    <div className="page-section">
      <div style={{ marginBottom: 24 }}>
        <h1 className="serif" style={{ fontSize: 22, fontWeight: 700 }}>Settings</h1>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>Node configuration and preferences</p>
      </div>

      <div className="settings-grid">
        {/* LLM Configuration — first card */}
        <LlmSection />

        {/* Node Identity */}
        <div className="settings-card">
          <div className="settings-title">Node Identity</div>
          <Field label="Node ID" value={s?.nodeId ?? 'quantum-guardian-v9'} mono />
          <Field label="Network" value={s?.network ?? 'DKG v9 Testnet · Base Sepolia'} />
          <Field label="API Port" value={String(s?.apiPort ?? 19200)} mono />
          <Field label="Version" value={s?.version ?? '9.0.0-alpha'} mono />
          <div style={{ padding: '10px 14px', borderRadius: 8, background: 'var(--green-dim)', border: '1px solid rgba(74,222,128,.2)' }}>
            <div className="mono" style={{ fontSize: 10, color: 'var(--green)', fontWeight: 700 }}>● ONLINE</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>Connected to 14 peers</div>
          </div>
        </div>

        {/* Blockchain */}
        <div className="settings-card">
          <div className="settings-title">Blockchain Config</div>
          <Field label="Chain" value="Base Sepolia (Testnet)" />
          <Field label="Operational Wallet" value={s?.operationalWallet ?? '0xe689…f6AE'} mono />
          <Field label="Management Wallet" value={s?.managementWallet ?? '0xa4B1…9F60'} mono />
          <Field label="TRAC Balance" value={s?.tracBalance ?? '—'} mono />
          <div style={{ padding: '8px 12px', borderRadius: 8, background: 'var(--amber-dim)', border: '1px solid rgba(251,191,36,.2)' }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--amber)', marginBottom: 2 }}>⚠ Testnet Mode</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>No real TRAC is spent. Perfect for development.</div>
          </div>
        </div>

        {/* Privacy & Memory */}
        <div className="settings-card">
          <div className="settings-title">Privacy & Memory</div>
          <Toggle label="Publish by Default" desc="Automatically push new Knowledge Assets to the DKG upon creation." on={true} />
          <Toggle label="Memory Indexing" desc="Index imported memories for fast agent retrieval." on={true} />
          <Toggle label="Analytics" desc="Share anonymous usage stats to help improve DKG v9." on={false} />
          <Toggle label="Agent Access" desc="Allow other agents to query your public Knowledge Assets." on={true} />
        </div>

        {/* Apps */}
        <div className="settings-card">
          <div className="settings-title">Installed Apps</div>
          {[
            { name: 'OriginTrail Game', id: 'origintrail', version: '0.1.0', status: 'active' },
          ].map(app => (
            <div key={app.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
              <span style={{ fontSize: 18 }}>🚀</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 600 }}>{app.name}</div>
                <div className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>v{app.version} · {app.id}</div>
              </div>
              <span className="mono" style={{ fontSize: 9, padding: '2px 7px', borderRadius: 4, background: 'var(--green-dim)', color: 'var(--green)', fontWeight: 700 }}>
                {app.status.toUpperCase()}
              </span>
            </div>
          ))}
        </div>

        {/* Danger zone */}
        <div className="settings-card" style={{ gridColumn: '1 / -1', borderColor: 'rgba(248,113,113,.2)', background: 'rgba(248,113,113,.03)' }}>
          <div className="settings-title" style={{ color: 'var(--red)' }}>Danger Zone</div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {[
              { label: 'Restart Node', desc: 'Restart the DKG v9 daemon', color: 'var(--amber)' },
              { label: 'Clear Cache', desc: 'Wipe local query cache', color: 'var(--amber)' },
              { label: 'Wipe Node Data', desc: 'Irreversible — deletes all local data', color: 'var(--red)' },
            ].map(a => (
              <button key={a.label} style={{ padding: '8px 16px', borderRadius: 8, border: `1px solid ${a.color}44`, background: `${a.color}11`, color: a.color, fontSize: 12, fontWeight: 600 }}>
                {a.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
