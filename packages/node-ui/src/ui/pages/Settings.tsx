import React, { useState } from 'react';
import { useFetch } from '../hooks.js';
import { fetchStatus } from '../api.js';

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
          <div style={{ marginTop: 12, padding: '8px 12px', borderRadius: 8, background: 'rgba(255,255,255,.02)', border: '1px dashed var(--border)', textAlign: 'center', cursor: 'pointer' }}>
            <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>+ Browse ClawhHub for more apps</span>
          </div>
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
