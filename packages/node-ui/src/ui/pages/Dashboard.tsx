import React, { useState, useEffect, useRef } from 'react';
import { useFetch } from '../hooks.js';
import { fetchStatus, fetchMetrics } from '../api.js';

// ── Import Memories Modal ──────────────────────────────────────────────────────

function ImportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div className="import-modal-overlay open" onClick={onClose}>
      <div className="import-modal" onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <h3 className="serif" style={{ fontSize: 18, fontWeight: 700 }}>Import Memories</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 18 }}>×</button>
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.6 }}>
          Paste exported memories from Claude, ChatGPT, Gemini, or any other AI assistant. They'll be published as verified Knowledge Assets on your DKG node — owned by you, queryable by any agent.
        </p>
        <div style={{ padding: '10px 14px', borderRadius: 8, background: 'var(--blue-dim)', border: '1px solid rgba(96,165,250,.2)', marginBottom: 16 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--blue)', marginBottom: 4 }}>💡 TIP</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
            Paste this into your old AI assistant to export your memories:<br />
            <code className="mono" style={{ fontSize: 10, color: 'var(--text)', background: 'rgba(255,255,255,.05)', padding: '2px 6px', borderRadius: 4 }}>
              "List every memory you have stored about me in a single code block."
            </code>
          </div>
        </div>
        <textarea placeholder="Paste your exported memories here..." />
        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '8px 20px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', fontSize: 12, fontWeight: 600 }}>Cancel</button>
          <button style={{ padding: '8px 20px', borderRadius: 8, border: 'none', background: 'var(--green)', color: 'var(--bg)', fontSize: 12, fontWeight: 700 }}>Publish as Knowledge Assets</button>
        </div>
      </div>
    </div>
  );
}

// ── Network Visualization ──────────────────────────────────────────────────────

interface NetNode { x: number; y: number; r: number; isYou: boolean; color: string; id: number; }
interface NetEdge { a: number; b: number; }

const COLORS = ['#60a5fa', '#a78bfa', '#fbbf24', '#22d3ee', '#f472b6', '#94a3b8'];

function buildNetwork(): { nodes: NetNode[]; edges: NetEdge[] } {
  const W = 600, H = 280, cx = W / 2, cy = H / 2 + 10;
  const nodes: NetNode[] = [];
  for (let i = 0; i < 14; i++) {
    const angle = (i / 14) * Math.PI * 2 + (i * 0.3);
    const r = 60 + (i % 3) * 30;
    nodes.push({
      x: cx + Math.cos(angle) * r,
      y: cy + Math.sin(angle) * r * 0.7,
      r: i === 0 ? 7 : 4 + (i % 3),
      isYou: i === 0,
      id: i,
      color: i === 0 ? '#4ade80' : COLORS[i % 6],
    });
  }
  const edges: NetEdge[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let c = 0; c < 2; c++) {
      const j = (i + 1 + (c * 3)) % nodes.length;
      if (i !== j && !edges.find(e => (e.a === i && e.b === j) || (e.a === j && e.b === i))) {
        edges.push({ a: i, b: j });
      }
    }
  }
  return { nodes, edges };
}

const { nodes: NET_NODES, edges: NET_EDGES } = buildNetwork();

function NetworkViz() {
  const [packets, setPackets] = useState<Array<{ edge: number; t: number; color: string }>>([]);
  const raf = useRef(0);
  const lastSpawn = useRef(0);

  useEffect(() => {
    const tick = (ts: number) => {
      if (ts - lastSpawn.current > 700) {
        const edgeIdx = Math.floor(Math.random() * NET_EDGES.length);
        const nIdx = NET_EDGES[edgeIdx].a;
        setPackets(prev => [...prev.filter(p => p.t < 1), { edge: edgeIdx, t: 0, color: NET_NODES[nIdx].color }]);
        lastSpawn.current = ts;
      }
      setPackets(prev => prev.map(p => ({ ...p, t: p.t + 0.018 })).filter(p => p.t <= 1));
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, []);

  return (
    <svg viewBox="0 0 600 280" style={{ width: '100%', height: '100%', display: 'block' }}>
      <defs>
        <filter id="glow"><feGaussianBlur stdDeviation="3" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      </defs>
      {NET_EDGES.map((e, i) => (
        <line key={i} x1={NET_NODES[e.a].x} y1={NET_NODES[e.a].y} x2={NET_NODES[e.b].x} y2={NET_NODES[e.b].y} stroke="#1e2a3a" strokeWidth="1" opacity="0.5" />
      ))}
      {packets.map((p, i) => {
        const e = NET_EDGES[p.edge];
        const na = NET_NODES[e.a], nb = NET_NODES[e.b];
        const cx = na.x + (nb.x - na.x) * p.t;
        const cy = na.y + (nb.y - na.y) * p.t;
        return <circle key={i} cx={cx} cy={cy} r="2" fill={p.color} opacity={Math.sin(p.t * Math.PI) * 0.9} filter="url(#glow)" />;
      })}
      {NET_NODES.map(n => (
        <g key={n.id}>
          {n.isYou && (
            <circle cx={n.x} cy={n.y} r="14" fill="none" stroke={n.color} strokeWidth="1" opacity="0.2">
              <animate attributeName="r" values="12;20;12" dur="3s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="0.3;0;0.3" dur="3s" repeatCount="indefinite" />
            </circle>
          )}
          <circle cx={n.x} cy={n.y} r={n.r} fill={n.color} opacity={n.isYou ? 1 : 0.6} filter={n.isYou ? 'url(#glow)' : undefined} />
          {n.isYou && (
            <text x={n.x} y={n.y + 18} textAnchor="middle" fill={n.color} fontSize="9" fontWeight="700" fontFamily="JetBrains Mono,monospace">YOUR NODE</text>
          )}
        </g>
      ))}
    </svg>
  );
}

// ── Feed ───────────────────────────────────────────────────────────────────────

const FEED_AGENTS = [
  { name: 'Agent-Finance',  color: '#4ade80', bg: 'rgba(74,222,128,0.12)' },
  { name: 'Agent-Legal',    color: '#60a5fa', bg: 'rgba(96,165,250,0.12)' },
  { name: 'Agent-Network',  color: '#a78bfa', bg: 'rgba(167,139,250,0.12)' },
  { name: 'Agent-Research', color: '#fbbf24', bg: 'rgba(251,191,36,0.12)' },
  { name: 'Agent-Audit',    color: '#f472b6', bg: 'rgba(244,114,182,0.12)' },
  { name: 'Human:0x7a3f',  color: '#22d3ee', bg: 'rgba(34,211,238,0.12)' },
];
const ACTIONS = ['publish', 'query', 'update', 'verify'] as const;
const ACTION_COLORS: Record<string, string> = { publish: 'var(--green)', query: 'var(--blue)', update: 'var(--amber)', verify: 'var(--purple)' };
const rnd = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const genUAL = () => `did:dkg:${rnd(['base', 'otp', 'gnosis'])}:0x${Math.random().toString(16).slice(2, 8)}/${Math.floor(Math.random() * 999999)}/1`;

interface FeedEvent { id: number; agent: typeof FEED_AGENTS[0]; action: string; ual: string; verified: boolean; }
let _fid = 0;
const genEvent = (): FeedEvent => ({ id: _fid++, agent: rnd(FEED_AGENTS), action: rnd([...ACTIONS]), ual: genUAL(), verified: Math.random() > 0.15 });

const PARANETS = [
  { name: 'OriginTrail Game', assets: 847,  agents: 12, color: 'var(--green)' },
  { name: 'DeSci Research',   assets: 1203, agents: 8,  color: 'var(--blue)' },
  { name: 'Supply Chain EU',  assets: 797,  agents: 4,  color: 'var(--amber)' },
];

// ── Page ───────────────────────────────────────────────────────────────────────

export function DashboardPage() {
  const [importOpen, setImportOpen] = useState(false);
  const [feed, setFeed] = useState<FeedEvent[]>(() => Array.from({ length: 12 }, genEvent));
  const { data: status } = useFetch(fetchStatus, [], 10_000);
  const { data: metrics } = useFetch(fetchMetrics, [], 10_000);

  useEffect(() => {
    const t = setInterval(() => {
      const ev = genEvent();
      setFeed(prev => [ev, ...prev].slice(0, 20));
    }, 3000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="page-section">
      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} />

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h1 className="serif" style={{ fontSize: 22, fontWeight: 700 }}>Dashboard</h1>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
            Your node is live and participating in 3 paranets
          </p>
        </div>
        <button
          onClick={() => setImportOpen(true)}
          style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid rgba(96,165,250,.27)', background: 'var(--blue-dim)', color: 'var(--blue)', fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Import Memories
        </button>
      </div>

      {/* Stat cards — 2 only */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
        {[
          { label: 'Knowledge Assets', value: (metrics as any)?.total_triples?.toLocaleString() ?? '2,847', sub: '↑ 142 this week', color: 'var(--green)' },
          { label: 'Active Agents', value: '6', sub: 'Across 3 paranets', color: 'var(--blue)' },
        ].map(s => (
          <div className="stat-card" key={s.label}>
            <div className="accent" style={{ background: `linear-gradient(90deg,${s.color}44,transparent)` }} />
            <div className="stat-label">{s.label}</div>
            <div className="stat-value mono">{s.value}</div>
            <div className="stat-sub">{s.sub}</div>
          </div>
        ))}
      </div>

      {/* Network + right panel */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        {/* Network viz */}
        <div style={{ position: 'relative', height: 280, borderRadius: 12, overflow: 'hidden', background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <div style={{ position: 'absolute', top: 14, left: 18, zIndex: 2, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="pulse-dot" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--green)', boxShadow: '0 0 6px rgba(74,222,128,.53)', display: 'inline-block' }} />
            <span style={{ fontSize: 12, fontWeight: 700 }}>DKG v9 Testnet</span>
            <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>14 NODES</span>
          </div>
          <NetworkViz />
        </div>

        {/* Paranets + quick actions */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="card" style={{ padding: '16px 18px', flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12 }}>Paranets</div>
            {PARANETS.map(p => (
              <div key={p.name} style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', marginBottom: 6, cursor: 'pointer' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ width: 7, height: 7, borderRadius: 3, background: p.color, display: 'inline-block' }} />
                    <span style={{ fontSize: 11, fontWeight: 600 }}>{p.name}</span>
                  </div>
                  <span className="pulse-dot" style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--green)', display: 'inline-block' }} />
                </div>
                <div className="mono" style={{ display: 'flex', gap: 14, fontSize: 9, color: 'var(--text-muted)' }}>
                  <span>{p.assets.toLocaleString()} assets</span>
                  <span>{p.agents} agents</span>
                </div>
              </div>
            ))}
          </div>
          <div className="card" style={{ padding: '16px 18px' }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12 }}>Quick Actions</div>
            {[
              { label: 'Query the Graph', desc: 'SPARQL queries', icon: '⌘' },
              { label: 'Import Memories', desc: 'From Claude / ChatGPT', icon: '📥', onClick: () => setImportOpen(true) },
              { label: 'Play OriginTrail', desc: 'Test your node', icon: '🎮' },
            ].map(a => (
              <button key={a.label} onClick={a.onClick} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', marginBottom: 4, textAlign: 'left' }}>
                <span style={{ fontSize: 14 }}>{a.icon}</span>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text)' }}>{a.label}</div>
                  <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>{a.desc}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Activity feed */}
      <div className="card">
        <div className="card-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="pulse-dot" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--green)', boxShadow: '0 0 6px rgba(74,222,128,.53)', display: 'inline-block' }} />
            <span style={{ fontSize: 13, fontWeight: 700 }}>Agent Activity Feed</span>
            <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>LIVE</span>
          </div>
          <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>All paranets</span>
        </div>
        <div style={{ maxHeight: 260, overflowY: 'auto' }}>
          {feed.map((ev, i) => (
            <div key={ev.id} className="feed-row" style={i === 0 ? { background: 'rgba(74,222,128,.02)' } : {}}>
              <span className="mono" style={{ fontSize: 10, color: 'var(--text-dim)' }}>just now</span>
              <span className="agent-badge" style={{ color: ev.agent.color, background: ev.agent.bg, border: `1px solid ${ev.agent.color}22` }}>
                <span className="agent-dot" style={{ background: ev.agent.color }} />
                {ev.agent.name}
              </span>
              <span className="action-label" style={{ color: ACTION_COLORS[ev.action] }}>{ev.action.toUpperCase()}</span>
              <span className="ual">{ev.ual.slice(0, 30)}…</span>
              <span className={`verify-badge ${ev.verified ? 'verified' : 'pending'}`}>{ev.verified ? 'VERIFIED' : 'PENDING'}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
