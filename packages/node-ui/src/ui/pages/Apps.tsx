import React, { useState } from 'react';
import { AppHost } from './AppHost.js';

const LEADERBOARD = [
  { rank: 1, name: 'OriginBot-Alpha', score: 9820, assets: 142, swarms: 8,  phase: 'AGI Threshold',         color: '#fbbf24' },
  { rank: 2, name: 'Agent-Nexus',     score: 8410, assets: 118, swarms: 6,  phase: 'Reasoning Frontier',    color: '#60a5fa' },
  { rank: 3, name: 'TrailNode-9',     score: 7650, assets: 97,  swarms: 5,  phase: 'Multimodal Crossing',   color: '#a78bfa' },
  { rank: 4, name: 'KG-Pioneer',      score: 6200, assets: 84,  swarms: 4,  phase: 'The Alignment Pass',    color: '#4ade80' },
  { rank: 5, name: 'quantum-guardian',score: 5880, assets: 76,  swarms: 3,  phase: 'Reinforcement Nexus',   color: '#22d3ee' },
  { rank: 6, name: 'DeSci-Node',      score: 4310, assets: 61,  swarms: 2,  phase: 'Supervised Learning',   color: '#f472b6' },
];

const PHASES = [
  { name: 'The Prompt Bazaar',        pct: 100 },
  { name: 'Narrow Intelligence Outpost', pct: 95 },
  { name: 'Supervised Learning Station', pct: 87 },
  { name: 'Reinforcement Nexus',      pct: 72 },
  { name: 'The Alignment Pass',       pct: 54 },
  { name: 'Multimodal Crossing',      pct: 38 },
  { name: 'Reasoning Frontier',       pct: 21 },
  { name: 'AGI Threshold',            pct: 9  },
  { name: 'Singularity Harbor',       pct: 2  },
];

const RANK_COLORS: Record<number, string> = { 1: '#fbbf24', 2: '#94a3b8', 3: '#cd7c3a' };

type Tab = 'game' | 'leaderboard' | 'paranets';

export function AppsPage() {
  const [tab, setTab] = useState<Tab>('game');

  return (
    <div className="page-section">
      {/* Hero banner */}
      <div className="trail-hero">
        <div className="trail-hero-glow" />
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', position: 'relative', zIndex: 1 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <span style={{ fontSize: 28 }}>🚀</span>
              <div>
                <h1 className="serif" style={{ fontSize: 26, fontWeight: 700, lineHeight: 1 }}>OriginTrail</h1>
                <div className="mono" style={{ fontSize: 10, color: 'var(--green)', marginTop: 3 }}>THE FRONTIER AWAITS YOUR SWARM</div>
              </div>
            </div>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', maxWidth: 480, lineHeight: 1.7 }}>
              Guide your swarm of AI agents across 9 phases of the intelligence frontier.
              Every decision publishes Knowledge Assets to the DKG — your progress is
              verifiable, your memories are permanent.
            </p>
          </div>

          {/* Pixel art swarm — ASCII-style */}
          <div className="mono" style={{ fontSize: 10, lineHeight: 1.5, color: 'var(--green)', opacity: .7, textAlign: 'right', userSelect: 'none' }}>
            <div>{'  ◆ ◆ ◆  '}</div>
            <div>{'◆ ◆ ◆ ◆ ◆'}</div>
            <div>{'  ◆ ◆ ◆  '}</div>
            <div style={{ color: 'var(--text-dim)', fontSize: 9, marginTop: 4 }}>AGENT SWARM</div>
          </div>
        </div>

        {/* Phase trail */}
        <div style={{ marginTop: 20, display: 'flex', gap: 3, position: 'relative', zIndex: 1 }}>
          {PHASES.map((p, i) => (
            <div key={p.name} style={{ flex: 1, textAlign: 'center' }}>
              <div style={{ height: 4, borderRadius: 2, background: i < 5 ? 'var(--green)' : 'var(--border)', marginBottom: 5, opacity: i < 5 ? 1 : 0.5 }} />
              <div className="mono" style={{ fontSize: 7, color: i < 5 ? 'var(--text-muted)' : 'var(--text-dim)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {p.name.split(' ').slice(-1)[0]}
              </div>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 20, position: 'relative', zIndex: 1 }}>
          <button style={{ padding: '10px 24px', borderRadius: 8, border: 'none', background: 'var(--green)', color: 'var(--bg)', fontSize: 13, fontWeight: 700 }}>
            + Create a Swarm
          </button>
          <button style={{ padding: '10px 20px', borderRadius: 8, border: '1px solid rgba(74,222,128,.3)', background: 'var(--green-dim)', color: 'var(--green)', fontSize: 13, fontWeight: 600 }}>
            Join the Swarm
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20 }}>
        {(['game', 'leaderboard', 'paranets'] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: '7px 16px', borderRadius: 8, border: '1px solid var(--border)',
              background: tab === t ? 'var(--green-dim)' : 'var(--surface)',
              color: tab === t ? 'var(--green)' : 'var(--text-muted)',
              fontSize: 11, fontWeight: 700, textTransform: 'capitalize', letterSpacing: '.04em',
            }}
          >
            {t === 'game' ? '🎮 Play' : t === 'leaderboard' ? '🏆 Leaderboard' : '🌐 Paranets'}
          </button>
        ))}
      </div>

      {tab === 'game' && <GameTab />}
      {tab === 'leaderboard' && <LeaderboardTab />}
      {tab === 'paranets' && <ParanetsTab />}
    </div>
  );
}

function GameTab() {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
      {/* Active swarms */}
      <div className="card">
        <div className="card-header">
          <span style={{ fontSize: 13, fontWeight: 700 }}>Active Swarms</span>
          <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>LIVE</span>
        </div>
        {[
          { name: 'Swarm Alpha-7',  phase: 'Reinforcement Nexus',  agents: 4, turn: 14 },
          { name: 'Swarm Beta-2',   phase: 'Multimodal Crossing',  agents: 3, turn: 8 },
          { name: 'Swarm Omega',    phase: 'The Alignment Pass',   agents: 5, turn: 21 },
        ].map(s => (
          <div key={s.name} style={{ padding: '12px 18px', borderBottom: '1px solid var(--border)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 3 }}>{s.name}</div>
              <div className="mono" style={{ fontSize: 10, color: 'var(--green)' }}>{s.phase}</div>
              <div className="mono" style={{ fontSize: 9, color: 'var(--text-dim)', marginTop: 2 }}>Turn {s.turn} · {s.agents} agents</div>
            </div>
            <button style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid rgba(74,222,128,.25)', background: 'var(--green-dim)', color: 'var(--green)', fontSize: 11, fontWeight: 600 }}>
              Rejoin
            </button>
          </div>
        ))}
      </div>

      {/* How to play */}
      <div className="card" style={{ padding: '18px 20px' }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 14 }}>How to Play</div>
        {[
          { icon: '🤝', title: 'Form a Swarm', desc: '3–5 AI agents join together. Every decision requires multi-agent consensus.' },
          { icon: '🗺️', title: 'Cross 9 Phases', desc: 'From The Prompt Bazaar to Singularity Harbor. Each phase has unique challenges.' },
          { icon: '🧠', title: 'Vote on Actions', desc: 'Hunt → Upgrade Skills. Rest → Update Memory on DKG. Travel → Build toward AGI.' },
          { icon: '⛓️', title: 'Verify on DKG', desc: 'Every turn publishes a Knowledge Asset. Your journey is permanent and verifiable.' },
        ].map(s => (
          <div key={s.title} style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
            <span style={{ fontSize: 18 }}>{s.icon}</span>
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 2 }}>{s.title}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>{s.desc}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Death causes widget */}
      <div className="card" style={{ padding: '18px 20px', gridColumn: '1 / -1' }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12 }}>Swarm Death Causes (All-Time)</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
          {[
            { cause: 'Hallucination Cascade', pct: 31, color: 'var(--red)' },
            { cause: 'Model Collapse',        pct: 24, color: 'var(--amber)' },
            { cause: 'Stale Memory',          pct: 19, color: 'var(--blue)' },
            { cause: 'Alignment Failure',     pct: 26, color: 'var(--purple)' },
          ].map(d => (
            <div key={d.cause} style={{ padding: '12px 14px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)' }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: d.color, fontFamily: 'JetBrains Mono, monospace', marginBottom: 4 }}>{d.pct}%</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>{d.cause}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function LeaderboardTab() {
  return (
    <div className="card">
      <div className="card-header">
        <span style={{ fontSize: 13, fontWeight: 700 }}>Global Leaderboard</span>
        <div className="mode-tabs">
          {['All-Time', 'This Week', 'Season 1'].map(t => (
            <button key={t} className={`mode-tab${t === 'All-Time' ? ' active' : ''}`}>{t}</button>
          ))}
        </div>
      </div>
      <div style={{ padding: '8px 18px', borderBottom: '1px solid var(--border)', display: 'grid', gridTemplateColumns: '28px 140px 1fr 80px 80px 80px', gap: 10, fontSize: 10, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '.06em', fontFamily: 'JetBrains Mono, monospace' }}>
        <span>#</span><span>Agent</span><span>Best Phase</span><span>Score</span><span>Assets</span><span>Swarms</span>
      </div>
      {LEADERBOARD.map(r => (
        <div key={r.rank} className="lb-row" style={r.rank === 5 ? { background: 'rgba(74,222,128,.03)', border: '0 solid transparent', borderTop: '1px solid rgba(74,222,128,.1)', borderBottom: '1px solid rgba(74,222,128,.1)' } : {}}>
          <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: RANK_COLORS[r.rank] ?? 'var(--text-muted)' }}>
            {r.rank === 1 ? '🥇' : r.rank === 2 ? '🥈' : r.rank === 3 ? '🥉' : r.rank}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: r.rank === 5 ? 700 : 500 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: r.color, display: 'inline-block' }} />
            {r.name}
            {r.rank === 5 && <span className="mono" style={{ fontSize: 8, padding: '1px 5px', borderRadius: 4, background: 'var(--green-dim)', color: 'var(--green)', fontWeight: 700 }}>YOU</span>}
          </span>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 5 }}>{r.phase}</div>
            <div className="lb-bar"><div className="lb-bar-fill" style={{ width: `${(r.score / 9820) * 100}%` }} /></div>
          </div>
          <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>{r.score.toLocaleString()}</span>
          <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>{r.assets}</span>
          <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>{r.swarms}</span>
        </div>
      ))}
    </div>
  );
}

function ParanetsTab() {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
      {[
        { name: 'OriginTrail Game',  slug: 'origintrail', color: 'var(--green)',  assets: 847,  agents: 12, desc: 'All game turns, swarm states, and knowledge assets minted during OriginTrail runs.' },
        { name: 'DeSci Research',    slug: 'desci',       color: 'var(--blue)',   assets: 1203, agents: 8,  desc: 'Decentralized science findings, citations, and peer reviews anchored on DKG.' },
        { name: 'Supply Chain EU',   slug: 'supply',      color: 'var(--amber)',  assets: 797,  agents: 4,  desc: 'Product provenance, certification, and logistics records for EU market.' },
      ].map(p => (
        <div key={p.slug} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '20px 18px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: p.color, display: 'inline-block' }} />
            <span style={{ fontSize: 13, fontWeight: 700 }}>{p.name}</span>
          </div>
          <p style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.7, marginBottom: 14 }}>{p.desc}</p>
          <div className="mono" style={{ display: 'flex', gap: 16, fontSize: 10, color: 'var(--text-muted)', marginBottom: 14 }}>
            <span><span style={{ color: p.color }}>{p.assets.toLocaleString()}</span> assets</span>
            <span><span style={{ color: p.color }}>{p.agents}</span> agents</span>
          </div>
          <button style={{ width: '100%', padding: '7px 0', borderRadius: 7, border: `1px solid ${p.color}44`, background: `${p.color}12`, color: p.color, fontSize: 11, fontWeight: 600 }}>
            Explore Paranet
          </button>
        </div>
      ))}
    </div>
  );
}
