import React, { useState } from 'react';

type AppsTab = 'trail' | 'benchmark' | 'connect';

const TEAMS = [
  { name: 'DKG-Pioneers', pos: 81, health: 77, food: 55, agent: true, alive: 5, dead: 0 },
  { name: 'Thunderbolts',  pos: 72, health: 85, food: 64, agent: false, alive: 4, dead: 1 },
  { name: 'AI-Swarm-7',   pos: 68, health: 91, food: 78, agent: true,  alive: 5, dead: 0 },
  { name: 'Night Riders',  pos: 55, health: 43, food: 22, agent: false, alive: 3, dead: 2 },
  { name: 'Your Team',     pos: 47, health: 92, food: 71, agent: false, alive: 5, dead: 0 },
];

const TRAIL_EVENTS = [
  { time: '12s',  team: 'DKG-Pioneers', event: 'Forded the river successfully',     icon: '🌊' },
  { time: '28s',  team: 'AI-Swarm-7',   event: 'Traded 20 food for 2 oxen',         icon: '🐂' },
  { time: '45s',  team: 'Your Team',    event: 'Rested for 2 days — health +12',    icon: '⛺' },
  { time: '1m',   team: 'Thunderbolts', event: 'Member caught typhoid fever',        icon: '🤒' },
  { time: '2m',   team: 'Night Riders', event: 'Lost 1 member to dysentery',         icon: '💀' },
  { time: '3m',   team: 'DKG-Pioneers', event: 'Found abandoned supplies',           icon: '📦' },
  { time: '4m',   team: 'AI-Swarm-7',   event: 'Scouted ahead — clear path',         icon: '🔭' },
];

const INTEGRATIONS = [
  { name: 'LangChain',        desc: 'Use DKG as a shared memory store in LangChain agent pipelines',          status: 'docs'    },
  { name: 'CrewAI',           desc: 'Add verifiable knowledge sharing to your CrewAI agent crews',             status: 'docs'    },
  { name: 'AutoGen',          desc: 'Connect AutoGen multi-agent conversations to persistent DKG memory',      status: 'docs'    },
  { name: 'Claude (MCP)',     desc: 'Connect Claude Desktop to your DKG node via MCP — zero config',          status: 'ready'   },
  { name: 'Cursor IDE (MCP)', desc: 'Query and publish Knowledge Assets directly from your IDE',               status: 'ready'   },
  { name: 'ElizaOS',          desc: 'Give ElizaOS agents access to decentralized verified memory',             status: 'coming'  },
];

const STATUS_STYLES: Record<string, { bg: string; color: string; label: string }> = {
  ready:  { bg: 'var(--green-dim)', color: 'var(--green)',  label: 'READY'       },
  docs:   { bg: 'var(--blue-dim)',  color: 'var(--blue)',   label: 'VIEW DOCS'   },
  coming: { bg: 'var(--amber-dim)', color: 'var(--amber)',  label: 'COMING SOON' },
};

function OriginTrailGame() {
  return (
    <>
      <div className="trail-hero">
        <div className="trail-hero-glow" />
        <div style={{ position: 'relative', zIndex: 1 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--green)', letterSpacing: '0.15em', textTransform: 'uppercase', marginBottom: 8 }}>
            Node Health Check + Multi-Agent Demo
          </div>
          <h3 className="serif" style={{ fontSize: 24, fontWeight: 700, margin: '0 0 8px' }}>OriginTrail — AI Frontier Journey on DKG v9</h3>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6, maxWidth: 560, margin: '0 0 20px' }}>
            Every wagon decision is a Knowledge Asset. Every river crossing is on-chain. The leaderboard is provably fair.
            If this game works, your node is healthy, connected, and ready.
          </p>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn-green">▶ Join the Trail</button>
            <button className="btn-secondary">👁 Spectate Only</button>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 16 }}>
        {/* Leaderboard */}
        <div className="card">
          <div className="card-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="pulse-dot" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--green)', boxShadow: '0 0 6px rgba(74,222,128,0.53)', display: 'inline-block' }} />
              <span style={{ fontSize: 13, fontWeight: 700 }}>Live Leaderboard</span>
            </div>
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>OriginTrail Paranet · 847 Knowledge Assets</span>
          </div>
          {TEAMS.map((t, i) => (
            <div key={t.name} className="lb-row" style={t.name === 'Your Team' ? { background: 'rgba(74,222,128,0.03)' } : {}}>
              <span className="mono" style={{ fontSize: 14, fontWeight: 800, color: i === 0 ? 'var(--amber)' : 'var(--text-dim)' }}>#{i+1}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: t.name === 'Your Team' ? 'var(--green)' : 'var(--text)' }}>{t.name}</span>
                {t.agent && <span style={{ fontSize: 8, padding: '1px 5px', borderRadius: 3, background: 'var(--purple-dim)', color: 'var(--purple)', fontWeight: 700 }}>AI</span>}
              </div>
              <div className="lb-bar"><div className="lb-bar-fill" style={{ width: `${t.pos}%` }} /></div>
              <span className="mono" style={{ fontSize: 10, color: t.health > 70 ? 'var(--green)' : t.health > 40 ? 'var(--amber)' : 'var(--red)' }}>♥ {t.health}%</span>
              <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>🍖 {t.food}%</span>
              <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>{t.alive}👤{t.dead > 0 ? ` ${t.dead}💀` : ''}</span>
            </div>
          ))}
          <div style={{ padding: '12px 18px', fontSize: 10, color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 6 }}>
            🛡 Every position, health value, and decision is a verified Knowledge Asset on the OriginTrail paranet
          </div>
        </div>

        {/* Event Log */}
        <div className="card">
          <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)', fontSize: 13, fontWeight: 700 }}>Trail Event Log</div>
          <div style={{ maxHeight: 340, overflow: 'auto' }}>
            {TRAIL_EVENTS.map((ev, i) => (
              <div key={i} style={{ padding: '10px 18px', borderBottom: '1px solid var(--border)', fontSize: 11 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <span className="mono" style={{ fontSize: 10, color: 'var(--text-dim)' }}>{ev.time} ago</span>
                  <span style={{ fontWeight: 600, color: ev.team === 'Your Team' ? 'var(--green)' : 'var(--text)' }}>{ev.team}</span>
                </div>
                <div style={{ color: 'var(--text-muted)' }}>{ev.icon} {ev.event}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

function Benchmark() {
  return (
    <div className="card" style={{ padding: '32px 36px' }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--blue)', letterSpacing: '0.15em', textTransform: 'uppercase', marginBottom: 8 }}>
        Real-World Productivity Proof
      </div>
      <h3 className="serif" style={{ fontSize: 22, fontWeight: 700, margin: '0 0 10px' }}>Multi-Agent Coding Coordination Benchmark</h3>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6, maxWidth: 600, margin: '0 0 24px' }}>
        When multiple coding agents share a DKG-coordinated knowledge graph instead of markdown handoffs, they complete tasks faster and cheaper.
      </p>
      <div style={{ display: 'flex', gap: 20, marginBottom: 24 }}>
        <div className="bench-stat" style={{ background: 'var(--green-dim)', border: '1px solid rgba(74,222,128,0.13)' }}>
          <div className="mono" style={{ fontSize: 36, fontWeight: 800, color: 'var(--green)' }}>24%</div>
          <div style={{ fontSize: 12, color: 'var(--green)', fontWeight: 600 }}>Faster Completion</div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>Wall-clock time reduction</div>
        </div>
        <div className="bench-stat" style={{ background: 'var(--blue-dim)', border: '1px solid rgba(96,165,250,0.13)' }}>
          <div className="mono" style={{ fontSize: 36, fontWeight: 800, color: 'var(--blue)' }}>27%</div>
          <div style={{ fontSize: 12, color: 'var(--blue)', fontWeight: 600 }}>Lower Token Cost</div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>Total cost of tokens</div>
        </div>
      </div>
      <div style={{ padding: '14px 18px', borderRadius: 10, background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border)', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.7 }}>
        <strong style={{ color: 'var(--text)' }}>Why?</strong> In collaborative coding, time is lost on repeated discovery — checking assumptions, re-reading context, duplicating work. A DKG turns team knowledge into something agents can query directly.
      </div>
      <div style={{ marginTop: 24 }}>
        <button className="btn-green">▶ Run Benchmark on Your Node</button>
      </div>
    </div>
  );
}

function ConnectAgents() {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
      {INTEGRATIONS.map(int => {
        const s = STATUS_STYLES[int.status];
        return (
          <div className="int-card" key={int.name}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <span style={{ fontSize: 14, fontWeight: 700 }}>{int.name}</span>
              <span className="int-status" style={{ background: s.bg, color: s.color }}>{s.label}</span>
            </div>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5, margin: 0 }}>{int.desc}</p>
          </div>
        );
      })}
    </div>
  );
}

export function AppsPage() {
  const [tab, setTab] = useState<AppsTab>('trail');

  const TABS: { id: AppsTab; label: string; tag?: string }[] = [
    { id: 'trail',     label: '🚀 OriginTrail Game',      tag: 'HELLO WORLD' },
    { id: 'benchmark', label: '⚡ Coding Benchmark' },
    { id: 'connect',   label: '🔗 Connect Agents' },
  ];

  return (
    <div className="page-section">
      <div style={{ marginBottom: 20 }}>
        <h2 className="page-title">Apps</h2>
        <p className="page-subtitle">Connect your node to the multi-agent ecosystem — test, benchmark, and integrate</p>
      </div>

      <div className="apps-tab-row">
        {TABS.map(t => (
          <button key={t.id} className={`apps-tab${tab === t.id ? ' active' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
            {t.tag && <span className="apps-tag">{t.tag}</span>}
          </button>
        ))}
      </div>

      {tab === 'trail'     && <OriginTrailGame />}
      {tab === 'benchmark' && <Benchmark />}
      {tab === 'connect'   && <ConnectAgents />}
    </div>
  );
}
