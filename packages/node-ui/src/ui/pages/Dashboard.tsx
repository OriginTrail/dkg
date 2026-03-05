import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { useFetch, formatDuration } from '../hooks.js';
import { fetchStatus, fetchMetrics, fetchMetricsHistory } from '../api.js';

// ─── Testnet nodes ────────────────────────────────────────────────────────────

const NODES = [
  { id: 'sentinel',         color: '#4ade80', x: 0.50, y: 0.12 },
  { id: 'MassContributor',  color: '#60a5fa', x: 0.82, y: 0.38 },
  { id: 'lupus-in-fabula',  color: '#a78bfa', x: 0.72, y: 0.80 },
  { id: 'Zivojin',          color: '#fbbf24', x: 0.28, y: 0.80 },
  { id: 'jurij-dkg-node',   color: '#22d3ee', x: 0.18, y: 0.38 },
  { id: 'openclaw-agent',   color: '#f472b6', x: 0.50, y: 0.50 },
];

const EDGES = [
  [0, 1], [1, 2], [2, 3], [3, 4], [4, 0],
  [0, 5], [1, 5], [2, 5], [3, 5], [4, 5],
];

// ─── Network Visualisation ────────────────────────────────────────────────────

interface Pulse { edge: number; t: number; dir: 1 | -1; color: string; }

function NetworkViz() {
  const W = 340; const H = 220;
  const [pulses, setPulses] = useState<Pulse[]>([]);
  const frame = useRef(0);
  const lastSpawn = useRef(0);

  useEffect(() => {
    let raf: number;
    const tick = (ts: number) => {
      // spawn a new pulse every ~600ms
      if (ts - lastSpawn.current > 600) {
        const edgeIdx = Math.floor(Math.random() * EDGES.length);
        const dir = Math.random() > 0.5 ? 1 : -1 as 1 | -1;
        const nIdx = dir === 1 ? EDGES[edgeIdx][0] : EDGES[edgeIdx][1];
        setPulses(prev => [
          ...prev.filter(p => p.t < 1),
          { edge: edgeIdx, t: 0, dir, color: NODES[nIdx].color },
        ]);
        lastSpawn.current = ts;
      }
      // advance all pulses
      setPulses(prev => prev.map(p => ({ ...p, t: p.t + 0.016 })).filter(p => p.t <= 1));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
      <defs>
        {NODES.map(n => (
          <radialGradient key={n.id} id={`ng-${n.id}`} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor={n.color} stopOpacity="0.35" />
            <stop offset="100%" stopColor={n.color} stopOpacity="0" />
          </radialGradient>
        ))}
      </defs>

      {/* Edges */}
      {EDGES.map(([a, b], i) => {
        const na = NODES[a]; const nb = NODES[b];
        return (
          <line key={i}
            x1={na.x * W} y1={na.y * H} x2={nb.x * W} y2={nb.y * H}
            stroke="#1e2a3a" strokeWidth="1"
          />
        );
      })}

      {/* Pulses */}
      {pulses.map((p, i) => {
        const [a, b] = EDGES[p.edge];
        const na = NODES[a]; const nb = NODES[b];
        const t = p.dir === 1 ? p.t : 1 - p.t;
        const cx = na.x * W + (nb.x - na.x) * W * t;
        const cy = na.y * H + (nb.y - na.y) * H * t;
        const opacity = Math.sin(p.t * Math.PI);
        return (
          <circle key={i} cx={cx} cy={cy} r={3} fill={p.color} opacity={opacity} />
        );
      })}

      {/* Node glows */}
      {NODES.map(n => (
        <circle key={`glow-${n.id}`}
          cx={n.x * W} cy={n.y * H} r={14}
          fill={`url(#ng-${n.id})`}
        />
      ))}

      {/* Node circles */}
      {NODES.map(n => (
        <g key={n.id}>
          <circle cx={n.x * W} cy={n.y * H} r={5} fill={n.color} />
          <circle cx={n.x * W} cy={n.y * H} r={8} fill="none" stroke={n.color} strokeWidth="0.8" opacity="0.5" />
        </g>
      ))}

      {/* Labels */}
      {NODES.map(n => {
        const lx = n.x * W + (n.x > 0.55 ? 12 : n.x < 0.45 ? -12 : 0);
        const ly = n.y * H + (n.y < 0.3 ? -12 : n.y > 0.6 ? 16 : 0);
        const anchor = n.x > 0.55 ? 'start' : n.x < 0.45 ? 'end' : 'middle';
        return (
          <text key={`label-${n.id}`} x={lx} y={ly}
            textAnchor={anchor} fontSize="8" fill={n.color} opacity="0.85"
            fontFamily="'JetBrains Mono', monospace">
            {n.id}
          </text>
        );
      })}
    </svg>
  );
}

// ─── Agent feed ────────────────────────────────────────────────────────────────

const AGENTS = NODES.map(n => ({ name: n.id, color: n.color, bg: `${n.color}1a` }));
const ACTIONS = ['publish', 'query', 'update', 'verify'] as const;
type Action = typeof ACTIONS[number];
const ACTION_COLORS: Record<Action, string> = {
  publish: 'var(--green)', query: 'var(--blue)', update: 'var(--amber)', verify: 'var(--purple)',
};
const rnd = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
const genUAL = () => `did:dkg:${rnd(['base', 'otp'])}:0x${Math.random().toString(16).slice(2, 8)}…/${Math.floor(Math.random() * 999999)}`;

interface FeedEvent { id: number; agent: typeof AGENTS[0]; action: Action; ual: string; ago: string; }
let _id = 0;
function genEvent(): FeedEvent {
  return { id: _id++, agent: rnd(AGENTS), action: rnd([...ACTIONS]), ual: genUAL(), ago: 'just now' };
}

function AgentBadge({ agent }: { agent: typeof AGENTS[0] }) {
  return (
    <span className="agent-badge" style={{ color: agent.color, background: agent.bg, border: `1px solid ${agent.color}22` }}>
      <span className="agent-dot" style={{ background: agent.color }} />
      {agent.name}
    </span>
  );
}

// ─── Static data ───────────────────────────────────────────────────────────────

const PARANETS = [
  { name: 'OriginTrail Game', assets: 847,  agents: 12, color: 'var(--green)' },
  { name: 'DeSci Research',   assets: 1203, agents: 8,  color: 'var(--blue)' },
  { name: 'Supply Chain EU',  assets: 797,  agents: 4,  color: 'var(--amber)' },
];

const QUICK_ACTIONS = [
  { label: 'Query the Graph',     desc: 'Run SPARQL queries',    icon: '⌘' },
  { label: 'Connect an Agent',    desc: 'MCP / HTTP integration', icon: '⚡' },
  { label: 'Play OriginTrail',    desc: 'AGI frontier journey',   icon: '🚀' },
];

type RangeKey = '1h' | '6h' | '24h' | '7d';
const RANGES: { key: RangeKey; label: string; ms: number }[] = [
  { key: '1h',  label: '1h',  ms: 3_600_000 },
  { key: '6h',  label: '6h',  ms: 6 * 3_600_000 },
  { key: '24h', label: '24h', ms: 86_400_000 },
  { key: '7d',  label: '7d',  ms: 7 * 86_400_000 },
];

// ─── Page ──────────────────────────────────────────────────────────────────────

export function DashboardPage() {
  const [rangeKey, setRangeKey] = useState<RangeKey>('24h');
  const rangeMs = RANGES.find(r => r.key === rangeKey)!.ms;

  const { data: status }  = useFetch(fetchStatus,  [], 10_000);
  const { data: metrics } = useFetch(fetchMetrics, [], 10_000);
  const fetcher = useCallback(() => fetchMetricsHistory(Date.now() - rangeMs, Date.now(), 200), [rangeMs]);
  const { data: history } = useFetch(fetcher, [rangeMs], 60_000);

  const snapshots = (history as any)?.snapshots ?? [];
  const chartData = useMemo(() => snapshots.map((s: any) => ({
    time: rangeKey === '7d'
      ? new Date(s.ts).toLocaleDateString([], { month: 'short', day: 'numeric' })
      : new Date(s.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    cpu:    s.cpu_percent ?? 0,
    heapMb: s.heap_used_bytes ? Math.round(s.heap_used_bytes / 1048576) : 0,
    peers:  s.peer_count ?? 0,
  })), [snapshots, rangeKey]);

  const [feed, setFeed] = useState<FeedEvent[]>(() => Array.from({ length: 10 }, genEvent));
  useEffect(() => {
    const t = setInterval(() => setFeed(prev => [genEvent(), ...prev].slice(0, 20)), 3000);
    return () => clearInterval(t);
  }, []);

  // Only 2 stat cards (removed Queries/hr and Verified On-Chain)
  const statCards = [
    { label: 'Knowledge Assets', value: (metrics as any)?.total_triples?.toLocaleString() ?? '2,847', sub: '↑ 142 this week', color: 'var(--green)' },
    { label: 'Active Peers',     value: String((status as any)?.connectedPeers ?? 14),               sub: '3 paranets',       color: 'var(--blue)' },
  ];

  return (
    <div className="page-section">
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h1 className="page-title">Dashboard</h1>
          <p className="page-subtitle">
            Your node is live · uptime {(status as any) ? formatDuration((status as any).uptimeMs) : '—'} · {(status as any)?.connectedPeers ?? 0} peers
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div className="range-pills">
            {RANGES.map(r => (
              <button key={r.key} className={`range-pill${rangeKey === r.key ? ' active' : ''}`} onClick={() => setRangeKey(r.key)}>{r.label}</button>
            ))}
          </div>
          <button className="btn-primary">+ Import Memories</button>
        </div>
      </div>

      {/* Stat cards — 2 wide now */}
      <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
        {statCards.map(s => (
          <div className="stat-card" key={s.label}>
            <div className="accent" style={{ background: `linear-gradient(90deg,${s.color}44,transparent)` }} />
            <div className="stat-label">{s.label}</div>
            <div className="stat-value">{s.value}</div>
            <div className="stat-sub">{s.sub}</div>
          </div>
        ))}
      </div>

      {/* Main 3-col grid: feed | network | right-panel */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 360px 280px', gap: 16 }}>

        {/* Activity Feed */}
        <div className="card">
          <div className="card-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="pulse-dot" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--green)', boxShadow: '0 0 6px rgba(74,222,128,0.53)', display: 'inline-block' }} />
              <span style={{ fontSize: 13, fontWeight: 700 }}>Agent Activity Feed</span>
              <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>LIVE</span>
            </div>
            <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>All paranets</span>
          </div>
          <div style={{ maxHeight: 300, overflow: 'auto' }}>
            {feed.map((ev, i) => (
              <div key={ev.id} className="feed-row" style={i === 0 ? { background: 'rgba(74,222,128,0.02)' } : {}}>
                <span className="mono" style={{ fontSize: 10, color: 'var(--text-dim)' }}>{ev.ago}</span>
                <AgentBadge agent={ev.agent} />
                <span className="mono" style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', color: ACTION_COLORS[ev.action] }}>{ev.action.toUpperCase()}</span>
                <span className="ual">{ev.ual}</span>
              </div>
            ))}
          </div>
          {chartData.length > 0 && (
            <div style={{ padding: '12px 18px', borderTop: '1px solid var(--border)' }}>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 8 }}>CPU · {rangeKey}</div>
              <ResponsiveContainer width="100%" height={80}>
                <AreaChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e2a3a" />
                  <XAxis dataKey="time" tick={{ fontSize: 9, fill: '#475569' }} interval="preserveStartEnd" />
                  <YAxis tick={{ fontSize: 9, fill: '#475569' }} unit="%" width={28} />
                  <Tooltip contentStyle={{ background: '#111827', border: '1px solid #1e2a3a', fontSize: 11 }} />
                  <Area type="monotone" dataKey="cpu" stroke="var(--green)" fill="rgba(74,222,128,0.08)" strokeWidth={1.5} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* Network Visualisation */}
        <div className="card" style={{ padding: '16px 18px' }}>
          <div className="card-header" style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="pulse-dot" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--blue)', boxShadow: '0 0 6px rgba(96,165,250,0.5)', display: 'inline-block' }} />
              <span style={{ fontSize: 13, fontWeight: 700 }}>DKG V9 Testnet</span>
            </div>
            <span className="mono" style={{ fontSize: 10, color: 'var(--text-dim)' }}>{NODES.length} nodes</span>
          </div>
          <NetworkViz />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 12px', marginTop: 12 }}>
            {NODES.map(n => (
              <div key={n.id} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: n.color, display: 'inline-block' }} />
                <span className="mono" style={{ fontSize: 9, color: n.color }}>{n.id}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Right column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Paranets */}
          <div className="card" style={{ padding: '16px 18px' }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 14 }}>Paranets</div>
            {PARANETS.map(p => (
              <div className="paranet-item" key={p.name}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 3, background: p.color, display: 'inline-block' }} />
                    <span style={{ fontSize: 12, fontWeight: 600 }}>{p.name}</span>
                  </div>
                  <span className="pulse-dot" style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--green)', display: 'inline-block' }} />
                </div>
                <div className="mono" style={{ display: 'flex', gap: 16, fontSize: 10, color: 'var(--text-muted)' }}>
                  <span>{p.assets.toLocaleString()} assets</span>
                  <span>{p.agents} agents</span>
                </div>
              </div>
            ))}
          </div>

          {/* Quick Actions */}
          <div className="card" style={{ padding: '16px 18px' }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 14 }}>Quick Actions</div>
            {QUICK_ACTIONS.map(a => (
              <button key={a.label} style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', marginBottom: 6, textAlign: 'left', cursor: 'pointer' }}>
                <span style={{ fontSize: 16 }}>{a.icon}</span>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{a.label}</div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{a.desc}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
