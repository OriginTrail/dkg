import React, { useState, useEffect, useCallback } from 'react';
import { api } from './api.js';
import './styles.css';

function HeroBanner() {
  return (
    <div className="ot-hero">
      <div className="ot-hero-glow" />
      <div className="ot-hero-art">
        <div className="ot-hero-scanlines" />
        <svg viewBox="0 0 600 180" xmlns="http://www.w3.org/2000/svg">
          <rect width="600" height="180" fill="#000" />
          {/* Mountains */}
          <polygon points="0,100 40,60 80,80 130,40 180,70 220,50 260,75 300,35 340,65 380,45 420,70 460,55 500,80 540,50 580,65 600,55 600,180 0,180" fill="#0a2a0a" opacity="0.8" />
          <polygon points="0,120 60,90 100,100 160,75 200,95 260,70 300,85 340,65 400,90 440,75 500,95 540,80 600,90 600,180 0,180" fill="#0d3a0d" opacity="0.6" />
          {/* Ground */}
          <rect y="140" width="600" height="40" fill="#1a5a1a" opacity="0.3" />
          <g opacity="0.4">
            <rect x="0" y="142" width="600" height="2" fill="#2a7a2a" />
            <rect x="0" y="148" width="600" height="1" fill="#1a5a1a" />
            <rect x="0" y="154" width="600" height="2" fill="#2a7a2a" />
            <rect x="0" y="160" width="600" height="1" fill="#1a5a1a" />
            <rect x="0" y="166" width="600" height="2" fill="#2a7a2a" />
          </g>
          {/* Lead Agent (Orchestrator) */}
          <g transform="translate(280,95)">
            <rect x="0" y="0" width="4" height="4" fill="#4ade80" /><rect x="4" y="0" width="4" height="4" fill="#4ade80" /><rect x="8" y="0" width="4" height="4" fill="#4ade80" />
            <rect x="-2" y="4" width="4" height="4" fill="#4ade80" /><rect x="2" y="4" width="4" height="4" fill="#4ade80" /><rect x="6" y="4" width="4" height="4" fill="#4ade80" /><rect x="10" y="4" width="4" height="4" fill="#4ade80" />
            <rect x="0" y="8" width="4" height="4" fill="#4ade80" /><rect x="4" y="8" width="4" height="4" fill="#22c55e" /><rect x="8" y="8" width="4" height="4" fill="#4ade80" />
            <rect x="0" y="12" width="4" height="4" fill="#4ade80" /><rect x="8" y="12" width="4" height="4" fill="#4ade80" />
            <rect x="2" y="-4" width="4" height="4" fill="#4ade80" /><rect x="6" y="-4" width="4" height="4" fill="#4ade80" />
            <rect x="2" y="-8" width="8" height="4" fill="#4ade80" />
            <rect x="6" y="-6" width="2" height="2" fill="#000" />
            <rect x="14" y="-2" width="4" height="2" fill="#4ade80" opacity="0.6" />
            <rect x="20" y="-4" width="4" height="2" fill="#4ade80" opacity="0.3" />
            <rect x="14" y="4" width="4" height="2" fill="#4ade80" opacity="0.4" />
          </g>
          {/* Agent 2 (Safety) */}
          <g transform="translate(240,102)">
            <rect x="0" y="0" width="4" height="4" fill="#60a5fa" /><rect x="4" y="0" width="4" height="4" fill="#60a5fa" />
            <rect x="-2" y="4" width="4" height="4" fill="#60a5fa" /><rect x="2" y="4" width="4" height="4" fill="#60a5fa" /><rect x="6" y="4" width="4" height="4" fill="#60a5fa" />
            <rect x="0" y="8" width="4" height="4" fill="#60a5fa" /><rect x="4" y="8" width="4" height="4" fill="#60a5fa" />
            <rect x="0" y="12" width="4" height="4" fill="#60a5fa" /><rect x="4" y="12" width="4" height="4" fill="#60a5fa" />
            <rect x="0" y="-4" width="8" height="4" fill="#60a5fa" />
            <rect x="4" y="-2" width="2" height="2" fill="#000" />
          </g>
          {/* Agent 3 (Infrastructure) */}
          <g transform="translate(325,102)">
            <rect x="0" y="0" width="4" height="4" fill="#a78bfa" /><rect x="4" y="0" width="4" height="4" fill="#a78bfa" />
            <rect x="-2" y="4" width="4" height="4" fill="#a78bfa" /><rect x="2" y="4" width="4" height="4" fill="#a78bfa" /><rect x="6" y="4" width="4" height="4" fill="#a78bfa" />
            <rect x="0" y="8" width="4" height="4" fill="#a78bfa" /><rect x="4" y="8" width="4" height="4" fill="#a78bfa" />
            <rect x="0" y="12" width="4" height="4" fill="#a78bfa" /><rect x="4" y="12" width="4" height="4" fill="#a78bfa" />
            <rect x="0" y="-4" width="8" height="4" fill="#a78bfa" />
            <rect x="4" y="-2" width="2" height="2" fill="#000" />
          </g>
          {/* Agent 4 (Data Curator) */}
          <g transform="translate(218,112)">
            <rect x="0" y="0" width="4" height="4" fill="#fbbf24" /><rect x="4" y="0" width="4" height="4" fill="#fbbf24" />
            <rect x="0" y="4" width="4" height="4" fill="#fbbf24" /><rect x="4" y="4" width="4" height="4" fill="#fbbf24" />
            <rect x="0" y="8" width="4" height="4" fill="#fbbf24" /><rect x="4" y="8" width="4" height="4" fill="#fbbf24" />
            <rect x="0" y="-4" width="8" height="4" fill="#fbbf24" />
            <rect x="4" y="-2" width="2" height="2" fill="#000" />
          </g>
          {/* Agent 5 (Retrieval) */}
          <g transform="translate(348,112)">
            <rect x="0" y="0" width="4" height="4" fill="#22d3ee" /><rect x="4" y="0" width="4" height="4" fill="#22d3ee" />
            <rect x="0" y="4" width="4" height="4" fill="#22d3ee" /><rect x="4" y="4" width="4" height="4" fill="#22d3ee" />
            <rect x="0" y="8" width="4" height="4" fill="#22d3ee" /><rect x="4" y="8" width="4" height="4" fill="#22d3ee" />
            <rect x="0" y="-4" width="8" height="4" fill="#22d3ee" />
            <rect x="4" y="-2" width="2" height="2" fill="#000" />
          </g>
          {/* Connection lines */}
          <line x1="252" y1="106" x2="280" y2="99" stroke="#4ade80" strokeWidth="1" opacity="0.3" strokeDasharray="2,3" />
          <line x1="333" y1="106" x2="310" y2="99" stroke="#4ade80" strokeWidth="1" opacity="0.3" strokeDasharray="2,3" />
          <line x1="230" y1="116" x2="250" y2="108" stroke="#4ade80" strokeWidth="1" opacity="0.2" strokeDasharray="2,3" />
          <line x1="356" y1="116" x2="337" y2="108" stroke="#4ade80" strokeWidth="1" opacity="0.2" strokeDasharray="2,3" />
          <line x1="252" y1="108" x2="325" y2="108" stroke="#4ade80" strokeWidth="1" opacity="0.15" strokeDasharray="2,4" />
          {/* Data particles */}
          <circle cx="265" cy="102" r="1.5" fill="#4ade80" opacity="0.7">
            <animate attributeName="cx" values="252;280;252" dur="2s" repeatCount="indefinite" />
          </circle>
          <circle cx="318" cy="102" r="1.5" fill="#a78bfa" opacity="0.7">
            <animate attributeName="cx" values="310;333;310" dur="2.5s" repeatCount="indefinite" />
          </circle>
          <circle cx="290" cy="108" r="1" fill="#fbbf24" opacity="0.5">
            <animate attributeName="cx" values="252;348;252" dur="4s" repeatCount="indefinite" />
          </circle>
        </svg>
        <div className="ot-hero-title"><span>ORIGINTRAIL GAME</span></div>
      </div>
      <div className="ot-hero-body">
        <div className="ot-hero-label">AI Frontier Journey on DKG v9</div>
        <h3 className="ot-hero-heading">Lead your agent swarm to Singularity Harbor</h3>
        <p className="ot-hero-desc">
          2,000 epochs across the AI Frontier. Every decision is a Knowledge Asset.
          Every outcome is verified by the <strong style={{ color: '#4ade80' }}>Context Oracle</strong>.
        </p>
        <p className="ot-hero-tagline">Your swarm will not die of dysentery. But it might die of hallucinations.</p>
      </div>
    </div>
  );
}

export function App() {
  const [playerName, setName] = useState('');
  const [nodeInfo, setNodeInfo] = useState<any>(null);
  const [view, setView] = useState<'lobby' | 'swarm'>('lobby');
  const [lobby, setLobby] = useState<any>(null);
  const [swarm, setSwarm] = useState<any>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.info().then((data: any) => {
      setNodeInfo(data);
      if (data?.nodeName) setName(data.nodeName);
    }).catch(() => {});
  }, []);

  const refreshLobby = useCallback(async () => {
    try { setLobby(await api.lobby()); } catch (e: any) { setError(e.message); }
  }, []);

  const refreshSwarm = useCallback(async (swarmId: string) => {
    try { setSwarm(await api.swarm(swarmId)); } catch (e: any) { setError(e.message); }
  }, []);

  useEffect(() => {
    if (view === 'lobby') refreshLobby();
  }, [view, refreshLobby]);

  useEffect(() => {
    if (view !== 'swarm' || !swarm) return;
    const interval = setInterval(() => refreshSwarm(swarm.id), 3000);
    return () => clearInterval(interval);
  }, [view, swarm?.id, refreshSwarm]);

  if (view === 'lobby') {
    return (
      <div className="ot-container">
        <HeroBanner />
        <div className="ot-header">
          <h1>OriginTrail Game</h1>
          <span className="ot-player">Playing as: {playerName}</span>
        </div>

        <div className="ot-section">
          <h2>Your Swarms</h2>
          {lobby?.mySwarms?.length ? lobby.mySwarms.map((w: any) => (
            <div key={w.id} className="ot-card ot-clickable" onClick={async () => {
              try { const fresh = await api.swarm(w.id); setSwarm(fresh); setView('swarm'); }
              catch (e: any) { setError(e.message); }
            }}>
              <strong>{w.name}</strong> — {w.players?.length ?? 0} players — {w.status}
            </div>
          )) : <p className="ot-muted">No swarms yet</p>}
        </div>

        <div className="ot-section">
          <h2>Open Swarms</h2>
          {lobby?.openSwarms?.length ? lobby.openSwarms.map((w: any) => (
            <div key={w.id} className="ot-card">
              <strong>{w.name}</strong> — {w.players?.length ?? 0}/{w.maxPlayers} players
              <button onClick={async () => {
                try { setLoading(true); const res = await api.join(w.id, playerName); setSwarm(res); setView('swarm'); }
                catch (e: any) { setError(e.message); } finally { setLoading(false); }
              }} disabled={loading}>Join</button>
            </div>
          )) : <p className="ot-muted">No open swarms</p>}
        </div>

        <div className="ot-section">
          <h2>Launch Swarm</h2>
          <CreateSwarmForm playerName={playerName} onCreated={(w) => { setSwarm(w); setView('swarm'); }} onError={setError} />
        </div>

        <button className="ot-secondary" onClick={refreshLobby}>Refresh</button>
        {error && <div className="ot-error">{error}</div>}
      </div>
    );
  }

  if (view === 'swarm' && swarm) {
    return (
      <div className="ot-container">
        <HeroBanner />
        <div className="ot-header">
          <h1>{swarm.name}</h1>
          <button className="ot-secondary" onClick={() => setView('lobby')}>Back to Lobby</button>
        </div>

        <div className="ot-status-bar">
          <span>Status: <strong>{swarm.status}</strong></span>
          <span>Turn: <strong>{swarm.currentTurn}</strong></span>
          <span>Players: <strong>{swarm.playerCount}</strong></span>
          <span>Signatures needed: <strong>{swarm.signatureThreshold}</strong></span>
        </div>

        {swarm.pendingProposal && (
          <div className="ot-card ot-proposal">
            Consensus: {swarm.pendingProposal.approvals}/{swarm.pendingProposal.threshold} approvals for turn {swarm.pendingProposal.turn}
          </div>
        )}

        {swarm.status === 'recruiting' && (
          <div className="ot-card">
            <h3>Waiting for players ({swarm.playerCount}/{swarm.minPlayers} minimum)</h3>
            <ul>{swarm.players.map((p: any) => <li key={p.id}>{p.name} {p.isLeader ? '(GM)' : ''}</li>)}</ul>
            {swarm.leaderId === nodeInfo?.peerId && swarm.playerCount >= swarm.minPlayers && (
              <button onClick={async () => {
                try { const res = await api.start(swarm.id); setSwarm(res); }
                catch (e: any) { setError(e.message); }
              }}>Start Journey</button>
            )}
          </div>
        )}

        {swarm.status === 'traveling' && swarm.gameState && (
          <>
            <GameStateDisplay state={swarm.gameState} />
            <VotePanel swarm={swarm} peerId={nodeInfo?.peerId} onVoted={(w) => setSwarm(w)} onError={setError} />
            {swarm.lastTurn && (
              <div className="ot-card">
                <h3>Last Turn</h3>
                <p><strong>Action:</strong> {swarm.lastTurn.winningAction}</p>
                <p>{swarm.lastTurn.resultMessage}</p>
                <p className="ot-muted">Approved by {swarm.lastTurn.approvers?.length ?? 0} nodes</p>
              </div>
            )}
          </>
        )}

        {swarm.status === 'finished' && swarm.gameState && (
          <div className="ot-card">
            <h2>{swarm.gameState.status === 'won' ? 'AGI Achieved — Singularity Harbor!' : 'Your expedition has ended.'}</h2>
            <GameStateDisplay state={swarm.gameState} />
          </div>
        )}

        {error && <div className="ot-error">{error}</div>}
      </div>
    );
  }

  return null;
}

function GameStateDisplay({ state }: { state: any }) {
  return (
    <div className="ot-game-state">
      <div className="ot-stats">
        <div><label>Epochs</label><span>{state.epochs} / 2000</span></div>
        <div><label>Tokens</label><span>{state.trainingTokens}</span></div>
        <div><label>API Credits</label><span>{state.apiCredits}</span></div>
        <div><label>GPUs</label><span>{state.computeUnits}</span></div>
        <div><label>TRAC</label><span>{state.trac}</span></div>
        <div><label>Date</label><span>Epoch {state.epochs}</span></div>
      </div>
      <div className="ot-trail-bar">
        <div className="ot-trail-fill" style={{ width: `${Math.min(100, (state.epochs / 2000) * 100)}%` }} />
      </div>
      <div className="ot-party">
        <h4>Swarm</h4>
        {state.party.map((m: any) => (
          <div key={m.id} className={`ot-member ${!m.alive ? 'ot-dead' : m.health < 40 ? 'ot-sick' : ''}`}>
            {m.name} — {m.alive ? `${m.health} HP` : 'Deceased'}
          </div>
        ))}
      </div>
    </div>
  );
}

function VotePanel({ swarm, peerId, onVoted, onError }: { swarm: any; peerId?: string; onVoted: (w: any) => void; onError: (e: string) => void }) {
  const myVoteEntry = swarm.voteStatus?.votes?.find((v: any) => v.peerId === peerId);
  const hasVoted = !!myVoteEntry?.hasVoted;

  const doVote = async (action: string, params?: Record<string, any>) => {
    try { onVoted(await api.vote(swarm.id, action, params)); }
    catch (e: any) { onError(e.message); }
  };

  return (
    <div className="ot-card">
      <h3>Vote for Turn {swarm.currentTurn}</h3>
      {hasVoted && <p className="ot-muted">You have voted. Waiting for others...</p>}
      <div className="ot-vote-grid">
        <button onClick={() => doVote('advance', { intensity: 1 })} disabled={hasVoted}>Advance (Conservative)</button>
        <button onClick={() => doVote('advance', { intensity: 2 })} disabled={hasVoted}>Advance (Standard)</button>
        <button onClick={() => doVote('advance', { intensity: 3 })} disabled={hasVoted}>Advance (Max Throughput)</button>
        <button onClick={() => doVote('upgradeSkills')} disabled={hasVoted}>Upgrade Skills</button>
        <button onClick={() => doVote('syncMemory')} disabled={hasVoted}>Sync Memory</button>
        <button onClick={() => doVote('forceBottleneck')} disabled={hasVoted}>Force Bottleneck</button>
        <button onClick={() => doVote('payToll')} disabled={hasVoted}>Pay Toll</button>
      </div>
      <div className="ot-vote-status">
        <h4>Votes ({swarm.voteStatus?.votes?.filter((v: any) => v.hasVoted).length}/{swarm.playerCount})</h4>
        {swarm.voteStatus?.votes?.map((v: any, i: number) => (
          <div key={i}>{v.player}: {v.hasVoted ? (v.action || 'voted') : 'waiting...'}</div>
        ))}
      </div>
      {swarm.leaderId === peerId && (
        <button className="ot-secondary" onClick={async () => {
          try { onVoted(await api.forceResolve(swarm.id)); }
          catch (e: any) { onError(e.message); }
        }}>Force Resolve Turn</button>
      )}
    </div>
  );
}

function CreateSwarmForm({ playerName, onCreated, onError }: { playerName: string; onCreated: (w: any) => void; onError: (e: string) => void }) {
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);

  return (
    <div className="ot-card">
      <input value={name} onChange={e => setName(e.target.value)} placeholder="Swarm name..." />
      <button disabled={!name.trim() || loading} onClick={async () => {
        try { setLoading(true); onCreated(await api.create(playerName, name)); }
        catch (e: any) { onError(e.message); } finally { setLoading(false); }
      }}>Launch Swarm</button>
    </div>
  );
}
