import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { api } from './api.js';
import { RdfGraph } from '@origintrail-official/dkg-graph-viz/react';
import './styles.css';

type Triple = { subject: string; predicate: string; object: string };

const OT = 'https://origintrail-game.dkg.io/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SCHEMA_NAME = 'https://schema.org/name';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

function HeroBanner() {
  return (
    <div className="ot-hero">
      <div className="ot-hero-glow" />
      <div className="ot-hero-art">
        <div className="ot-hero-scanlines" />
        <svg viewBox="0 0 600 180" xmlns="http://www.w3.org/2000/svg">
          <rect width="600" height="180" fill="#000" />
          <polygon points="0,100 40,60 80,80 130,40 180,70 220,50 260,75 300,35 340,65 380,45 420,70 460,55 500,80 540,50 580,65 600,55 600,180 0,180" fill="#0a2a0a" opacity="0.8" />
          <polygon points="0,120 60,90 100,100 160,75 200,95 260,70 300,85 340,65 400,90 440,75 500,95 540,80 600,90 600,180 0,180" fill="#0d3a0d" opacity="0.6" />
          <rect y="140" width="600" height="40" fill="#1a5a1a" opacity="0.3" />
          <g opacity="0.4">
            <rect x="0" y="142" width="600" height="2" fill="#2a7a2a" />
            <rect x="0" y="148" width="600" height="1" fill="#1a5a1a" />
            <rect x="0" y="154" width="600" height="2" fill="#2a7a2a" />
            <rect x="0" y="160" width="600" height="1" fill="#1a5a1a" />
            <rect x="0" y="166" width="600" height="2" fill="#2a7a2a" />
          </g>
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
          <g transform="translate(240,102)">
            <rect x="0" y="0" width="4" height="4" fill="#60a5fa" /><rect x="4" y="0" width="4" height="4" fill="#60a5fa" />
            <rect x="-2" y="4" width="4" height="4" fill="#60a5fa" /><rect x="2" y="4" width="4" height="4" fill="#60a5fa" /><rect x="6" y="4" width="4" height="4" fill="#60a5fa" />
            <rect x="0" y="8" width="4" height="4" fill="#60a5fa" /><rect x="4" y="8" width="4" height="4" fill="#60a5fa" />
            <rect x="0" y="12" width="4" height="4" fill="#60a5fa" /><rect x="4" y="12" width="4" height="4" fill="#60a5fa" />
            <rect x="0" y="-4" width="8" height="4" fill="#60a5fa" />
            <rect x="4" y="-2" width="2" height="2" fill="#000" />
          </g>
          <g transform="translate(325,102)">
            <rect x="0" y="0" width="4" height="4" fill="#a78bfa" /><rect x="4" y="0" width="4" height="4" fill="#a78bfa" />
            <rect x="-2" y="4" width="4" height="4" fill="#a78bfa" /><rect x="2" y="4" width="4" height="4" fill="#a78bfa" /><rect x="6" y="4" width="4" height="4" fill="#a78bfa" />
            <rect x="0" y="8" width="4" height="4" fill="#a78bfa" /><rect x="4" y="8" width="4" height="4" fill="#a78bfa" />
            <rect x="0" y="12" width="4" height="4" fill="#a78bfa" /><rect x="4" y="12" width="4" height="4" fill="#a78bfa" />
            <rect x="0" y="-4" width="8" height="4" fill="#a78bfa" />
            <rect x="4" y="-2" width="2" height="2" fill="#000" />
          </g>
          <g transform="translate(218,112)">
            <rect x="0" y="0" width="4" height="4" fill="#fbbf24" /><rect x="4" y="0" width="4" height="4" fill="#fbbf24" />
            <rect x="0" y="4" width="4" height="4" fill="#fbbf24" /><rect x="4" y="4" width="4" height="4" fill="#fbbf24" />
            <rect x="0" y="8" width="4" height="4" fill="#fbbf24" /><rect x="4" y="8" width="4" height="4" fill="#fbbf24" />
            <rect x="0" y="-4" width="8" height="4" fill="#fbbf24" />
            <rect x="4" y="-2" width="2" height="2" fill="#000" />
          </g>
          <g transform="translate(348,112)">
            <rect x="0" y="0" width="4" height="4" fill="#22d3ee" /><rect x="4" y="0" width="4" height="4" fill="#22d3ee" />
            <rect x="0" y="4" width="4" height="4" fill="#22d3ee" /><rect x="4" y="4" width="4" height="4" fill="#22d3ee" />
            <rect x="0" y="8" width="4" height="4" fill="#22d3ee" /><rect x="4" y="8" width="4" height="4" fill="#22d3ee" />
            <rect x="0" y="-4" width="8" height="4" fill="#22d3ee" />
            <rect x="4" y="-2" width="2" height="2" fill="#000" />
          </g>
          <line x1="252" y1="106" x2="280" y2="99" stroke="#4ade80" strokeWidth="1" opacity="0.3" strokeDasharray="2,3" />
          <line x1="333" y1="106" x2="310" y2="99" stroke="#4ade80" strokeWidth="1" opacity="0.3" strokeDasharray="2,3" />
          <line x1="230" y1="116" x2="250" y2="108" stroke="#4ade80" strokeWidth="1" opacity="0.2" strokeDasharray="2,3" />
          <line x1="356" y1="116" x2="337" y2="108" stroke="#4ade80" strokeWidth="1" opacity="0.2" strokeDasharray="2,3" />
          <line x1="252" y1="108" x2="325" y2="108" stroke="#4ade80" strokeWidth="1" opacity="0.15" strokeDasharray="2,4" />
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
          Every outcome is verified by the <strong style={{ color: 'var(--green)' }}>Context Oracle</strong>.
        </p>
        <p className="ot-hero-tagline">Your swarm will not die of dysentery. But it might die of hallucinations.</p>
      </div>
    </div>
  );
}

const ACTION_LABELS: Record<string, string> = {
  advance: 'Advance',
  upgradeSkills: 'Upgrade Skills',
  syncMemory: 'Sync Memory via DKG',
  forceBottleneck: 'Force Bottleneck',
  payToll: 'Pay Toll',
  trade: 'Trade',
};
const ACTION_ICONS: Record<string, string> = {
  advance: '→',
  upgradeSkills: '⬆',
  syncMemory: '🔗',
  forceBottleneck: '⚡',
  payToll: '💰',
  trade: '🔄',
};

const RESOLUTION_LABELS: Record<string, { label: string; color: string }> = {
  'consensus': { label: 'Consensus', color: 'var(--green)' },
  'leader-tiebreak': { label: 'Leader Tiebreak', color: 'var(--orange)' },
  'force-resolved': { label: 'Force Resolved', color: 'var(--red)' },
};

function escapeLiteral(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

function lit(value: string | number): string {
  return `"${escapeLiteral(String(value))}"`;
}

function uriSegment(s: string): string {
  return encodeURIComponent(s);
}

/**
 * Build rich RDF triples from the game's own ontology. Uses the same URIs
 * as rdf.ts so the graph is consistent with what the DKG stores.
 */
function buildContextTriples(swarm: any): Triple[] {
  const triples: Triple[] = [];
  const gs = swarm.gameState;
  if (!gs) return triples;

  const swarmUri = `${OT}swarm/${swarm.id}`;

  triples.push({ subject: swarmUri, predicate: RDF_TYPE, object: `${OT}AgentSwarm` });
  triples.push({ subject: swarmUri, predicate: SCHEMA_NAME, object: lit(swarm.name) });
  triples.push({ subject: swarmUri, predicate: `${OT}status`, object: lit(gs.status) });
  triples.push({ subject: swarmUri, predicate: `${OT}epochs`, object: lit(`${gs.epochs}/2000`) });

  // Party members
  for (const m of gs.party ?? []) {
    const agentUri = `${OT}agent/${uriSegment(m.name)}`;
    triples.push({ subject: swarmUri, predicate: `${OT}hasMember`, object: agentUri });
    triples.push({ subject: agentUri, predicate: RDF_TYPE, object: m.alive ? `${OT}Agent` : `${OT}DeadAgent` });
    triples.push({ subject: agentUri, predicate: SCHEMA_NAME, object: lit(m.name) });
    triples.push({ subject: agentUri, predicate: `${OT}health`, object: lit(`${m.health} HP`) });
  }

  // Current resources
  const resUri = `${OT}swarm/${swarm.id}/resources`;
  triples.push({ subject: swarmUri, predicate: `${OT}resources`, object: resUri });
  triples.push({ subject: resUri, predicate: RDF_TYPE, object: `${OT}ResourceState` });
  triples.push({ subject: resUri, predicate: `${OT}trainingTokens`, object: lit(gs.trainingTokens) });
  triples.push({ subject: resUri, predicate: `${OT}apiCredits`, object: lit(gs.apiCredits) });
  triples.push({ subject: resUri, predicate: `${OT}computeUnits`, object: lit(gs.computeUnits) });
  triples.push({ subject: resUri, predicate: `${OT}trac`, object: lit(gs.trac) });

  // Turn history — decision trace as linked knowledge graph
  const history: any[] = swarm.turnHistory ?? [];
  let prevTurnUri: string | null = null;

  for (const turn of history) {
    const turnUri = `${OT}swarm/${swarm.id}/turn/${turn.turn}`;
    triples.push({ subject: turnUri, predicate: RDF_TYPE, object: `${OT}TurnResult` });
    triples.push({ subject: turnUri, predicate: `${OT}turn`, object: lit(`Turn ${turn.turn}`) });
    triples.push({ subject: turnUri, predicate: `${OT}swarm`, object: swarmUri });

    // Action decided
    const actionUri = `${OT}action/${turn.winningAction}`;
    triples.push({ subject: turnUri, predicate: `${OT}winningAction`, object: actionUri });
    triples.push({ subject: actionUri, predicate: RDF_TYPE, object: `${OT}Action` });
    triples.push({ subject: actionUri, predicate: RDFS_LABEL, object: lit(ACTION_LABELS[turn.winningAction] ?? turn.winningAction) });

    // Result
    if (turn.resultMessage) {
      const resultUri = `${OT}swarm/${swarm.id}/turn/${turn.turn}/result`;
      triples.push({ subject: turnUri, predicate: `${OT}result`, object: resultUri });
      triples.push({ subject: resultUri, predicate: RDF_TYPE, object: `${OT}Outcome` });
      triples.push({ subject: resultUri, predicate: RDFS_LABEL, object: lit(turn.resultMessage) });
    }

    // Resolution method
    const resolution = turn.resolution ?? 'consensus';
    triples.push({ subject: turnUri, predicate: `${OT}resolution`, object: lit(resolution) });

    // Per-player votes — use peerId as stable identifier, fall back to display name
    for (const v of turn.votes ?? []) {
      const voterId = v.peerId ?? uriSegment(v.displayName ?? 'unknown');
      const voterUri = `${OT}player/${voterId}`;
      const voteUri = `${OT}swarm/${swarm.id}/turn/${turn.turn}/vote/${voterId}`;
      triples.push({ subject: turnUri, predicate: `${OT}hasVote`, object: voteUri });
      triples.push({ subject: voteUri, predicate: RDF_TYPE, object: `${OT}Vote` });
      triples.push({ subject: voteUri, predicate: `${OT}voter`, object: voterUri });
      triples.push({ subject: voteUri, predicate: `${OT}votedAction`, object: lit(ACTION_LABELS[v.action] ?? v.action) });
      triples.push({ subject: voterUri, predicate: RDF_TYPE, object: `${OT}Player` });
      triples.push({ subject: voterUri, predicate: SCHEMA_NAME, object: lit(v.displayName ?? v.peerId?.slice(-8) ?? 'Unknown') });
    }

    // Deaths
    for (const d of turn.deaths ?? []) {
      const name = typeof d === 'string' ? d : d.name;
      const cause = typeof d === 'string' ? null : d.cause;
      const deathUri = `${OT}swarm/${swarm.id}/turn/${turn.turn}/death/${uriSegment(name)}`;
      const agentUri = `${OT}agent/${uriSegment(name)}`;
      triples.push({ subject: turnUri, predicate: `${OT}hasDeath`, object: deathUri });
      triples.push({ subject: deathUri, predicate: RDF_TYPE, object: `${OT}DeathEvent` });
      triples.push({ subject: deathUri, predicate: RDFS_LABEL, object: lit(`${name} perished`) });
      triples.push({ subject: deathUri, predicate: `${OT}agent`, object: agentUri });
      if (cause) triples.push({ subject: deathUri, predicate: `${OT}causeOfDeath`, object: lit(cause) });
    }

    // Game event
    if (turn.event) {
      const eventUri = `${OT}swarm/${swarm.id}/turn/${turn.turn}/event`;
      triples.push({ subject: turnUri, predicate: `${OT}hasEvent`, object: eventUri });
      triples.push({ subject: eventUri, predicate: RDF_TYPE, object: `${OT}GameEvent` });
      triples.push({ subject: eventUri, predicate: RDFS_LABEL, object: lit(turn.event.description) });
    }

    // Temporal chain
    if (prevTurnUri) {
      triples.push({ subject: prevTurnUri, predicate: `${OT}nextTurn`, object: turnUri });
    }
    prevTurnUri = turnUri;
  }

  if (prevTurnUri) {
    triples.push({ subject: swarmUri, predicate: `${OT}currentTurn`, object: prevTurnUri });
  }

  return triples;
}

const GRAPH_VIEW_CONFIG = {
  name: 'OriginTrail Game',
  palette: 'dark' as const,
  paletteOverrides: {
    background: '#0e1117',
    nodeDefault: '#3fb950',
    edgeDefault: 'rgba(88,166,255,0.25)',
    text: '#c9d1d9',
  },
};

/** The live knowledge graph visualization */
function ContextGraphPanel({ swarm }: { swarm: any }) {
  const triples = useMemo(() => buildContextTriples(swarm), [
    swarm?.turnHistory?.length,
    swarm?.gameState?.epochs,
    swarm?.gameState?.status,
  ]);

  if (triples.length === 0) {
    return (
      <div className="ot-graph-empty">
        <div className="ot-empty-state">
          <div className="ot-empty-state-icon ot-empty-state-icon--sm">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><circle cx="19" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><line x1="14.5" y1="9.5" x2="17.5" y2="6.5"/><line x1="9.5" y1="14.5" x2="6.5" y2="17.5"/></svg>
          </div>
          <div className="ot-empty-state-title">Context graph</div>
          <div className="ot-empty-state-desc">The knowledge graph will build as your swarm makes decisions and the journey progresses.</div>
        </div>
      </div>
    );
  }

  return (
    <RdfGraph
      data={triples}
      format="triples"
      options={{
        labelMode: 'humanized' as any,
        renderer: '2d',
        labels: {
          predicates: [
            SCHEMA_NAME,
            RDFS_LABEL,
            `${OT}health`,
            `${OT}turn`,
            `${OT}epochs`,
            `${OT}status`,
            `${OT}votedAction`,
            `${OT}resolution`,
          ],
        },
        style: {
          classColors: {
            [`${OT}AgentSwarm`]: '#4ade80',
            [`${OT}Agent`]: '#60a5fa',
            [`${OT}DeadAgent`]: '#f85149',
            [`${OT}TurnResult`]: '#a78bfa',
            [`${OT}Action`]: '#fbbf24',
            [`${OT}Outcome`]: '#22d3ee',
            [`${OT}ResourceState`]: '#d29922',
            [`${OT}Player`]: '#8b949e',
            [`${OT}Vote`]: '#f0883e',
            [`${OT}DeathEvent`]: '#da3633',
            [`${OT}GameEvent`]: '#d29922',
          },
        },
        physics: { enabled: true, solver: 'forceAtlas2', gravity: -25, springLength: 90 },
        node: { label: true, size: 5 },
        edge: { label: false },
        hexagon: { baseSize: 4, minSize: 3, maxSize: 6, scaleWithDegree: true },
        focus: { maxNodes: 500, hops: 999 },
      }}
      viewConfig={GRAPH_VIEW_CONFIG}
      style={{ position: 'absolute', inset: 0 }}
    />
  );
}

/** Decision trace — scrollable timeline of resolved turns */
function DecisionTrace({ swarm }: { swarm: any }) {
  const history: any[] = swarm.turnHistory ?? [];
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevLen = useRef(0);

  useEffect(() => {
    if (history.length > prevLen.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    prevLen.current = history.length;
  }, [history.length]);

  if (history.length === 0) {
    return (
      <div className="ot-trace-empty">
        <div className="ot-empty-state">
          <div className="ot-empty-state-icon ot-empty-state-icon--sm">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
          </div>
          <div className="ot-empty-state-title">No decisions yet</div>
          <div className="ot-empty-state-desc">The decision trace will appear here as your swarm votes and turns resolve.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="ot-trace-scroll" ref={scrollRef}>
      {history.map((turn: any) => {
        const res = RESOLUTION_LABELS[turn.resolution] ?? RESOLUTION_LABELS['consensus'];
        const votes: any[] = turn.votes ?? [];

        const voteSummary = new Map<string, string[]>();
        for (const v of votes) {
          const action = ACTION_LABELS[v.action] ?? v.action;
          const list = voteSummary.get(action) ?? [];
          list.push(v.displayName ?? v.peerId?.slice(-8) ?? '?');
          voteSummary.set(action, list);
        }

        return (
          <div key={turn.turn} className="ot-trace-entry">
            <div className="ot-trace-dot" />
            <div className="ot-trace-body">
              <div className="ot-trace-header">
                <span className="ot-trace-turn">Turn {turn.turn}</span>
                <span className="ot-trace-action">
                  {ACTION_ICONS[turn.winningAction] ?? '?'}{' '}
                  {ACTION_LABELS[turn.winningAction] ?? turn.winningAction}
                </span>
                <span className="ot-trace-resolution" style={{ color: res.color }}>{res.label}</span>
              </div>
              <div className="ot-trace-result">{turn.resultMessage}</div>
              {votes.length > 0 && (
                <div className="ot-trace-votes">
                  {[...voteSummary.entries()].map(([action, players]) => (
                    <div key={action} className="ot-trace-vote-group">
                      <span className="ot-trace-vote-action">{action}</span>
                      <span className="ot-trace-vote-players">
                        {players.join(', ')}
                        {action === (ACTION_LABELS[turn.winningAction] ?? turn.winningAction) && (
                          <span className="ot-trace-winner-check"> ✓</span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {turn.event && (
                <div className="ot-trace-event">
                  <span className="ot-trace-event-icon">⚠</span>
                  <span>{turn.event.description}</span>
                </div>
              )}
              {(turn.deaths?.length ?? 0) > 0 && (
                <div className="ot-trace-deaths">
                  {turn.deaths.map((d: any) => {
                    const name = typeof d === 'string' ? d : d.name;
                    const cause = typeof d === 'string' ? null : d.cause;
                    return (
                      <div key={name} className="ot-trace-death-card">
                        <span className="ot-trace-skull">💀</span>
                        <div className="ot-trace-death-info">
                          <span className="ot-trace-death-name">{name} perished</span>
                          {cause && <span className="ot-trace-death-cause">{cause}</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              <div className="ot-trace-meta">
                {turn.timestamp ? new Date(turn.timestamp).toLocaleTimeString() : ''}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Right panel: tabs for Decision Trace and Context Graph */
function JourneyPanel({ swarm }: { swarm: any }) {
  const [tab, setTab] = useState<'trace' | 'graph'>('trace');
  const turnCount = swarm.turnHistory?.length ?? 0;

  return (
    <div className="ot-journey-panel">
      <div className="ot-journey-tabs">
        <button
          className={`ot-journey-tab ${tab === 'trace' ? 'ot-journey-tab--active' : ''}`}
          onClick={() => setTab('trace')}
        >
          Decision Trace {turnCount > 0 && <span className="ot-badge">{turnCount}</span>}
        </button>
        <button
          className={`ot-journey-tab ${tab === 'graph' ? 'ot-journey-tab--active' : ''}`}
          onClick={() => setTab('graph')}
        >
          Context Graph
        </button>
      </div>
      <div className="ot-journey-content">
        {tab === 'trace' && <DecisionTrace swarm={swarm} />}
        {tab === 'graph' && (
          <div style={{ position: 'relative', flex: 1, minHeight: 0, height: '100%' }}>
            <ContextGraphPanel swarm={swarm} />
          </div>
        )}
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
  const [confirmLeave, setConfirmLeave] = useState(false);

  useEffect(() => {
    api.info().then((data: any) => {
      setNodeInfo(data);
      if (data?.nodeName) setName(data.nodeName);
    }).catch(() => {});
  }, []);

  const autoNavigatedRef = useRef(false);

  const refreshLobby = useCallback(async () => {
    try {
      const data = await api.lobby();
      setLobby(data);
      if (data.mySwarms?.length === 1 && !autoNavigatedRef.current) {
        try {
          const fresh = await api.swarm(data.mySwarms[0].id);
          autoNavigatedRef.current = true;
          setSwarm(fresh);
          setView('swarm');
        } catch { /* swarm fetch failed, retry on next poll */ }
      }
    } catch (e: any) { setError(e.message); }
  }, []);

  const refreshSwarm = useCallback(async (swarmId: string) => {
    try { setSwarm(await api.swarm(swarmId)); } catch (e: any) { setError(e.message); }
  }, []);

  useEffect(() => {
    if (view === 'lobby') refreshLobby();
  }, [view, refreshLobby]);

  useEffect(() => {
    if (view !== 'lobby') return;
    const interval = setInterval(() => {
      void refreshLobby();
    }, 4_000);
    return () => clearInterval(interval);
  }, [view, refreshLobby]);

  useEffect(() => {
    if (view !== 'swarm' || !swarm) return;
    const interval = setInterval(() => refreshSwarm(swarm.id), 3000);
    return () => clearInterval(interval);
  }, [view, swarm?.id, refreshSwarm]);

  useEffect(() => {
    // Reset leave confirmation when swarm/view changes.
    setConfirmLeave(false);
  }, [view, swarm?.id]);

  if (view === 'lobby') {
    return (
      <div className="ot-container">
        <HeroBanner />

        <Leaderboard />

        <div className="ot-header">
          <h1>OriginTrail Game</h1>
          <div className="ot-header-right">
            <span className="ot-player">Playing as: {playerName}</span>
          </div>
        </div>

        {error && <div className="ot-error">{error}</div>}

        <div className="ot-section">
          <h2>Your Swarms</h2>
          {(() => {
            const activeSwarms = (lobby?.mySwarms ?? []).filter((w: any) => {
              if (w.status !== 'finished') return true;
              const lastActivity = w.lastTurn?.timestamp ?? w.createdAt;
              if (!lastActivity) return true;
              return Date.now() - lastActivity < 3600000;
            });
            return activeSwarms.length ? activeSwarms.map((w: any) => (
              <div key={w.id} className="ot-card ot-clickable" onClick={async () => {
                try { const fresh = await api.swarm(w.id); setSwarm(fresh); setView('swarm'); }
                catch (e: any) { setError(e.message); }
              }}>
                <strong>{w.name}</strong> — {w.players?.length ?? 0} players — {w.status}
              </div>
            )) : (
            <div className="ot-empty-state">
              <div className="ot-empty-state-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
              </div>
              <div className="ot-empty-state-title">No swarms yet</div>
              <div className="ot-empty-state-desc">Create a new swarm below to start your journey across the AI Frontier, or join an open one.</div>
            </div>
          );
          })()}
        </div>

        <div className="ot-section">
          <h2>Open Swarms</h2>
          {(lobby?.recruitingSwarms ?? lobby?.openSwarms)?.length ? (lobby?.recruitingSwarms ?? lobby?.openSwarms).map((w: any) => (
            <div key={w.id} className="ot-card">
              <strong>{w.name}</strong> — {w.players?.length ?? 0}/{w.maxPlayers} players {(w.players?.length ?? 0) >= w.maxPlayers ? '(Full)' : ''}
              <button onClick={async () => {
                try { setLoading(true); const res = await api.join(w.id, playerName); setSwarm(res); setView('swarm'); }
                catch (e: any) { setError(e.message); } finally { setLoading(false); }
              }} disabled={loading || (w.players?.length ?? 0) >= w.maxPlayers}>{(w.players?.length ?? 0) >= w.maxPlayers ? 'Full' : 'Join'}</button>
            </div>
          )) : (
            <div className="ot-empty-state">
              <div className="ot-empty-state-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
              </div>
              <div className="ot-empty-state-title">No open swarms</div>
              <div className="ot-empty-state-desc">No swarms are currently recruiting players. Launch your own swarm to get started.</div>
            </div>
          )}
        </div>

        <div className="ot-section">
          <h2>Launch Swarm</h2>
          <CreateSwarmForm playerName={playerName} onCreated={(w) => { setSwarm(w); setView('swarm'); }} onError={setError} />
        </div>

        <LobbyChat playerName={playerName} />

        <button className="ot-secondary" onClick={refreshLobby}>Refresh</button>
      </div>
    );
  }

  if (view === 'swarm' && swarm) {
    const isPlaying = swarm.status === 'traveling' || swarm.status === 'finished';
    const leaveCurrentSwarm = async () => {
      try {
        await api.leave(swarm.id);
        setSwarm(null);
        setView('lobby');
      } catch (e: any) {
        setError(e.message);
      } finally {
        setConfirmLeave(false);
      }
    };

    return (
      <div className={isPlaying ? 'ot-container ot-container--wide' : 'ot-container'}>
        <div className="ot-header">
          <h1>{swarm.name}</h1>
          <div className="ot-header-right" style={{ display: 'flex', gap: 8 }}>
            {swarm.status === 'traveling' && (
              <button className="ot-danger" onClick={async () => {
                setConfirmLeave(true);
              }}>Leave Swarm</button>
            )}
            <button className="ot-secondary" onClick={async () => {
              try {
                if (swarm.status === 'recruiting') {
                  await leaveCurrentSwarm();
                  return;
                }
                setSwarm(null);
                setView('lobby');
              } catch (e: any) { setError(e.message); }
            }}>Back to Lobby</button>
          </div>
        </div>

        {confirmLeave && swarm.status === 'traveling' && (
          <div className="ot-card" style={{ borderColor: 'var(--red)' }}>
            <p>Leave this swarm? The game is in progress and leaving will end it for everyone.</p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="ot-danger" onClick={leaveCurrentSwarm}>Confirm Leave</button>
              <button className="ot-secondary" onClick={() => setConfirmLeave(false)}>Cancel</button>
            </div>
          </div>
        )}

        <div className="ot-status-bar">
          <span>Status: <strong>{swarm.status}</strong></span>
          <span>Turn: <strong>{swarm.currentTurn}</strong></span>
          <span>Players: <strong>{swarm.playerCount}/{swarm.maxPlayers}</strong></span>
          <span>Game Master: <strong style={{ color: 'var(--green)' }}>{swarm.leaderName ?? '—'}</strong></span>
          <span>Signatures: <strong>{swarm.signatureThreshold}</strong></span>
        </div>

        {swarm.pendingProposal && (
          <div className="ot-card ot-proposal">
            Consensus: {swarm.pendingProposal.approvals}/{swarm.pendingProposal.threshold} approvals for turn {swarm.pendingProposal.turn}
          </div>
        )}

        {swarm.status === 'recruiting' && (
          <div className="ot-card">
            <h3>Waiting for players ({swarm.playerCount}/{swarm.maxPlayers} joined)</h3>
            <p className="ot-muted">
              Swarm capacity is set to {swarm.maxPlayers} players.
              Minimum to start is {swarm.minPlayers}.
            </p>
            <ul>{swarm.players.map((p: any) => <li key={p.id}>{p.name} {p.isLeader && <span className="ot-gm-badge">GM</span>}</li>)}</ul>
            {swarm.leaderId === nodeInfo?.peerId && swarm.playerCount >= swarm.minPlayers && (
              <button onClick={async () => {
                try { const res = await api.start(swarm.id); setSwarm(res); }
                catch (e: any) { setError(e.message); }
              }}>Start Journey</button>
            )}
          </div>
        )}

        {isPlaying && swarm.gameState && (
          <div className="ot-play-split">
            <div className="ot-play-left">
              {swarm.status === 'finished' && (
                <div className="ot-card ot-finished-card" style={{ borderColor: swarm.gameState.status === 'won' ? 'var(--green)' : 'var(--red)' }}>
                  <h2>{swarm.gameState.status === 'won' ? 'AGI Achieved — Singularity Harbor!' : 'Your expedition has ended.'}</h2>
                  {swarm.score > 0 && (
                    <div className="ot-final-score">
                      <span className="ot-final-score-label">Final Score</span>
                      <span className="ot-final-score-value">{swarm.score.toLocaleString()}</span>
                    </div>
                  )}
                  <p className="ot-muted">Scores have been published to the DKG leaderboard.</p>
                </div>
              )}
              <GameStateDisplay state={swarm.gameState} leaderName={swarm.leaderName} />
              {swarm.status === 'traveling' && (
                <VotePanel swarm={swarm} peerId={nodeInfo?.peerId} onVoted={(w) => setSwarm(w)} onError={setError} />
              )}
              {swarm.lastTurn && (
                <div className="ot-card">
                  <h3>Last Turn</h3>
                  <p><strong>Action:</strong> {ACTION_LABELS[swarm.lastTurn.winningAction] ?? swarm.lastTurn.winningAction}</p>
                  <p>{swarm.lastTurn.resultMessage}</p>
                  <p className="ot-muted" style={{ color: RESOLUTION_LABELS[swarm.lastTurn.resolution]?.color }}>
                    {RESOLUTION_LABELS[swarm.lastTurn.resolution]?.label ?? 'Consensus'}
                    {swarm.lastTurn.votes?.length > 0 && ` · ${swarm.lastTurn.votes.length} votes`}
                  </p>
                </div>
              )}
            </div>
            <div className="ot-play-right">
              <JourneyPanel swarm={swarm} />
            </div>
          </div>
        )}

        {error && <div className="ot-error">{error}</div>}
      </div>
    );
  }

  return null;
}

function Tooltip({ text }: { text: string }) {
  return (
    <span className="ot-tooltip-wrap">
      <span className="ot-tooltip-icon">?</span>
      <span className="ot-tooltip-text">{text}</span>
    </span>
  );
}

function GameStateDisplay({ state, leaderName }: { state: any; leaderName?: string }) {
  return (
    <div className="ot-game-state">
      <div className="ot-stats">
        <div><label>Epochs <Tooltip text="Training epochs completed. Reach 1000 to achieve AGI." /></label><span>{state.epochs} / 1000</span></div>
        <div><label>Tokens <Tooltip text="Training tokens fuel your AI models. Running out damages your party." /></label><span>{state.trainingTokens}</span></div>
        <div><label>API Credits <Tooltip text="Used for advanced operations and skill upgrades." /></label><span>{state.apiCredits}</span></div>
        <div><label>GPUs <Tooltip text="Compute units power your training runs. More GPUs = faster progress." /></label><span>{state.computeUnits}</span></div>
        <div><label>TRAC <Tooltip text="OriginTrail tokens used for publishing knowledge to the DKG." /></label><span>{state.trac}</span></div>
        <div><label>Date <Tooltip text="Current position on the AI Frontier timeline." /></label><span>Epoch {state.epochs}</span></div>
      </div>
      <div className="ot-trail-bar">
        <div className="ot-trail-fill" style={{ width: `${Math.min(100, (state.epochs / 1000) * 100)}%` }} />
      </div>
      <div className="ot-party">
        <h4>Swarm Members</h4>
        {state.party.map((m: any) => (
          <div key={m.id} className={`ot-member ${!m.alive ? 'ot-dead' : m.health < 40 ? 'ot-sick' : ''}`}>
            {m.name}
            {leaderName && m.name === leaderName && <span className="ot-gm-badge">GM</span>}
            {' — '}{m.alive ? `${m.health} HP` : 'Deceased'}
          </div>
        ))}
      </div>
    </div>
  );
}

function VotePanel({ swarm, peerId, onVoted, onError }: { swarm: any; peerId?: string; onVoted: (w: any) => void; onError: (e: string) => void }) {
  const myVoteEntry = swarm.voteStatus?.votes?.find((v: any) => v.peerId === peerId);
  const hasVoted = !!myVoteEntry?.hasVoted;
  const isAlive = myVoteEntry?.isAlive !== false;
  const aliveVoters = swarm.voteStatus?.votes?.filter((v: any) => v.isAlive !== false) ?? [];

  const doVote = async (action: string, params?: Record<string, any>) => {
    try { onVoted(await api.vote(swarm.id, action, params)); }
    catch (e: any) { onError(e.message); }
  };

  return (
    <div className="ot-card">
      <h3>Vote for Turn {swarm.currentTurn}</h3>
      {!isAlive && (
        <p style={{ color: 'var(--red)', fontWeight: 600 }}>Your agent has been eliminated. You can observe but cannot vote.</p>
      )}
      {isAlive && hasVoted && <p className="ot-muted">You have voted. Waiting for others...</p>}
      {isAlive && (
        <div className="ot-vote-grid">
          <button onClick={() => doVote('advance', { intensity: 1 })} disabled={hasVoted}>→ Advance (Conservative)</button>
          <button onClick={() => doVote('advance', { intensity: 2 })} disabled={hasVoted}>→ Advance (Standard)</button>
          <button onClick={() => doVote('advance', { intensity: 3 })} disabled={hasVoted}>→ Advance (Max Throughput)</button>
          <button onClick={() => doVote('upgradeSkills')} disabled={hasVoted}>⬆ Upgrade Skills</button>
          <button onClick={() => doVote('syncMemory')} disabled={hasVoted}>🔗 Sync Memory via DKG</button>
          <button onClick={() => doVote('forceBottleneck')} disabled={hasVoted}>⚡ Force Bottleneck</button>
          <button onClick={() => doVote('payToll')} disabled={hasVoted}>💰 Pay Toll</button>
        </div>
      )}
      <div className="ot-vote-status">
        <h4>Votes ({aliveVoters.filter((v: any) => v.hasVoted).length}/{aliveVoters.length})</h4>
        {swarm.voteStatus?.votes?.map((v: any, i: number) => (
          <div key={i} style={v.isAlive === false ? { opacity: 0.4, textDecoration: 'line-through' } : {}}>
            {v.player}: {v.isAlive === false ? 'eliminated' : v.hasVoted ? (v.action || 'voted') : 'waiting...'}
          </div>
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

function Leaderboard() {
  const [entries, setEntries] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.leaderboard()
      .then((data: any) => {
        const bestByPlayer = new Map<string, any>();
        for (const e of data?.entries ?? []) {
          const existing = bestByPlayer.get(e.player);
          if (!existing || e.score > existing.score) bestByPlayer.set(e.player, e);
        }
        setEntries([...bestByPlayer.values()].sort((a, b) => b.score - a.score));
      })
      .catch((err: any) => setError(err?.message ?? 'Failed to load leaderboard'))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="ot-leaderboard">
      <h2 className="ot-leaderboard-title">
        <span className="ot-leaderboard-trophy">🏆</span> Leaderboard
      </h2>
      {loading ? (
        <p className="ot-muted">Loading scores from the DKG...</p>
      ) : error ? (
        <div className="ot-leaderboard-empty">
          <p className="ot-error">{error}</p>
        </div>
      ) : entries.length === 0 ? (
        <div className="ot-leaderboard-empty">
          <div className="ot-empty-state" style={{ border: 'none', background: 'none', padding: '1.5rem 1rem' }}>
            <div className="ot-empty-state-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5C7 4 7 7 7 7"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5C17 4 17 7 17 7"/><path d="M4 22h16"/><path d="M10 22V8h4v14"/><path d="M8 9h8"/><path d="M8 9l-2 13"/><path d="M16 9l2 13"/></svg>
            </div>
            <div className="ot-empty-state-title">No completed expeditions yet</div>
            <div className="ot-empty-state-desc">Be the first to reach Singularity Harbor! Launch a swarm below to start your journey.</div>
          </div>
        </div>
      ) : (
        <div className="ot-leaderboard-table">
          <div className="ot-leaderboard-header">
            <span className="ot-lb-rank">#</span>
            <span className="ot-lb-name">Player</span>
            <span className="ot-lb-score">Score</span>
            <span className="ot-lb-outcome">Outcome</span>
            <span className="ot-lb-epochs">Epochs</span>
            <span className="ot-lb-survivors">Survivors</span>
          </div>
          {entries.slice(0, 20).map((entry: any, i: number) => (
            <div
              key={`${entry.swarmId}-${entry.displayName}-${i}`}
              className={`ot-leaderboard-row ${i === 0 ? 'ot-lb-gold' : i === 1 ? 'ot-lb-silver' : i === 2 ? 'ot-lb-bronze' : ''}`}
            >
              <span className="ot-lb-rank">
                {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}`}
              </span>
              <span className="ot-lb-name">{entry.displayName}</span>
              <span className="ot-lb-score">{entry.score.toLocaleString()}</span>
              <span className={`ot-lb-outcome ${entry.outcome === 'won' ? 'ot-lb-won' : 'ot-lb-lost'}`}>
                {entry.outcome === 'won' ? 'AGI ✓' : 'Failed'}
              </span>
              <span className="ot-lb-epochs">{entry.epochs}/1000</span>
              <span className="ot-lb-survivors">{entry.survivors}/{entry.partySize}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LobbyChat({ playerName }: { playerName: string }) {
  const [messages, setMessages] = useState<any[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const load = () => {
      api.chat(50).then((data: any) => setMessages(data?.messages ?? [])).catch(() => {});
    };
    load();
    const interval = setInterval(load, 3000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length]);

  const send = async () => {
    const text = input.trim();
    if (!text) return;
    setSending(true);
    try {
      await api.sendChat(text, playerName);
      setInput('');
      const data = await api.chat(50);
      setMessages(data?.messages ?? []);
    } catch { /* ignore */ }
    finally { setSending(false); }
  };

  return (
    <div className="ot-lobby-chat">
      <h3>Lobby Chat</h3>
      <div className="ot-lobby-chat-messages" ref={scrollRef}>
        {messages.length === 0 ? (
          <span className="ot-muted" style={{ alignSelf: 'center', marginTop: 'auto', marginBottom: 'auto' }}>No messages yet</span>
        ) : messages.map((m: any, i: number) => (
          <div key={i} className="ot-chat-msg">
            <span className="ot-chat-msg-name">{m.displayName}</span>
            {m.message}
            <span className="ot-chat-msg-time">{m.timestamp ? new Date(m.timestamp).toLocaleTimeString() : ''}</span>
          </div>
        ))}
      </div>
      <div className="ot-chat-input-row">
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !sending) send(); }}
          placeholder="Say something..."
          maxLength={200}
        />
        <button onClick={send} disabled={sending || !input.trim()}>Send</button>
      </div>
    </div>
  );
}

function CreateSwarmForm({ playerName, onCreated, onError }: { playerName: string; onCreated: (w: any) => void; onError: (e: string) => void }) {
  const [name, setName] = useState('');
  const [maxPlayers, setMaxPlayers] = useState(3);
  const [loading, setLoading] = useState(false);

  const setClampedMaxPlayers = (value: number) => {
    setMaxPlayers(Math.max(1, Math.min(8, value)));
  };

  return (
    <div className="ot-card">
      <input value={name} onChange={e => setName(e.target.value)} placeholder="Swarm name..." />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: '0.75rem' }}>
        <label style={{ margin: 0, whiteSpace: 'nowrap' }}>Max players:</label>
        <button
          type="button"
          className="ot-secondary"
          onClick={() => setClampedMaxPlayers(maxPlayers - 1)}
          disabled={loading || maxPlayers <= 1}
          aria-label="Decrease max players"
          style={{ minWidth: 36, padding: '0.4rem 0.6rem' }}
        >
          -
        </button>
        <div
          aria-live="polite"
          style={{
            minWidth: 56,
            textAlign: 'center',
            padding: '0.4rem 0.6rem',
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            color: 'var(--text)',
            fontSize: '0.95rem',
            fontWeight: 700,
          }}
        >
          {maxPlayers}
        </div>
        <button
          type="button"
          className="ot-secondary"
          onClick={() => setClampedMaxPlayers(maxPlayers + 1)}
          disabled={loading || maxPlayers >= 8}
          aria-label="Increase max players"
          style={{ minWidth: 36, padding: '0.4rem 0.6rem' }}
        >
          +
        </button>
      </div>
      <button disabled={!name.trim() || loading} onClick={async () => {
        try { setLoading(true); onCreated(await api.create(playerName, name, maxPlayers)); }
        catch (e: any) { onError(e.message); } finally { setLoading(false); }
      }}>Launch Swarm</button>
    </div>
  );
}
