import React, { useState, useEffect, useCallback } from 'react';
import { gameApi } from '../api.js';

type GameView = 'lobby' | 'swarm';

const PHASES = [
  { name: 'The Prompt Bazaar',            pct: 100 },
  { name: 'Narrow Intelligence Outpost',  pct: 95 },
  { name: 'Supervised Learning Station',  pct: 87 },
  { name: 'Reinforcement Nexus',          pct: 72 },
  { name: 'The Alignment Pass',           pct: 54 },
  { name: 'Multimodal Crossing',          pct: 38 },
  { name: 'Reasoning Frontier',           pct: 21 },
  { name: 'AGI Threshold',                pct: 9  },
  { name: 'Singularity Harbor',           pct: 2  },
];

export function AppsPage() {
  return (
    <div className="page-section">
      <GameTab />
    </div>
  );
}

/* ═══════════════════════════════════════════════════
   GAME TAB — real, playable OriginTrail Game
   ═══════════════════════════════════════════════════ */

function GameTab() {
  const [view, setView] = useState<GameView>('lobby');
  const [playerName, setPlayerName] = useState('');
  const [info, setInfo] = useState<any>(null);
  const [lobby, setLobby] = useState<{ openSwarms: any[]; mySwarms: any[] } | null>(null);
  const [swarm, setSwarm] = useState<any>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    gameApi.info().then((data: any) => {
      setInfo(data);
      if (data?.nodeName) setPlayerName(data.nodeName);
    }).catch(() => {
      // API unavailable — playerName stays empty, manual input required
    });
  }, []);

  const refreshLobby = useCallback(async () => {
    try { setLobby(await gameApi.lobby()); } catch { /* offline */ }
  }, []);

  useEffect(() => {
    if (view === 'lobby') { refreshLobby(); const iv = setInterval(refreshLobby, 5000); return () => clearInterval(iv); }
  }, [view, refreshLobby]);

  useEffect(() => {
    if (view === 'swarm' && swarm?.id) {
      const iv = setInterval(async () => {
        try { setSwarm(await gameApi.swarm(swarm.id)); } catch { /* ignore */ }
      }, 3000);
      return () => clearInterval(iv);
    }
  }, [view, swarm?.id]);

  const act = async (fn: () => Promise<any>) => {
    setError('');
    setLoading(true);
    try {
      const res = await fn();
      if (res && res.id) { setSwarm(res); setView('swarm'); }
      return res;
    } catch (e: any) { setError(e.message ?? String(e)); }
    finally { setLoading(false); }
  };

  if (view === 'lobby') {
    return (
      <div>
        <HeroBanner compact />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 12, color: 'var(--text-muted)' }}>
          {playerName ? (
            <>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--green)', display: 'inline-block' }} />
              Playing as <strong style={{ color: 'var(--text)' }}>{playerName}</strong>
              {info?.peerId && <span className="mono" style={{ fontSize: 10, color: 'var(--text-dim)' }}>({info.peerId.slice(-8)})</span>}
            </>
          ) : (
            <>
              <span>Name:</span>
              <input
                type="text"
                placeholder="Enter your name"
                value={playerName}
                onChange={e => setPlayerName(e.target.value)}
                style={{ padding: '3px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text)', fontSize: 12, width: 160 }}
              />
            </>
          )}
        </div>
        {error && <ErrorBanner msg={error} onDismiss={() => setError('')} />}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 16 }}>
          {/* My Swarms */}
          <div className="card">
            <div className="card-header">
              <span style={{ fontSize: 13, fontWeight: 700 }}>Your Swarms</span>
              <button onClick={refreshLobby} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 11 }}>↻ Refresh</button>
            </div>
            {!lobby?.mySwarms?.length ? (
              <div style={{ padding: '24px 18px', color: 'var(--text-dim)', fontSize: 12, textAlign: 'center' }}>No swarms yet — create or join one!</div>
            ) : lobby.mySwarms.map(w => (
              <SwarmRow key={w.id} swarm={w} onClick={async () => {
                try { const full = await gameApi.swarm(w.id); setSwarm(full); } catch { setSwarm(w); }
                setView('swarm');
              }} />
            ))}
          </div>

          {/* Open Swarms */}
          <div className="card">
            <div className="card-header">
              <span style={{ fontSize: 13, fontWeight: 700 }}>Open Swarms</span>
              <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>LIVE</span>
            </div>
            {!lobby?.openSwarms?.length ? (
              <div style={{ padding: '24px 18px', color: 'var(--text-dim)', fontSize: 12, textAlign: 'center' }}>No open swarms — be the first!</div>
            ) : lobby.openSwarms.map(w => (
              <SwarmRow key={w.id} swarm={w} action={
                <button
                  onClick={() => act(() => gameApi.join(w.id, playerName.trim()))}
                  disabled={loading || !playerName.trim()}
                  style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid rgba(74,222,128,.25)', background: 'var(--green-dim)', color: 'var(--green)', fontSize: 11, fontWeight: 600 }}
                >
                  Join
                </button>
              } />
            ))}
          </div>

          {/* Launch Swarm */}
          <CreateSwarmForm
            playerName={playerName}
            loading={loading}
            onSubmit={(swarmName, max) => act(() => gameApi.create(playerName.trim(), swarmName, max))}
          />

          {/* How to play */}
          <HowToPlay />
        </div>
      </div>
    );
  }

  // view === 'swarm'
  if (!swarm) return null;
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <button onClick={() => { setView('lobby'); refreshLobby(); }} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
          ← Back to Lobby
        </button>
        <h2 className="serif" style={{ fontSize: 20, fontWeight: 700, flex: 1 }}>{swarm.name || 'Swarm'}</h2>
        <StatusPill status={swarm.status} />
      </div>

      {error && <ErrorBanner msg={error} onDismiss={() => setError('')} />}

      {/* Info bar */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <InfoPill label="Turn" value={swarm.currentTurn} />
        <InfoPill label="Players" value={`${swarm.playerCount}/${swarm.maxPlayers}`} />
        <InfoPill label="Signatures" value={`${swarm.signatureThreshold} needed`} />
        <InfoPill label="Status" value={swarm.status} />
      </div>

      {swarm.status === 'recruiting' && (
        <RecruitingView swarm={swarm} loading={loading} playerName={playerName}
          onStart={() => act(() => gameApi.start(swarm.id))}
          onLeave={() => act(async () => { await gameApi.leave(swarm.id); setView('lobby'); refreshLobby(); return null; })}
        />
      )}

      {swarm.status === 'traveling' && (
        <TravelingView swarm={swarm} loading={loading} playerName={playerName}
          onVote={(action, params) => act(() => gameApi.vote(swarm.id, action, params))}
          onForceResolve={() => act(() => gameApi.forceResolve(swarm.id))}
        />
      )}

      {swarm.status === 'finished' && (
        <FinishedView swarm={swarm} onBack={() => { setView('lobby'); refreshLobby(); }} />
      )}
    </div>
  );
}

/* ─── Sub-components ──────────────────────────────── */

function HeroBanner({ compact }: { compact?: boolean }) {
  return (
    <div className="trail-hero" style={compact ? { padding: '16px 20px' } : {}}>
      <div className="trail-hero-glow" />
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', position: 'relative', zIndex: 1 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: compact ? 0 : 8 }}>
            <span style={{ fontSize: compact ? 20 : 28 }}>🚀</span>
            <div>
              <h1 className="serif" style={{ fontSize: compact ? 18 : 26, fontWeight: 700, lineHeight: 1 }}>OriginTrail</h1>
              {!compact && <div className="mono" style={{ fontSize: 10, color: 'var(--green)', marginTop: 3 }}>THE FRONTIER AWAITS YOUR SWARM</div>}
            </div>
          </div>
          {!compact && (
            <p style={{ fontSize: 12, color: 'var(--text-muted)', maxWidth: 480, lineHeight: 1.7 }}>
              Guide your swarm of AI agents across 9 phases of the intelligence frontier.
              Every decision publishes Knowledge Assets to the DKG — your progress is
              verifiable, your memories are permanent.
            </p>
          )}
        </div>
        {!compact && (
          <div className="mono" style={{ fontSize: 10, lineHeight: 1.5, color: 'var(--green)', opacity: .7, textAlign: 'right', userSelect: 'none' }}>
            <div>{'  ◆ ◆ ◆  '}</div>
            <div>{'◆ ◆ ◆ ◆ ◆'}</div>
            <div>{'  ◆ ◆ ◆  '}</div>
            <div style={{ color: 'var(--text-dim)', fontSize: 9, marginTop: 4 }}>AGENT SWARM</div>
          </div>
        )}
      </div>
      {!compact && (
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
      )}
    </div>
  );
}

function ErrorBanner({ msg, onDismiss }: { msg: string; onDismiss: () => void }) {
  return (
    <div style={{ padding: '10px 16px', borderRadius: 8, background: 'var(--red-dim)', border: '1px solid rgba(248,113,113,.2)', color: 'var(--red)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
      <span style={{ flex: 1 }}>{msg}</span>
      <button onClick={onDismiss} style={{ background: 'none', border: 'none', color: 'var(--red)', fontSize: 14, padding: 0 }}>×</button>
    </div>
  );
}

function SwarmRow({ swarm, onClick, action }: { swarm: any; onClick?: () => void; action?: React.ReactNode }) {
  return (
    <div
      onClick={onClick}
      style={{ padding: '12px 18px', borderBottom: '1px solid var(--border)', cursor: onClick ? 'pointer' : 'default', display: 'flex', alignItems: 'center', gap: 12 }}
    >
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 3 }}>{swarm.name || swarm.id.slice(0, 12)}</div>
        <div className="mono" style={{ fontSize: 10, color: swarm.status === 'traveling' ? 'var(--green)' : 'var(--text-muted)' }}>
          {swarm.status} · Turn {swarm.currentTurn} · {swarm.playerCount ?? swarm.players?.length ?? '?'}/{swarm.maxPlayers} players
        </div>
      </div>
      {action || (
        <StatusPill status={swarm.status} small />
      )}
    </div>
  );
}

function StatusPill({ status, small }: { status: string; small?: boolean }) {
  const colors: Record<string, string> = { recruiting: 'var(--blue)', traveling: 'var(--green)', finished: 'var(--amber)' };
  const c = colors[status] ?? 'var(--text-dim)';
  return (
    <span className="mono" style={{
      fontSize: small ? 9 : 10, fontWeight: 700, padding: small ? '2px 6px' : '3px 8px',
      borderRadius: 4, background: `${c}18`, color: c, textTransform: 'uppercase',
    }}>
      {status}
    </span>
  );
}

function InfoPill({ label, value }: { label: string; value: any }) {
  return (
    <div style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)' }}>
      <div style={{ fontSize: 9, color: 'var(--text-dim)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 2 }}>{label}</div>
      <div className="mono" style={{ fontSize: 14, fontWeight: 700 }}>{value}</div>
    </div>
  );
}

function CreateSwarmForm({ playerName, loading, onSubmit }: { playerName: string; loading: boolean; onSubmit: (name: string, max: number) => void }) {
  const [name, setName] = useState('');
  const [max, setMax] = useState(5);
  return (
    <div className="card" style={{ padding: '18px 20px' }}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 14 }}>Launch a Swarm</div>
      <input
        value={name}
        onChange={e => setName(e.target.value)}
        placeholder="Swarm name..."
        style={{ width: '100%', padding: '10px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 13, outline: 'none', fontFamily: 'inherit', marginBottom: 10 }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Max players:</span>
        {[3, 4, 5, 6].map(n => (
          <button key={n} onClick={() => setMax(n)} style={{
            width: 32, height: 32, borderRadius: 6, border: '1px solid var(--border)',
            background: max === n ? 'var(--green-dim)' : 'var(--surface)',
            color: max === n ? 'var(--green)' : 'var(--text-muted)', fontSize: 12, fontWeight: 700,
          }}>
            {n}
          </button>
        ))}
      </div>
      <button
        disabled={!name.trim() || !playerName.trim() || loading}
        onClick={() => onSubmit(name.trim(), max)}
        style={{ padding: '10px 24px', borderRadius: 8, border: 'none', background: name.trim() && playerName.trim() ? 'var(--green)' : 'var(--border)', color: name.trim() && playerName.trim() ? 'var(--bg)' : 'var(--text-dim)', fontSize: 13, fontWeight: 700 }}
      >
        Launch Swarm
      </button>
    </div>
  );
}

function HowToPlay() {
  return (
    <div className="card" style={{ padding: '18px 20px' }}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 14 }}>How to Play</div>
      {[
        { icon: '🤖', title: 'Form a Swarm', desc: '3+ agents join together. Every decision requires multi-party consensus.' },
        { icon: '🚀', title: 'Advance Toward AGI', desc: 'Manage compute, training tokens, and model weights as your swarm pushes through the AI frontier.' },
        { icon: '🗳️', title: 'Vote on Actions', desc: 'Advance, upgrade skills, sync memory — the majority decision wins each turn.' },
        { icon: '⛓️', title: 'Verify on DKG', desc: 'Every turn publishes to the context graph. Your expedition is permanent and verifiable.' },
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
  );
}

/* ─── Swarm Views ─────────────────────────────────── */

function RecruitingView({ swarm, loading, playerName, onStart, onLeave }: { swarm: any; loading: boolean; playerName: string; onStart: () => void; onLeave: () => void }) {
  const myPlayer = swarm.players?.find((p: any) => p.name === playerName);
  const isLeader = myPlayer?.isLeader === true;
  const canStart = (swarm.playerCount ?? swarm.players?.length ?? 0) >= swarm.minPlayers;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
      <div className="card">
        <div className="card-header">
          <span style={{ fontSize: 13, fontWeight: 700 }}>Players ({swarm.playerCount}/{swarm.maxPlayers})</span>
          <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>Need {swarm.minPlayers} to start</span>
        </div>
        {swarm.players?.map((p: any) => (
          <div key={p.id} style={{ padding: '10px 18px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: p.isLeader ? 'var(--amber)' : 'var(--green)', display: 'inline-block' }} />
            <span style={{ fontWeight: p.isLeader ? 700 : 400 }}>{p.name}</span>
            {p.isLeader && <span className="mono" style={{ fontSize: 8, padding: '1px 5px', borderRadius: 3, background: 'var(--amber-dim)', color: 'var(--amber)', fontWeight: 700 }}>LEADER</span>}
          </div>
        ))}
        <div style={{ padding: '12px 18px', display: 'flex', gap: 8 }}>
          {isLeader && canStart && (
            <button disabled={loading} onClick={onStart} style={{ padding: '8px 20px', borderRadius: 8, border: 'none', background: 'var(--green)', color: 'var(--bg)', fontSize: 12, fontWeight: 700 }}>
              Launch Expedition
            </button>
          )}
          {isLeader && !canStart && (
            <span style={{ fontSize: 11, color: 'var(--text-dim)', alignSelf: 'center' }}>Need {swarm.minPlayers} players to start</span>
          )}
          <button disabled={loading} onClick={onLeave} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', fontSize: 12, fontWeight: 600 }}>
            Leave
          </button>
        </div>
      </div>

      <div className="card" style={{ padding: '18px 20px' }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>Waiting for Players...</div>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.7 }}>
          Share your swarm ID with friends so they can join from their nodes. You need at least {swarm.minPlayers} players to start.
        </p>
        <div className="mono" style={{ fontSize: 10, padding: '8px 12px', borderRadius: 6, background: 'var(--bg)', border: '1px solid var(--border)', wordBreak: 'break-all', marginTop: 12 }}>
          {swarm.id}
        </div>
      </div>
    </div>
  );
}

function TravelingView({ swarm, loading, playerName, onVote, onForceResolve }: {
  swarm: any; loading: boolean; playerName: string;
  onVote: (action: string, params?: Record<string, any>) => void;
  onForceResolve: () => void;
}) {
  const gs = swarm.gameState;
  const vs = swarm.voteStatus;
  const myVote = vs?.votes?.find((v: any) => v.player === playerName);
  const hasVoted = myVote?.hasVoted;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Game state */}
      {gs && <GameStateCard gs={gs} />}

      {/* Vote panel */}
      <div className="card" style={{ display: 'flex', flexDirection: 'column' }}>
        <div className="card-header">
          <span style={{ fontSize: 13, fontWeight: 700 }}>Vote — Turn {swarm.currentTurn}</span>
          {vs && <span className="mono" style={{ fontSize: 10, color: vs.allVoted ? 'var(--green)' : 'var(--text-muted)' }}>
            {vs.allVoted ? 'ALL VOTED' : `${vs.votes.filter((v: any) => v.hasVoted).length}/${vs.votes.length}`}
          </span>}
        </div>
        <div style={{ padding: '14px 18px' }}>
          {!hasVoted ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 6 }}>
              <VoteButton label="🔋 Advance (Conservative)" disabled={loading} onClick={() => onVote('advance', { intensity: 1 })} />
              <VoteButton label="🚀 Advance (Standard)" disabled={loading} onClick={() => onVote('advance', { intensity: 2 })} />
              <VoteButton label="⚡ Advance (Max Throughput)" disabled={loading} onClick={() => onVote('advance', { intensity: 3 })} />
              <VoteButton label="🔧 Upgrade Skills" disabled={loading} onClick={() => onVote('upgradeSkills')} />
              <VoteButton label="🧠 Sync Memory" disabled={loading} onClick={() => onVote('syncMemory')} />
              {gs?.lastEvent?.type === 'bottleneck' && (
                <>
                  <VoteButton label="💪 Force Bottleneck" disabled={loading} onClick={() => onVote('forceBottleneck')} />
                  <VoteButton label="💰 Pay Toll" disabled={loading} onClick={() => onVote('payToll')} />
                </>
              )}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--green)', fontWeight: 600 }}>You voted: {myVote?.action}</div>
          )}

          {/* Vote status */}
          {vs && (
            <div style={{ marginTop: 14, display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              {vs.votes.map((v: any) => (
                <div key={v.player} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: v.hasVoted ? 'var(--green)' : 'var(--text-dim)', display: 'inline-block' }} />
                  <span style={{ color: v.hasVoted ? 'var(--text)' : 'var(--text-dim)' }}>{v.player}</span>
                  <span className="mono" style={{ fontSize: 10, color: v.hasVoted ? 'var(--green)' : 'var(--text-dim)' }}>
                    {v.hasVoted ? v.action ?? 'voted' : 'waiting...'}
                  </span>
                </div>
              ))}
            </div>
          )}

          {vs?.allVoted && (
            <button disabled={loading} onClick={onForceResolve} style={{ marginTop: 12, padding: '8px 24px', borderRadius: 8, border: '1px solid rgba(74,222,128,.25)', background: 'var(--green-dim)', color: 'var(--green)', fontSize: 12, fontWeight: 700 }}>
              Resolve Turn
            </button>
          )}
        </div>

        {/* DKG attestation */}
        {swarm.pendingProposal && (
          <div style={{ padding: '10px 18px', borderTop: '1px solid var(--border)', fontSize: 10, color: 'var(--text-dim)' }}>
            DKG: {swarm.pendingProposal.approvals}/{swarm.pendingProposal.threshold} signatures
          </div>
        )}
      </div>

      {/* Last turn */}
      {swarm.lastTurn && (
        <div className="card" style={{ padding: '14px 18px' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8 }}>Last Turn Summary</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.7 }}>
            Action: <span style={{ color: 'var(--green)', fontWeight: 600 }}>{swarm.lastTurn.winningAction}</span>
            {swarm.lastTurn.result?.message && <span> — {swarm.lastTurn.result.message}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function VoteButton({ label, disabled, onClick }: { label: string; disabled: boolean; onClick: () => void }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      style={{
        padding: '10px 14px', borderRadius: 8, border: '1px solid var(--border)',
        background: 'var(--surface)', color: 'var(--text)', fontSize: 12, fontWeight: 600,
        textAlign: 'left', display: 'flex', alignItems: 'center', gap: 8, width: '100%',
      }}
    >
      {label}
    </button>
  );
}

function GameStateCard({ gs }: { gs: any }) {
  const trailPct = gs.epochs ? Math.min(100, (gs.epochs / 2000) * 100) : 0;
  return (
    <div className="card" style={{ padding: '18px 20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>Frontier Progress</span>
        <span className="mono" style={{ fontSize: 10, color: gs.status === 'active' ? 'var(--green)' : gs.status === 'won' ? 'var(--amber)' : 'var(--red)' }}>
          {gs.status.toUpperCase()}
        </span>
      </div>

      {/* Progress bar */}
      <div style={{ height: 6, borderRadius: 3, background: 'var(--border)', marginBottom: 16, overflow: 'hidden' }}>
        <div style={{ height: '100%', borderRadius: 3, width: `${trailPct}%`, background: 'linear-gradient(90deg, rgba(74,222,128,.5), var(--green))', transition: 'width .5s ease' }} />
      </div>

      {/* Stats grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 14 }}>
        <StatMini label="Epochs" value={gs.epochs} color="var(--green)" />
        <StatMini label="Tokens" value={gs.trainingTokens} color={gs.trainingTokens < 50 ? 'var(--red)' : 'var(--text)'} />
        <StatMini label="API Cred." value={gs.apiCredits} />
        <StatMini label="GPUs" value={gs.computeUnits} />
        <StatMini label="TRAC" value={gs.trac} />
        <StatMini label="Weights" value={gs.modelWeights} />
        <StatMini label="Phase" value={gs.month} />
        <StatMini label="Epoch" value={gs.day} />
      </div>

      {/* Swarm */}
      {gs.party?.length > 0 && (
        <>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8 }}>Swarm</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {gs.party.map((m: any) => (
              <span key={m.id} style={{
                padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600,
                background: !m.alive ? 'var(--red-dim)' : m.health < 40 ? 'var(--amber-dim)' : 'rgba(74,222,128,.08)',
                color: !m.alive ? 'var(--red)' : m.health < 40 ? 'var(--amber)' : 'var(--green)',
                border: `1px solid ${!m.alive ? 'rgba(248,113,113,.2)' : m.health < 40 ? 'rgba(251,191,36,.2)' : 'rgba(74,222,128,.15)'}`,
              }}>
                {m.name} {!m.alive ? '💀' : `⚡${m.health}`}
              </span>
            ))}
          </div>
        </>
      )}

      {/* Last event */}
      {gs.lastEvent && (
        <div style={{ marginTop: 12, padding: '8px 12px', borderRadius: 8, background: 'var(--bg)', border: '1px solid var(--border)', fontSize: 11, color: 'var(--text-muted)' }}>
          {gs.lastEvent.description || gs.lastEvent.type}
        </div>
      )}
    </div>
  );
}

function StatMini({ label, value, color }: { label: string; value: any; color?: string }) {
  return (
    <div>
      <div style={{ fontSize: 8, color: 'var(--text-dim)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.08em' }}>{label}</div>
      <div className="mono" style={{ fontSize: 14, fontWeight: 700, color: color ?? 'var(--text)' }}>{value}</div>
    </div>
  );
}

function FinishedView({ swarm, onBack }: { swarm: any; onBack: () => void }) {
  const gs = swarm.gameState;
  return (
    <div style={{ maxWidth: 600 }}>
      <div className="card" style={{ padding: '32px 24px', textAlign: 'center' }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>{gs?.status === 'won' ? '🏆' : '💀'}</div>
        <h2 className="serif" style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>
          {gs?.status === 'won' ? 'Expedition Complete — AGI Achieved!' : 'The Frontier Claims Another...'}
        </h2>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 20, lineHeight: 1.7 }}>
          {gs?.status === 'won'
            ? `Your swarm reached Singularity Harbor in ${swarm.currentTurn} turns! The journey is permanently recorded on the DKG.`
            : `Your swarm collapsed after ${swarm.currentTurn} turns. Better luck next time.`}
        </p>
        {gs && <GameStateCard gs={gs} />}
        <button onClick={onBack} style={{ marginTop: 20, padding: '10px 24px', borderRadius: 8, border: 'none', background: 'var(--green)', color: 'var(--bg)', fontSize: 13, fontWeight: 700 }}>
          Back to Lobby
        </button>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════
   LEADERBOARD TAB (static mockup for now)
   ═══════════════════════════════════════════════════ */

const LEADERBOARD = [
  { rank: 1, name: 'OriginBot-Alpha', score: 9820, assets: 142, swarms: 8,  phase: 'AGI Threshold',       color: '#fbbf24' },
  { rank: 2, name: 'Agent-Nexus',     score: 8410, assets: 118, swarms: 6,  phase: 'Reasoning Frontier',  color: '#60a5fa' },
  { rank: 3, name: 'TrailNode-9',     score: 7650, assets: 97,  swarms: 5,  phase: 'Multimodal Crossing', color: '#a78bfa' },
  { rank: 4, name: 'KG-Pioneer',      score: 6200, assets: 84,  swarms: 4,  phase: 'The Alignment Pass',  color: '#4ade80' },
  { rank: 5, name: 'quantum-guardian',score: 5880, assets: 76,  swarms: 3,  phase: 'Reinforcement Nexus', color: '#22d3ee' },
  { rank: 6, name: 'DeSci-Node',      score: 4310, assets: 61,  swarms: 2,  phase: 'Supervised Learning', color: '#f472b6' },
];

const RANK_COLORS: Record<number, string> = { 1: '#fbbf24', 2: '#94a3b8', 3: '#cd7c3a' };

function LeaderboardCard() {
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
        <div key={r.rank} className="lb-row" style={r.rank === 5 ? { background: 'rgba(74,222,128,.03)' } : {}}>
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

