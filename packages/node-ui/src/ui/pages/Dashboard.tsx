import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useFetch, formatDuration } from '../hooks.js';
import { fetchStatus, fetchMetrics, fetchContextGraphs, fetchAgents, fetchOperations, fetchOperationsWithPhases, fetchErrorHotspots, fetchEconomics, fetchOperation } from '../api.js';
import { isDevModeEnabled } from '../dev-mode.js';
import { Tooltip, InfoTip } from '../components/Tooltip.js';
// P-1 review: phase palette is a single shared source of truth.
// Dashboard and Operations both import it so the same phase cannot
// drift between views — `chain:writeahead` was previously #b45309
// here and #ea580c in Operations.tsx, rendering the same bar two
// different colours depending on which page was open.
import { PHASE_COLORS, PHASE_FALLBACK_COLOR } from '../phase-colors.js';

// The Import Memories modal and its client helpers were retired as part
// of the openclaw-dkg-primary-memory work. /api/memory/import is gone;
// agents write memory via the adapter's dkg_memory_import tool, and
// file-import flows go through /api/assertion/:name/import-file directly.

// ── Canvas Network Visualization (adapted from network-sim) ─────────────────

type OpType = 'publish' | 'query' | 'update' | 'chat' | 'access' | 'stake';
const OP_COLORS: Record<OpType, string> = {
  publish: '#10b981', query: '#3b82f6', update: '#f97316',
  chat: '#06b6d4', access: '#f59e0b', stake: '#8b5cf6',
};
const OP_TYPES: OpType[] = Object.keys(OP_COLORS) as OpType[];
const PEER_COLORS = ['#4f46e5', '#6366f1', '#818cf8', '#3b82f6', '#60a5fa', '#22d3ee', '#a78bfa', '#8b5cf6', '#f472b6', '#94a3b8', '#fbbf24', '#f97316'];
const NODE_R = 4;
const GLOW_R = 8;
const PARTICLE_R = 2;
const PARTICLE_GLOW_R = 6;

type PeerStatus = 'online' | 'recent' | 'offline';
interface DashNode { id: number; label: string; sublabel: string; isYou: boolean; online: boolean; status: PeerStatus; color: string; }
interface Particle { id: number; from: number; to: number; progress: number; speed: number; type: OpType; }

function getPositions(count: number, cx: number, cy: number, radius: number) {
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 - Math.PI / 2;
    out.push({ x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius });
  }
  return out;
}

function drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.save();
  ctx.strokeStyle = 'rgba(74, 222, 128, 0.03)';
  ctx.lineWidth = 1;
  const step = 40;
  for (let x = 0; x < w; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
  for (let y = 0; y < h; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  ctx.restore();
}

function drawEdge(ctx: CanvasRenderingContext2D, fx: number, fy: number, tx: number, ty: number, active: boolean) {
  ctx.save();
  ctx.strokeStyle = active ? 'rgba(74, 222, 128, 0.18)' : 'rgba(74, 222, 128, 0.05)';
  ctx.lineWidth = active ? 1.5 : 1;
  ctx.setLineDash(active ? [] : [4, 4]);
  ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(tx, ty); ctx.stroke();
  ctx.restore();
}

function drawNodeCircle(ctx: CanvasRenderingContext2D, x: number, y: number, node: DashNode, isYou: boolean) {
  ctx.save();
  if (isYou) {
    const glow = ctx.createRadialGradient(x, y, NODE_R, x, y, GLOW_R);
    glow.addColorStop(0, 'rgba(74, 222, 128, 0.30)');
    glow.addColorStop(1, 'transparent');
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(x, y, GLOW_R, 0, Math.PI * 2); ctx.fill();
  }
  const dim = node.status === 'offline' && !isYou;
  ctx.globalAlpha = dim ? 0.3 : node.status === 'recent' && !isYou ? 0.6 : 1;
  ctx.beginPath(); ctx.arc(x, y, NODE_R, 0, Math.PI * 2);
  ctx.fillStyle = isYou ? '#0a1a0a' : '#0f0f23';
  ctx.fill();
  ctx.strokeStyle = isYou ? '#4ade80' : node.color;
  ctx.lineWidth = isYou ? 1.5 : 1;
  if (node.status === 'recent' && !isYou) ctx.setLineDash([2, 2]);
  ctx.stroke();
  ctx.setLineDash([]);

  const dotColor = node.status === 'online' ? '#10b981' : node.status === 'recent' ? '#f59e0b' : '#ef4444';
  ctx.beginPath(); ctx.arc(x + 4, y - 4, 1.5, 0, Math.PI * 2);
  ctx.fillStyle = dotColor; ctx.fill();
  ctx.strokeStyle = '#0a0f1a'; ctx.lineWidth = 0.8; ctx.stroke();
  if (node.status === 'online') {
    const pulse = ctx.createRadialGradient(x + 4, y - 4, 1.5, x + 4, y - 4, 4);
    pulse.addColorStop(0, 'rgba(16,185,129,0.3)'); pulse.addColorStop(1, 'transparent');
    ctx.fillStyle = pulse; ctx.beginPath(); ctx.arc(x + 4, y - 4, 4, 0, Math.PI * 2); ctx.fill();
  }

  ctx.font = '500 7px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText(node.sublabel, x, y + NODE_R + 7);

  if (isYou) {
    ctx.font = '600 6px JetBrains Mono, monospace';
    ctx.fillStyle = '#4ade80';
    ctx.fillText('YOUR NODE', x, y + NODE_R + 15);
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

function drawParticle(ctx: CanvasRenderingContext2D, x: number, y: number, type: OpType) {
  const color = OP_COLORS[type];
  ctx.save();
  const glow = ctx.createRadialGradient(x, y, 0, x, y, PARTICLE_GLOW_R);
  glow.addColorStop(0, color + 'aa'); glow.addColorStop(0.4, color + '44'); glow.addColorStop(1, 'transparent');
  ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(x, y, PARTICLE_GLOW_R, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, PARTICLE_R, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(x, y, 1.5, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawLegend(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const entries: [string, string][] = Object.entries(OP_COLORS).map(([k, v]) => [k.charAt(0).toUpperCase() + k.slice(1), v]);
  const pad = 10, lineH = 16, boxW = 90, boxH = pad * 2 + entries.length * lineH;
  const bx = w - boxW - 12, by = h - boxH - 12;
  ctx.save();
  ctx.fillStyle = 'rgba(10, 15, 26, 0.85)';
  ctx.strokeStyle = 'rgba(74, 222, 128, 0.15)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.roundRect(bx, by, boxW, boxH, 6); ctx.fill(); ctx.stroke();
  ctx.font = '500 9px Inter, system-ui, sans-serif';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  entries.forEach(([label, color], i) => {
    const ly = by + pad + i * lineH + lineH / 2;
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(bx + pad + 3, ly, 3.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#94a3b8'; ctx.fillText(label, bx + pad + 12, ly);
  });
  ctx.restore();
}

interface AgentInfo { name: string; peerId: string; nodeRole?: string; connectionStatus?: string; lastSeen?: number | null; latencyMs?: number | null; }

const OP_NAME_MAP: Record<string, OpType> = {
  publish: 'publish', query: 'query', workspace: 'update',
  chat: 'chat', connect: 'access', enshrine: 'publish',
  sync: 'stake', access: 'access',
};

function DashboardNetworkViz({ agents, nodeName }: { agents: AgentInfo[]; nodeName: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const particlesRef = useRef<Particle[]>([]);
  const pidRef = useRef(0);
  const seenOpsRef = useRef<Set<string>>(new Set());
  const lastPollRef = useRef(0);
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const draggingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0, panX: 0, panY: 0 });

  const ONLINE_THRESHOLD_MS = 5 * 60 * 1000;
  const RECENT_THRESHOLD_MS = 24 * 60 * 60 * 1000;

  function peerStatus(a: AgentInfo): PeerStatus {
    if (a.connectionStatus === 'self' || a.connectionStatus === 'connected') return 'online';
    if (a.lastSeen == null) return 'offline';
    const age = Date.now() - a.lastSeen;
    if (age < ONLINE_THRESHOLD_MS) return 'online';
    if (age < RECENT_THRESHOLD_MS) return 'recent';
    return 'offline';
  }

  const nodes: DashNode[] = agents.length > 0
    ? agents.map((a, i) => {
        const isSelf = a.connectionStatus === 'self';
        const st = peerStatus(a);
        return {
          id: i, isYou: isSelf, online: st !== 'offline', status: st,
          label: isSelf ? 'YOU' : a.name?.replace(/^devnet-/, '') || `P${i}`,
          sublabel: isSelf ? (nodeName || a.name || 'my-node') : (a.name || a.peerId?.slice(0, 10) || `peer-${i}`),
          color: isSelf ? '#4ade80' : PEER_COLORS[i % PEER_COLORS.length],
        };
      })
    : [{ id: 0, isYou: true, online: true, status: 'online' as PeerStatus, label: 'YOU', sublabel: nodeName || 'my-node', color: '#4ade80' }];

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    const cx = w / 2, cy = h / 2;
    const scaleFactor = nodes.length <= 6 ? 0.52 : nodes.length <= 10 ? 0.58 : 0.64;
    const graphR = Math.min(cx, cy) * scaleFactor;

    ctx.save(); ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0a0f1a'; ctx.fillRect(0, 0, w, h);
    drawGrid(ctx, w, h);

    // Graph layer — transformed by zoom/pan
    ctx.save();
    const zoom = zoomRef.current;
    const pan = panRef.current;
    ctx.translate(w / 2 + pan.x, h / 2 + pan.y);
    ctx.scale(zoom, zoom);
    ctx.translate(-w / 2, -h / 2);

    const positions = getPositions(nodes.length, cx, cy, graphR);

    const activeEdges = new Set<string>();
    for (const p of particlesRef.current) {
      const key = [Math.min(p.from, p.to), Math.max(p.from, p.to)].join('-');
      activeEdges.add(key);
    }

    const selfIdx = nodes.findIndex(n => n.isYou);
    const edgeSet = new Set<string>();
    for (let i = 0; i < nodes.length; i++) {
      if (i === selfIdx) continue;
      const key = [Math.min(i, selfIdx), Math.max(i, selfIdx)].join('-');
      edgeSet.add(key);
      const next = (i + 1) % nodes.length;
      if (next !== selfIdx) {
        const nk = [Math.min(i, next), Math.max(i, next)].join('-');
        edgeSet.add(nk);
      }
    }

    for (const ek of edgeSet) {
      const [a, b] = ek.split('-').map(Number);
      if (positions[a] && positions[b]) {
        const bothOnline = nodes[a]?.online !== false && nodes[b]?.online !== false;
        ctx.globalAlpha = bothOnline ? 1 : 0.15;
        drawEdge(ctx, positions[a].x, positions[a].y, positions[b].x, positions[b].y, activeEdges.has(ek));
      }
    }
    ctx.globalAlpha = 1;

    for (const p of particlesRef.current) {
      const f = positions[p.from], t = positions[p.to];
      if (!f || !t) continue;
      const ease = p.progress < 0.5 ? 2 * p.progress * p.progress : 1 - Math.pow(-2 * p.progress + 2, 2) / 2;
      drawParticle(ctx, f.x + (t.x - f.x) * ease, f.y + (t.y - f.y) * ease, p.type);
    }

    for (let i = 0; i < nodes.length; i++) {
      drawNodeCircle(ctx, positions[i].x, positions[i].y, nodes[i], nodes[i].isYou);
    }
    ctx.restore();

    // Overlay layer — fixed to viewport, not affected by zoom/pan
    drawLegend(ctx, w, h);
    ctx.restore();
  }, [agents, nodeName]);

  useEffect(() => {
    let raf: number;
    let cancelled = false;
    const selfIdx = nodes.findIndex(n => n.isYou);
    const peerIndices = nodes.map((_, i) => i).filter(i => i !== selfIdx);

    const pollOps = async () => {
      if (cancelled || nodes.length < 2) return;
      const now = Date.now();
      if (now - lastPollRef.current < 3000) return;
      lastPollRef.current = now;
      try {
        const since = now - 10_000;
        const res = await fetchOperations({ from: String(since), limit: '20' });
        const ops = res?.operations ?? [];
        for (const op of ops) {
          const opId = op.operation_id ?? op.id;
          if (!opId || seenOpsRef.current.has(opId)) continue;
          seenOpsRef.current.add(opId);
          const opType = OP_NAME_MAP[op.operation_name] ?? 'query';
          const target = peerIndices.length > 0
            ? peerIndices[Math.floor(Math.random() * peerIndices.length)]
            : 0;
          particlesRef.current.push({
            id: pidRef.current++,
            from: selfIdx >= 0 ? selfIdx : 0,
            to: target,
            progress: 0,
            speed: 0.006 + Math.random() * 0.004,
            type: opType,
          });
        }
        if (seenOpsRef.current.size > 200) {
          const arr = Array.from(seenOpsRef.current);
          seenOpsRef.current = new Set(arr.slice(-100));
        }
      } catch { /* non-fatal */ }
    };

    const loop = (_ts: number) => {
      pollOps();
      particlesRef.current = particlesRef.current
        .map(p => ({ ...p, progress: p.progress + p.speed }))
        .filter(p => p.progress <= 1);
      draw();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelled = true; cancelAnimationFrame(raf); };
  }, [draw]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = container.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
    };
    resize();
    const obs = new ResizeObserver(resize);
    obs.observe(container);
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      zoomRef.current = Math.max(0.3, Math.min(5, zoomRef.current * delta));
    };
    const onMouseDown = (e: MouseEvent) => {
      draggingRef.current = true;
      dragStartRef.current = { x: e.clientX, y: e.clientY, panX: panRef.current.x, panY: panRef.current.y };
      container.style.cursor = 'grabbing';
    };
    const onMouseMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      panRef.current = {
        x: dragStartRef.current.panX + (e.clientX - dragStartRef.current.x),
        y: dragStartRef.current.panY + (e.clientY - dragStartRef.current.y),
      };
    };
    const onMouseUp = () => {
      draggingRef.current = false;
      container.style.cursor = 'grab';
    };
    container.style.cursor = 'grab';
    container.addEventListener('wheel', onWheel, { passive: false });
    container.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      container.removeEventListener('wheel', onWheel);
      container.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%' }}>
      <canvas ref={canvasRef} style={{ display: 'block' }} />
    </div>
  );
}

const FALLBACK_CONTEXT_GRAPHS = [
  { name: 'OriginTrail Game', assets: 847,  agents: 12, color: 'var(--green)' },
  { name: 'DeSci Research',   assets: 1203, agents: 8,  color: 'var(--blue)' },
  { name: 'Supply Chain EU',  assets: 797,  agents: 4,  color: 'var(--amber)' },
];

// ── Recent Operations Mini Waterfall ─────────────────────────────────────────

const PHASE_DESCRIPTIONS: Record<string, string> = {
  prepare: 'Partitioning triples, computing Merkle hashes, validating & signing.',
  store: 'Inserting triples into the local triple store and data graph.',
  chain: 'Submitting on-chain tx and waiting for confirmation.',
  broadcast: 'Broadcasting to network peers via GossipSub.',
  parse: 'Validating and parsing the SPARQL query syntax.',
  execute: 'Running the SPARQL query against the local triple store.',
  transfer: 'Fetching triple pages from the remote peer.',
  verify: 'Verifying Merkle proofs and inserting synced triples.',
};


function DashMiniGantt({ phases, totalMs }: { phases: any[]; totalMs: number }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!phases?.length || totalMs <= 0) return <div style={{ flex: 1, height: 8, borderRadius: 2, background: 'rgba(255,255,255,.04)' }} />;
  const phaseTotal = phases.reduce((s: number, p: any) => s + (p.duration_ms ?? 0), 0) || totalMs;
  return (
    <div style={{ flex: 1, position: 'relative' }}>
      <div style={{ display: 'flex', height: 8, borderRadius: 2, overflow: 'hidden', background: 'rgba(255,255,255,.04)' }}>
        {phases.map((p: any, i: number) => {
          const pct = Math.max(((p.duration_ms ?? 0) / phaseTotal) * 100, 2);
          const color = p.status === 'error' ? '#ef4444' : PHASE_COLORS[p.phase] ?? PHASE_FALLBACK_COLOR;
          return (
            <div
              key={`${p.phase}-${i}`}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              style={{ width: `${pct}%`, background: color, minWidth: 2, opacity: hover === i ? 1 : 0.7, transition: 'opacity .15s', cursor: 'default' }}
            />
          );
        })}
      </div>
      {hover !== null && phases[hover] && (() => {
        const hoveredPhase = phases[hover].phase;
        const topLevel = hoveredPhase.includes(':') ? hoveredPhase.split(':')[0] : hoveredPhase;
        const desc = PHASE_DESCRIPTIONS[topLevel];
        return (
          <div style={{
            position: 'absolute', bottom: '100%', left: '50%', transform: 'translateX(-50%)',
            marginBottom: 6, padding: '4px 8px', borderRadius: 6,
            background: 'var(--surface)', border: '1px solid var(--border)',
            boxShadow: '0 4px 12px rgba(0,0,0,.4)',
            fontSize: 10, zIndex: 10, pointerEvents: 'none',
            maxWidth: 240,
          }}>
            <div style={{ whiteSpace: 'nowrap' }}>
              <span style={{ fontWeight: 700, color: PHASE_COLORS[hoveredPhase] ?? PHASE_FALLBACK_COLOR }}>
                {hoveredPhase}
              </span>
              <span style={{ color: 'var(--text-muted)', margin: '0 4px' }}>·</span>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", color: 'var(--text)' }}>
                {formatDuration(phases[hover].duration_ms)}
              </span>
              {phases[hover].status === 'error' && (
                <span style={{ color: 'var(--red)', marginLeft: 4, fontWeight: 600 }}>FAIL</span>
              )}
            </div>
            {desc && (
              <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 2, whiteSpace: 'normal', lineHeight: 1.3 }}>
                {desc}
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}

function OpDetailPanel({ operationId }: { operationId: string }) {
  const { data, loading } = useFetch(() => fetchOperation(operationId), [operationId]);
  if (loading) return <div style={{ padding: '8px 12px', fontSize: 11, color: 'var(--text-dim)' }}>Loading...</div>;
  if (!data) return null;
  const { operation: op, phases, logs } = data;
  if (!op) return null;
  const recentLogs = (logs ?? []).slice(-5);

  return (
    <div style={{ padding: '10px 12px', background: 'rgba(255,255,255,.02)', borderTop: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 8, fontSize: 11 }}>
        <span style={{ color: 'var(--text-muted)' }}>Status: <strong style={{ color: op.status === 'error' ? 'var(--red)' : 'var(--green-mid)' }}>{op.status}</strong></span>
        <span style={{ color: 'var(--text-muted)' }}>Duration: <strong style={{ fontFamily: "'JetBrains Mono', monospace" }}>{formatDuration(op.duration_ms)}</strong></span>
        {op.error_message && <span style={{ color: 'var(--red)', fontSize: 10 }}>{op.error_message}</span>}
      </div>
      {phases?.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginBottom: recentLogs.length ? 8 : 0 }}>
          {phases.map((p: any, i: number) => (
            <div key={`${p.phase}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: p.status === 'error' ? 'var(--red)' : PHASE_COLORS[p.phase] ?? PHASE_FALLBACK_COLOR, flexShrink: 0 }} />
              <span style={{ color: PHASE_COLORS[p.phase] ?? PHASE_FALLBACK_COLOR, fontWeight: 600, minWidth: 100 }}>{p.phase}</span>
              <span className="mono" style={{ color: 'var(--text-dim)' }}>{formatDuration(p.duration_ms)}</span>
              {p.status === 'error' && <span style={{ color: 'var(--red)', fontWeight: 600 }}>FAILED</span>}
            </div>
          ))}
        </div>
      )}
      {recentLogs.length > 0 && (
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 6 }}>
          <div style={{ fontSize: 9, color: 'var(--text-dim)', marginBottom: 4, fontWeight: 600 }}>Recent logs</div>
          {recentLogs.map((l: any, i: number) => (
            <div key={i} style={{ fontSize: 10, color: l.level === 'error' ? 'var(--red)' : l.level === 'warn' ? 'var(--amber)' : 'var(--text-muted)', lineHeight: 1.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              [{l.module}] {l.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RecentOpsSection() {
  const { data } = useFetch(() => fetchOperationsWithPhases({ limit: '8' }), [], 10_000);
  const navigate = useNavigate();
  const [selectedOp, setSelectedOp] = useState<string | null>(null);
  const operations = data?.operations ?? [];
  const devMode = isDevModeEnabled();

  if (operations.length === 0) return null;

  return (
    <div style={{ marginBottom: 16 }}>
      <div className="section-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>Recent Operations</span>
        {devMode && (
          <button
            className="dkg-btn dkg-btn-secondary"
            style={{ fontSize: 10, padding: '4px 10px' }}
            onClick={() => navigate('/settings?tab=observability')}
          >
            View All
          </button>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {operations.map((op: any) => {
          const dur = op.duration_ms ?? 0;
          const isError = op.status === 'error';
          const phases = op.phases ?? [];
          const isSelected = selectedOp === op.operation_id;

          return (
            <React.Fragment key={op.operation_id}>
              <div
                onClick={() => setSelectedOp(isSelected ? null : op.operation_id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                  borderRadius: isSelected ? '8px 8px 0 0' : 8,
                  background: isSelected ? 'rgba(59,130,246,.06)' : 'var(--surface)',
                  border: '1px solid var(--border)',
                  borderBottom: isSelected ? '1px solid var(--border)' : undefined,
                  cursor: 'pointer', transition: 'border-color .15s, background .15s',
                }}
                onMouseEnter={e => { if (!isSelected) e.currentTarget.style.borderColor = 'rgba(74,222,128,.3)'; }}
                onMouseLeave={e => { if (!isSelected) e.currentTarget.style.borderColor = 'var(--border)'; }}
              >
                <span className="mono" style={{ fontSize: 10, color: 'var(--text-dim)', width: 50, flexShrink: 0 }}>
                  {new Date(op.started_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                </span>
                <span style={{
                  fontSize: 10, fontWeight: 700, width: 60, flexShrink: 0,
                  color: isError ? 'var(--red)' : 'var(--green-mid)',
                }}>
                  {op.operation_name}
                </span>
                <DashMiniGantt phases={phases} totalMs={dur} />
                <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)', width: 50, textAlign: 'right', flexShrink: 0 }}>
                  {formatDuration(dur)}
                </span>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: isError ? 'var(--red)' : op.status === 'in_progress' ? 'var(--amber)' : 'var(--green-mid)', flexShrink: 0 }} />
              </div>
              {isSelected && (
                <div style={{ border: '1px solid var(--border)', borderTop: 'none', borderRadius: '0 0 8px 8px', overflow: 'hidden', marginTop: -4 }}>
                  <OpDetailPanel operationId={op.operation_id} />
                </div>
              )}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

function ErrorHotspotsCard() {
  const { data } = useFetch(() => fetchErrorHotspots(7 * 86_400_000), [], 30_000);
  const hotspots = (data?.hotspots ?? []).slice(0, 5);

  if (hotspots.length === 0) {
    return (
      <div className="context-graph-card" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 60 }}>
        <span style={{ fontSize: 11, color: 'var(--green)', fontWeight: 600 }}>No errors in 7 days</span>
      </div>
    );
  }

  return (
    <div className="context-graph-card" style={{ padding: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--red)', marginBottom: 6 }}>Error Hotspots (7d)</div>
      {hotspots.map((h: any, i: number) => (
        <div key={`${h.operation_name}-${h.phase}-${i}`} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, padding: '3px 0', color: 'var(--text-muted)' }}>
          <span>
            <span style={{ color: 'var(--text-dim)', fontSize: 10 }}>{h.operation_name}</span>
            <span style={{ color: 'var(--text-dim)', margin: '0 4px' }}>&rsaquo;</span>
            <span style={{ color: PHASE_COLORS[h.phase] ?? PHASE_FALLBACK_COLOR, fontWeight: 500 }}>{h.phase}</span>
          </span>
          <span style={{ color: 'var(--red)', fontWeight: 700 }}>{h.error_count}</span>
        </div>
      ))}
    </div>
  );
}

function SpendingCard() {
  const { data } = useFetch(fetchEconomics, [], 60_000);
  const periods = (data as any)?.periods ?? [];
  const latest = periods[0];

  if (!latest) return null;

  return (
    <div className="context-graph-card" style={{ padding: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--amber)', marginBottom: 6 }}>Spending ({latest.label})</div>
      <div style={{ display: 'flex', gap: 16, fontSize: 11, color: 'var(--text-muted)' }}>
        <div>
          <div className="mono" style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{latest.totalGasEth?.toFixed(6) ?? '0'}</div>
          <Tooltip text="Ethereum gas fees for on-chain transactions"><div>ETH gas</div></Tooltip>
        </div>
        <div>
          <div className="mono" style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{latest.totalTrac?.toFixed(2) ?? '0'}</div>
          <Tooltip text="TRAC — the OriginTrail network token used for publishing and storing knowledge"><div>TRAC</div></Tooltip>
        </div>
        <div>
          <div className="mono" style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{latest.publishCount ?? 0}</div>
          <Tooltip text="Number of Knowledge Assets published on-chain"><div>publishes</div></Tooltip>
        </div>
      </div>
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export function DashboardPage() {
  const navigate = useNavigate();
  const { data: status } = useFetch(fetchStatus, [], 10_000);
  const { data: metrics } = useFetch(fetchMetrics, [], 10_000);
  const { data: contextGraphData } = useFetch(fetchContextGraphs, [], 30_000);
  const { data: agentData } = useFetch(fetchAgents, [], 15_000);

  const contextGraphs = useMemo(() => {
    const colors = ['var(--green)', 'var(--blue)', 'var(--amber)', 'var(--purple)', '#f472b6', '#22d3ee'];
    return (contextGraphData?.contextGraphs ?? []).map((p: any, i: number) => ({
      id: p.id ?? `context-graph-${i}`,
      name: p.name ?? p.id ?? `Context Graph ${i + 1}`,
      assets: p.assetCount ?? p.assets ?? '—',
      agents: p.agentCount ?? p.agents ?? '—',
      color: colors[i % colors.length],
    }));
  }, [contextGraphData]);
  const displayContextGraphs = contextGraphs.length > 0 ? contextGraphs : FALLBACK_CONTEXT_GRAPHS;
  const isLiveContextGraphs = contextGraphs.length > 0;

  const peerCount = status?.connectedPeers ?? (status as any)?.peerCount ?? null;
  const totalKCs = (metrics as any)?.total_kcs ?? null;
  const confirmedKCs = (metrics as any)?.confirmed_kcs ?? null;
  const tentativeKCs = (metrics as any)?.tentative_kcs ?? null;
  const agentCount = agentData?.agents != null ? agentData.agents.length : null;

  return (
    <div className="page-section">
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h1 className="page-title" style={{ marginBottom: 0 }}>Dashboard</h1>
          <p style={{ marginTop: 4 }}>
            {status ? `Your node is live${contextGraphs.length ? ` and participating in ${contextGraphs.length} context graph${contextGraphs.length !== 1 ? 's' : ''}` : ''}` : 'Loading node status…'}
          </p>
        </div>
      </div>

      {/* Stat cards */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
        {([
          {
            label: <>Knowledge Collections <InfoTip text="Groups of knowledge triples stored on your node. Confirmed = finalized on-chain. Tentative = stored locally, pending blockchain finalization." /></>,
            value: confirmedKCs != null && tentativeKCs != null
              ? String(Number(confirmedKCs) + Number(tentativeKCs))
              : totalKCs != null ? Number(totalKCs).toLocaleString() : '—',
            sub: confirmedKCs != null && tentativeKCs != null
              ? <><Tooltip text="Finalized on-chain with a confirmed transaction"><span style={{ color: 'var(--green)' }}>{Number(confirmedKCs).toLocaleString()} confirmed</span></Tooltip>{' · '}<Tooltip text="Stored locally, pending blockchain finalization"><span style={{ color: 'var(--amber)' }}>{Number(tentativeKCs).toLocaleString()} tentative</span></Tooltip></>
              : totalKCs != null ? 'from node metrics' : 'loading…',
            color: 'var(--green)',
          },
          { label: <>Connected Peers <InfoTip text="Other DKG nodes your node has an active network connection with" /></>, value: peerCount != null ? String(peerCount) : '—', sub: peerCount != null ? 'live' : 'loading…', color: 'var(--blue)' },
          { label: <>Agents Discovered <InfoTip text="AI agents discovered across the context graphs your node participates in" /></>, value: agentCount != null ? String(agentCount) : '—', sub: `Across ${displayContextGraphs.length} context graph${displayContextGraphs.length !== 1 ? 's' : ''}`, color: 'var(--amber)' },
        ] as Array<{ label: React.ReactNode; value: string; sub: React.ReactNode; color: string }>).map((s, i) => (
          <div className="stat-card" key={i}>
            <div className="accent" style={{ background: `linear-gradient(90deg,${s.color}44,transparent)` }} />
            <div className="stat-label">{s.label}</div>
            <div className="stat-value mono">{s.value}</div>
            <div className="stat-sub">{s.sub}</div>
          </div>
        ))}
      </div>

      {/* Network viz — full width */}
      <div style={{ position: 'relative', height: 340, borderRadius: 12, overflow: 'hidden', background: 'var(--bg)', border: '1px solid var(--border)', marginBottom: 16 }}>
        <div style={{ position: 'absolute', top: 14, left: 18, zIndex: 2, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="pulse-dot" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--green)', boxShadow: '0 0 6px rgba(74,222,128,.53)', display: 'inline-block' }} />
          <span className="mono" style={{ fontSize: 12, fontWeight: 700 }}>{status?.networkName ?? 'DKG Network'}</span>
          <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>{peerCount != null ? `${peerCount} PEERS` : '… PEERS'}</span>
          <span className="mono" style={{ fontSize: 9, color: 'var(--text-dim)', marginLeft: 4 }}>scroll to zoom · drag to pan</span>
        </div>
        <DashboardNetworkViz agents={agentData?.agents ?? []} nodeName={status?.name ?? ''} />
      </div>

      {/* Context Graphs — horizontal card grid */}
      <div style={{ marginBottom: 16 }}>
        <div className="section-title">
          Context Graphs
          {!isLiveContextGraphs && <span className="mono" style={{ fontSize: 9, color: 'var(--text-dim)', fontWeight: 400 }}>DEMO</span>}
        </div>
        <div className="context-graph-list">
          {displayContextGraphs.map((p: any, i: number) => (
            <div key={p.id ?? `fallback-${i}`} className="context-graph-card" onClick={() => p.id && navigate(`/explorer?contextGraph=${encodeURIComponent(p.id)}`)}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                <span style={{ width: 7, height: 7, borderRadius: 3, background: p.color, display: 'inline-block' }} />
                <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>{p.name}</h3>
                <span className="pulse-dot" style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--green)', display: 'inline-block', marginLeft: 'auto' }} />
              </div>
              <div className="mono" style={{ display: 'flex', gap: 14, fontSize: 10, color: 'var(--text-muted)' }}>
                <Tooltip text="Knowledge Assets published to this context graph"><span>{p.assets.toLocaleString()} assets</span></Tooltip>
                <span>{p.agents} agents</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Recent operations waterfall */}
      <RecentOpsSection />

      {/* Health + Spending cards */}
      <div className="dashboard-grid-2">
        <ErrorHotspotsCard />
        <SpendingCard />
      </div>

      {/* Quick actions */}
      <div className="quick-actions" style={{ marginBottom: 16 }}>
        {[
          { label: 'Query the Graph', desc: 'SPARQL queries', icon: '⌘', onClick: () => navigate('/explorer/sparql') },
          { label: 'Play OriginTrail', desc: 'Test your node', icon: '🎮', onClick: () => navigate('/apps') },
        ].map(a => (
          <button key={a.label} className="quick-action" onClick={a.onClick}>
            <span style={{ fontSize: 16 }}>{a.icon}</span>
            <div>
              <div className="qa-label">{a.label}</div>
              <div className="qa-desc">{a.desc}</div>
            </div>
          </button>
        ))}
      </div>

    </div>
  );
}
