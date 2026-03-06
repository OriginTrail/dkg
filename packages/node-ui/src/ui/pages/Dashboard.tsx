import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useFetch } from '../hooks.js';
import { fetchStatus, fetchMetrics, fetchParanets, fetchAgents, fetchOperations } from '../api.js';

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
          <button disabled style={{ padding: '8px 20px', borderRadius: 8, border: 'none', background: 'var(--green)', color: 'var(--bg)', fontSize: 12, fontWeight: 700, opacity: 0.5, cursor: 'default' }} title="Coming soon">Publish as Knowledge Assets (coming soon)</button>
        </div>
      </div>
    </div>
  );
}

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

interface DashNode { id: number; label: string; sublabel: string; isYou: boolean; online: boolean; color: string; role?: string; }
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
  const dim = !node.online && !isYou;
  ctx.globalAlpha = dim ? 0.3 : 1;
  ctx.beginPath(); ctx.arc(x, y, NODE_R, 0, Math.PI * 2);
  ctx.fillStyle = isYou ? '#0a1a0a' : '#0f0f23';
  ctx.fill();
  ctx.strokeStyle = isYou ? '#4ade80' : node.color;
  ctx.lineWidth = isYou ? 1.5 : 1;
  ctx.stroke();

  const dotColor = node.online ? '#10b981' : '#ef4444';
  ctx.beginPath(); ctx.arc(x + 4, y - 4, 1.5, 0, Math.PI * 2);
  ctx.fillStyle = dotColor; ctx.fill();
  ctx.strokeStyle = '#0a0f1a'; ctx.lineWidth = 0.8; ctx.stroke();
  if (node.online) {
    const pulse = ctx.createRadialGradient(x + 4, y - 4, 1.5, x + 4, y - 4, 4);
    pulse.addColorStop(0, 'rgba(16,185,129,0.3)'); pulse.addColorStop(1, 'transparent');
    ctx.fillStyle = pulse; ctx.beginPath(); ctx.arc(x + 4, y - 4, 4, 0, Math.PI * 2); ctx.fill();
  }

  ctx.font = '500 7px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText(node.sublabel, x, y + NODE_R + 7);

  if (node.role) {
    ctx.font = '600 6px JetBrains Mono, monospace';
    ctx.fillStyle = node.role === 'RELAY' ? '#818cf8' : '#64748b';
    ctx.fillText(node.role, x, y + NODE_R + 15);
  }
  if (isYou) {
    ctx.font = '600 6px JetBrains Mono, monospace';
    ctx.fillStyle = '#4ade80';
    ctx.fillText('YOUR NODE', x, y + NODE_R + (node.role ? 23 : 15));
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

interface AgentInfo { name: string; peerId: string; nodeRole?: string; connectionStatus?: string; }

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

  const nodes: DashNode[] = agents.length > 0
    ? agents.map((a, i) => {
        const isSelf = a.connectionStatus === 'self';
        return {
          id: i, isYou: isSelf, online: a.connectionStatus === 'connected' || isSelf,
          label: isSelf ? 'YOU' : a.name?.replace(/^devnet-/, '') || `P${i}`,
          sublabel: a.name || a.peerId?.slice(0, 10) || `peer-${i}`,
          role: a.nodeRole === 'core' ? 'RELAY' : a.nodeRole === 'edge' ? 'EDGE' : undefined,
          color: isSelf ? '#4ade80' : PEER_COLORS[i % PEER_COLORS.length],
        };
      })
    : [{ id: 0, isYou: true, online: true, label: 'YOU', sublabel: nodeName || 'my-node', color: '#4ade80' }];

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

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%' }}>
      <canvas ref={canvasRef} style={{ display: 'block' }} />
    </div>
  );
}

const FALLBACK_PARANETS = [
  { name: 'OriginTrail Game', assets: 847,  agents: 12, color: 'var(--green)' },
  { name: 'DeSci Research',   assets: 1203, agents: 8,  color: 'var(--blue)' },
  { name: 'Supply Chain EU',  assets: 797,  agents: 4,  color: 'var(--amber)' },
];

// ── Page ───────────────────────────────────────────────────────────────────────

export function DashboardPage() {
  const navigate = useNavigate();
  const [importOpen, setImportOpen] = useState(false);
  const { data: status } = useFetch(fetchStatus, [], 10_000);
  const { data: metrics } = useFetch(fetchMetrics, [], 10_000);
  const { data: paranetData } = useFetch(fetchParanets, [], 30_000);
  const { data: agentData } = useFetch(fetchAgents, [], 15_000);

  const PARANET_COLORS = ['var(--green)', 'var(--blue)', 'var(--amber)', 'var(--purple)', '#f472b6', '#22d3ee'];
  const paranets = (paranetData?.paranets ?? []).map((p: any, i: number) => ({
    id: p.id ?? `paranet-${i}`,
    name: p.name ?? p.id ?? `Paranet ${i + 1}`,
    assets: p.assetCount ?? p.assets ?? '—',
    agents: p.agentCount ?? p.agents ?? '—',
    color: PARANET_COLORS[i % PARANET_COLORS.length],
  }));
  const displayParanets = paranets.length > 0 ? paranets : FALLBACK_PARANETS;
  const isLiveParanets = paranets.length > 0;

  const peerCount = status?.connectedPeers ?? (status as any)?.peerCount ?? null;
  const totalAssets = (metrics as any)?.total_triples ?? null;
  const agentCount = agentData?.agents != null ? agentData.agents.length : null;

  return (
    <div className="page-section">
      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} />

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h1 className="serif" style={{ fontSize: 22, fontWeight: 700 }}>Dashboard</h1>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
            {status ? `Your node is live${paranets.length ? ` and participating in ${paranets.length} paranet${paranets.length !== 1 ? 's' : ''}` : ''}` : 'Loading node status…'}
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

      {/* Stat cards */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
        {[
          { label: 'Knowledge Assets', value: totalAssets != null ? Number(totalAssets).toLocaleString() : '—', sub: totalAssets != null ? 'from node metrics' : 'loading…', color: 'var(--green)' },
          { label: 'Connected Peers', value: peerCount != null ? String(peerCount) : '—', sub: peerCount != null ? 'live' : 'loading…', color: 'var(--blue)' },
          { label: 'Agents Discovered', value: agentCount != null ? String(agentCount) : '—', sub: `Across ${displayParanets.length} paranet${displayParanets.length !== 1 ? 's' : ''}`, color: 'var(--amber)' },
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
        <div style={{ position: 'relative', height: 340, borderRadius: 12, overflow: 'hidden', background: '#0a0f1a', border: '1px solid var(--border)' }}>
          <div style={{ position: 'absolute', top: 14, left: 18, zIndex: 2, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="pulse-dot" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--green)', boxShadow: '0 0 6px rgba(74,222,128,.53)', display: 'inline-block' }} />
            <span style={{ fontSize: 12, fontWeight: 700 }}>{status?.networkName ?? 'DKG Network'}</span>
            <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>{peerCount != null ? `${peerCount} PEERS` : '… PEERS'}</span>
          </div>
          <DashboardNetworkViz agents={agentData?.agents ?? []} nodeName={status?.name ?? ''} />
        </div>

        {/* Paranets + quick actions */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="card" style={{ padding: '16px 18px', flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700, marginBottom: 12 }}>
              Paranets
              {!isLiveParanets && <span className="mono" style={{ fontSize: 9, color: 'var(--text-dim)', fontWeight: 400 }}>DEMO</span>}
            </div>
            {displayParanets.map((p: any, i: number) => (
              <div key={p.id ?? `fallback-${i}`} onClick={() => p.id && navigate(`/explorer?paranet=${encodeURIComponent(p.id)}`)} style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', marginBottom: 6, cursor: 'pointer', transition: 'border-color .15s' }}>
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

    </div>
  );
}
