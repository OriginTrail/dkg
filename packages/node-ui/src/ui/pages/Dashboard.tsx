import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useFetch, formatDuration } from '../hooks.js';
import { fetchStatus, fetchMetrics, fetchParanets, fetchAgents, fetchOperations, fetchOperationsWithPhases, fetchErrorHotspots, fetchEconomics, fetchOperation, importMemories, IMPORT_SOURCES, type ImportSource, type ImportMemoryResult, type ImportMemoryQuad } from '../api.js';
import { isDevModeEnabled } from './Settings.js';
import { RdfGraph } from '@dkg/graph-viz/react';
import type { ViewConfig } from '@dkg/graph-viz';

// ── Import Memories Modal ──────────────────────────────────────────────────────

const SOURCE_LABELS: Record<ImportSource, { label: string; icon: string }> = {
  claude: { label: 'Claude', icon: '🟣' },
  chatgpt: { label: 'ChatGPT', icon: '🟢' },
  gemini: { label: 'Gemini', icon: '🔵' },
  other: { label: 'Other', icon: '⚪' },
};

const SOURCE_OPTIONS = IMPORT_SOURCES.map(value => ({
  value,
  ...SOURCE_LABELS[value],
}));

type ResultTab = 'graph' | 'triples';

const IMPORT_VIEW_CONFIG: ViewConfig = {
  name: 'ImportPreview',
  palette: 'dark',
  paletteOverrides: { edgeColor: '#5f8598' },
  animation: { fadeIn: true, linkParticles: false, drift: false, hoverTrace: false },
};

function humanizeUri(uri: string): string {
  const stripped = uri.replace(/^"|".*$/g, '');
  const hash = stripped.lastIndexOf('#');
  const slash = stripped.lastIndexOf('/');
  const colon = stripped.lastIndexOf(':');
  const cut = Math.max(hash, slash, colon);
  return cut >= 0 ? stripped.slice(cut + 1) : stripped;
}

function formatTripleObject(obj: string): string {
  if (obj.startsWith('"') && obj.endsWith('"')) return obj.slice(1, -1);
  if (obj.startsWith('"') && obj.includes('"^^<')) return obj.slice(1, obj.indexOf('"^^<'));
  return obj;
}

function ImportResultView({
  result,
  onReset,
  onClose,
}: {
  result: ImportMemoryResult;
  onReset: () => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<ResultTab>('graph');

  const graphTriples = useMemo(() => {
    if (!result.quads?.length) return [];
    return result.quads
      .filter(q => !q.object.startsWith('"'))
      .map(q => ({ subject: q.subject, predicate: q.predicate, object: q.object }));
  }, [result.quads]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Header stats */}
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--green)', marginBottom: 4 }}>
          {result.memoryCount} memories imported
        </div>
        <p>
          {result.tripleCount} triples created
          {result.entityCount > 0 && <> · {result.entityCount} entities extracted</>}
        </p>
        <div className="mono" style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 6 }}>
          Batch: {result.batchId} · Source: {result.source}
        </div>
      </div>

      {/* Warnings */}
      {result.warnings && result.warnings.length > 0 && (
        <div style={{ padding: '8px 12px', borderRadius: 8, background: 'rgba(250,204,21,.08)', border: '1px solid rgba(250,204,21,.25)' }}>
          {result.warnings.map((w, i) => (
            <div key={i} style={{ fontSize: 11, color: 'rgb(250,204,21)', lineHeight: 1.5 }}>⚠ {w}</div>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
        <button className={`dkg-btn ${tab === 'graph' ? '' : 'dkg-btn-secondary'}`} onClick={() => setTab('graph')} style={{ padding: '6px 16px', fontSize: 11 }}>Graph</button>
        <button className={`dkg-btn ${tab === 'triples' ? '' : 'dkg-btn-secondary'}`} onClick={() => setTab('triples')} style={{ padding: '6px 16px', fontSize: 11 }}>Triples</button>
      </div>

      {/* Tab content */}
      {tab === 'graph' && (
        <div style={{ height: 320, borderRadius: 10, overflow: 'hidden', border: '1px solid var(--border)', background: 'var(--bg)' }}>
          {graphTriples.length > 0 ? (
            <RdfGraph
              data={graphTriples}
              format="triples"
              options={{
                labelMode: 'humanized',
                renderer: '2d',
                style: {
                  classColors: {
                    'http://dkg.io/ontology/MemoryImport': '#f59e0b',
                    'http://dkg.io/ontology/ImportedMemory': '#4ade80',
                  },
                  defaultNodeColor: '#22d3ee',
                  defaultEdgeColor: '#5f8598',
                  edgeWidth: 0.9,
                },
                hexagon: { baseSize: 4, minSize: 3, maxSize: 6, scaleWithDegree: true },
                focus: { maxNodes: 500, hops: 999 },
              }}
              viewConfig={IMPORT_VIEW_CONFIG}
              style={{ width: '100%', height: '100%' }}
            />
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-dim)', fontSize: 12 }}>
              No graph edges to display
            </div>
          )}
        </div>
      )}

      {tab === 'triples' && (
        <div style={{
          maxHeight: 320,
          overflowY: 'auto',
          borderRadius: 10,
          border: '1px solid var(--border)',
          background: 'var(--bg)',
          padding: 0,
        }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}>
            <thead>
              <tr style={{ position: 'sticky', top: 0, background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
                <th style={{ textAlign: 'left', padding: '8px 10px', color: 'var(--text-dim)', fontWeight: 600, fontSize: 10, textTransform: 'uppercase', letterSpacing: '.05em' }}>Subject</th>
                <th style={{ textAlign: 'left', padding: '8px 10px', color: 'var(--text-dim)', fontWeight: 600, fontSize: 10, textTransform: 'uppercase', letterSpacing: '.05em' }}>Predicate</th>
                <th style={{ textAlign: 'left', padding: '8px 10px', color: 'var(--text-dim)', fontWeight: 600, fontSize: 10, textTransform: 'uppercase', letterSpacing: '.05em' }}>Object</th>
              </tr>
            </thead>
            <tbody>
              {(result.quads ?? []).map((q, i) => (
                <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '6px 10px', color: '#22d3ee', wordBreak: 'break-all' }}>{humanizeUri(q.subject)}</td>
                  <td style={{ padding: '6px 10px', color: 'var(--text-muted)', wordBreak: 'break-all' }}>{humanizeUri(q.predicate)}</td>
                  <td style={{ padding: '6px 10px', color: q.object.startsWith('"') ? 'var(--text)' : '#4ade80', wordBreak: 'break-all' }}>{formatTripleObject(q.object)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Privacy note + buttons */}
      <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6, textAlign: 'center' }}>
        Stored as private Knowledge Assets in <code className="mono" style={{ fontSize: 10, background: 'var(--surface)', padding: '1px 4px', borderRadius: 3 }}>agent-memory</code>. Never shared with other nodes.
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
        <button className="dkg-btn dkg-btn-secondary" onClick={onReset}>Import More</button>
        <button className="dkg-btn dkg-btn-solid" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}

function ImportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [text, setText] = useState('');
  const [source, setSource] = useState<ImportSource>('claude');
  const [useLlm, setUseLlm] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportMemoryResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setText('');
    setSource('claude');
    setUseLlm(false);
    setImporting(false);
    setResult(null);
    setError(null);
  }, []);

  const handleClose = useCallback(() => {
    if (importing) return;
    reset();
    onClose();
  }, [onClose, reset, importing]);

  const handleImport = useCallback(async () => {
    if (!text.trim() || importing) return;
    setImporting(true);
    setError(null);
    setResult(null);
    try {
      const res = await importMemories(text.trim(), source, useLlm);
      setResult(res);
    } catch (err: any) {
      setError(err.message ?? 'Import failed');
    } finally {
      setImporting(false);
    }
  }, [text, source, useLlm, importing]);

  if (!open) return null;
  return (
    <div className="import-modal-overlay open" onClick={handleClose}>
      <div className="import-modal" style={result ? { maxWidth: 680 } : undefined} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <h3 style={{ fontSize: 18, fontWeight: 700 }}>{result ? 'Import Complete' : 'Import Memories'}</h3>
          <button onClick={handleClose} disabled={importing} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 18, opacity: importing ? 0.3 : 1 }}>×</button>
        </div>

        {result ? (
          <ImportResultView result={result} onReset={reset} onClose={handleClose} />
        ) : (
          <>
            <p style={{ marginBottom: 12 }}>
              Paste exported memories from Claude, ChatGPT, Gemini, or any other AI assistant. They'll be stored as private Knowledge Assets on your DKG node — owned by you, queryable by your agent.
            </p>

            <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
              {SOURCE_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  className={`dkg-btn ${source === opt.value ? '' : 'dkg-btn-secondary'}`}
                  onClick={() => setSource(opt.value)}
                  style={{ padding: '6px 12px', fontSize: 11 }}
                >
                  <span style={{ fontSize: 12 }}>{opt.icon}</span>
                  {opt.label}
                </button>
              ))}
            </div>

            <div style={{ padding: '10px 14px', borderRadius: 8, background: 'var(--blue-dim)', border: '1px solid rgba(96,165,250,.2)', marginBottom: 16 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--blue)', marginBottom: 4 }}>HOW TO EXPORT</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                Paste this into {source === 'claude' ? 'Claude' : source === 'chatgpt' ? 'ChatGPT' : source === 'gemini' ? 'Gemini' : 'your AI assistant'} to export your memories:<br />
                <code className="mono" style={{ fontSize: 10, color: 'var(--text)', background: 'rgba(255,255,255,.05)', padding: '2px 6px', borderRadius: 4, display: 'inline-block', marginTop: 4 }}>
                  "List every memory you have stored about me in a single code block."
                </code>
              </div>
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--text-muted)', marginBottom: 10, cursor: 'pointer' }}>
              <input type="checkbox" checked={useLlm} onChange={e => setUseLlm(e.target.checked)} disabled={importing} />
              <span>Use LLM-assisted parsing <span style={{ fontSize: 10, opacity: 0.7 }}>(sends memories to configured LLM for better categorisation &amp; entity extraction)</span></span>
            </label>

            <textarea
              value={text}
              onChange={e => setText(e.target.value)}
              placeholder="Paste your exported memories here..."
              disabled={importing}
            />

            {text.trim() && (
              <div className="mono" style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 6 }}>
                {text.trim().split('\n').filter(l => l.trim().length > 3).length} lines detected
              </div>
            )}

            {error && (
              <div style={{ marginTop: 10, padding: '8px 12px', borderRadius: 6, background: 'var(--red-dim)', border: '1px solid rgba(248,113,113,.2)', color: 'var(--red)', fontSize: 12 }}>
                {error}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
              <button className="dkg-btn dkg-btn-secondary" onClick={handleClose} disabled={importing}>Cancel</button>
              <button className="dkg-btn dkg-btn-solid" onClick={handleImport} disabled={importing || !text.trim()}>
                {importing ? (
                  <>
                    <span style={{ width: 12, height: 12, border: '2px solid rgba(10,15,26,.3)', borderTopColor: 'var(--bg)', borderRadius: '50%', animation: 'spin .6s linear infinite', display: 'inline-block' }} />
                    Importing…
                  </>
                ) : (
                  <>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                    Import as Private Knowledge
                  </>
                )}
              </button>
            </div>
          </>
        )}
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

const FALLBACK_PARANETS = [
  { name: 'OriginTrail Game', assets: 847,  agents: 12, color: 'var(--green)' },
  { name: 'DeSci Research',   assets: 1203, agents: 8,  color: 'var(--blue)' },
  { name: 'Supply Chain EU',  assets: 797,  agents: 4,  color: 'var(--amber)' },
];

// ── Recent Operations Mini Waterfall ─────────────────────────────────────────

const PHASE_COLORS: Record<string, string> = {
  prepare: '#3b82f6', 'prepare:ensureParanet': '#60a5fa', 'prepare:partition': '#2563eb',
  'prepare:manifest': '#93c5fd', 'prepare:validate': '#1d4ed8', 'prepare:merkle': '#7dd3fc',
  store: '#8b5cf6', chain: '#f59e0b', 'chain:sign': '#fbbf24', 'chain:submit': '#d97706',
  'chain:metadata': '#f97316', broadcast: '#22c55e', decode: '#14b8a6', validate: '#2dd4bf',
  'read-workspace': '#06b6d4', parse: '#3b82f6', execute: '#8b5cf6', transfer: '#60a5fa',
  verify: '#22c55e',
};
const PHASE_FALLBACK_COLOR = '#a78bfa';

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
      {hover !== null && phases[hover] && (
        <div style={{
          position: 'absolute', bottom: '100%', left: '50%', transform: 'translateX(-50%)',
          marginBottom: 6, padding: '4px 8px', borderRadius: 6,
          background: 'var(--surface)', border: '1px solid var(--border)',
          boxShadow: '0 4px 12px rgba(0,0,0,.4)',
          whiteSpace: 'nowrap', fontSize: 10, zIndex: 10, pointerEvents: 'none',
        }}>
          <span style={{ fontWeight: 700, color: PHASE_COLORS[phases[hover].phase] ?? PHASE_FALLBACK_COLOR }}>
            {phases[hover].phase}
          </span>
          <span style={{ color: 'var(--text-muted)', margin: '0 4px' }}>·</span>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", color: 'var(--text)' }}>
            {formatDuration(phases[hover].duration_ms)}
          </span>
          {phases[hover].status === 'error' && (
            <span style={{ color: '#ef4444', marginLeft: 4, fontWeight: 600 }}>FAIL</span>
          )}
        </div>
      )}
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
        <span style={{ color: 'var(--text-muted)' }}>Status: <strong style={{ color: op.status === 'error' ? '#ef4444' : '#22c55e' }}>{op.status}</strong></span>
        <span style={{ color: 'var(--text-muted)' }}>Duration: <strong style={{ fontFamily: "'JetBrains Mono', monospace" }}>{formatDuration(op.duration_ms)}</strong></span>
        {op.error_message && <span style={{ color: '#ef4444', fontSize: 10 }}>{op.error_message}</span>}
      </div>
      {phases?.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginBottom: recentLogs.length ? 8 : 0 }}>
          {phases.map((p: any, i: number) => (
            <div key={`${p.phase}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: p.status === 'error' ? '#ef4444' : PHASE_COLORS[p.phase] ?? PHASE_FALLBACK_COLOR, flexShrink: 0 }} />
              <span style={{ color: PHASE_COLORS[p.phase] ?? PHASE_FALLBACK_COLOR, fontWeight: 600, minWidth: 100 }}>{p.phase}</span>
              <span className="mono" style={{ color: 'var(--text-dim)' }}>{formatDuration(p.duration_ms)}</span>
              {p.status === 'error' && <span style={{ color: '#ef4444', fontWeight: 600 }}>FAILED</span>}
            </div>
          ))}
        </div>
      )}
      {recentLogs.length > 0 && (
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 6 }}>
          <div style={{ fontSize: 9, color: 'var(--text-dim)', marginBottom: 4, fontWeight: 600 }}>Recent logs</div>
          {recentLogs.map((l: any, i: number) => (
            <div key={i} style={{ fontSize: 10, color: l.level === 'error' ? '#ef4444' : l.level === 'warn' ? '#f59e0b' : 'var(--text-muted)', lineHeight: 1.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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
                  color: isError ? '#ef4444' : '#22c55e',
                }}>
                  {op.operation_name}
                </span>
                <DashMiniGantt phases={phases} totalMs={dur} />
                <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)', width: 50, textAlign: 'right', flexShrink: 0 }}>
                  {formatDuration(dur)}
                </span>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: isError ? '#ef4444' : op.status === 'in_progress' ? '#f59e0b' : '#22c55e', flexShrink: 0 }} />
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
      <div className="paranet-card" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 60 }}>
        <span style={{ fontSize: 11, color: 'var(--green)', fontWeight: 600 }}>No errors in 7 days</span>
      </div>
    );
  }

  return (
    <div className="paranet-card" style={{ padding: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--red, #ef4444)', marginBottom: 6 }}>Error Hotspots (7d)</div>
      {hotspots.map((h: any, i: number) => (
        <div key={`${h.operation_name}-${h.phase}-${i}`} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, padding: '3px 0', color: 'var(--text-muted)' }}>
          <span>
            <span style={{ color: 'var(--text-dim)', fontSize: 10 }}>{h.operation_name}</span>
            <span style={{ color: 'var(--text-dim)', margin: '0 4px' }}>&rsaquo;</span>
            <span style={{ color: PHASE_COLORS[h.phase] ?? PHASE_FALLBACK_COLOR, fontWeight: 500 }}>{h.phase}</span>
          </span>
          <span style={{ color: '#ef4444', fontWeight: 700 }}>{h.error_count}</span>
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
    <div className="paranet-card" style={{ padding: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--amber)', marginBottom: 6 }}>Spending ({latest.label})</div>
      <div style={{ display: 'flex', gap: 16, fontSize: 11, color: 'var(--text-muted)' }}>
        <div>
          <div className="mono" style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{latest.totalGasEth?.toFixed(6) ?? '0'}</div>
          <div>ETH gas</div>
        </div>
        <div>
          <div className="mono" style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{latest.totalTrac?.toFixed(2) ?? '0'}</div>
          <div>TRAC</div>
        </div>
        <div>
          <div className="mono" style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{latest.publishCount ?? 0}</div>
          <div>publishes</div>
        </div>
      </div>
    </div>
  );
}

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
  const totalKCs = (metrics as any)?.total_kcs ?? null;
  const confirmedKCs = (metrics as any)?.confirmed_kcs ?? null;
  const tentativeKCs = (metrics as any)?.tentative_kcs ?? null;
  const agentCount = agentData?.agents != null ? agentData.agents.length : null;

  return (
    <div className="page-section">
      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} />

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700 }}>Dashboard</h1>
          <p style={{ marginTop: 4 }}>
            {status ? `Your node is live${paranets.length ? ` and participating in ${paranets.length} paranet${paranets.length !== 1 ? 's' : ''}` : ''}` : 'Loading node status…'}
          </p>
        </div>
        <button className="dkg-btn" onClick={() => setImportOpen(true)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Import Memories
        </button>
      </div>

      {/* Stat cards */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
        {([
          {
            label: 'Knowledge Collections',
            value: confirmedKCs != null && tentativeKCs != null
              ? String(Number(confirmedKCs) + Number(tentativeKCs))
              : totalKCs != null ? Number(totalKCs).toLocaleString() : '—',
            sub: confirmedKCs != null && tentativeKCs != null
              ? <><span style={{ color: 'var(--green)' }}>{Number(confirmedKCs).toLocaleString()} confirmed</span>{' · '}<span style={{ color: 'var(--amber)' }}>{Number(tentativeKCs).toLocaleString()} tentative</span></>
              : totalKCs != null ? 'from node metrics' : 'loading…',
            color: 'var(--green)',
          },
          { label: 'Connected Peers', value: peerCount != null ? String(peerCount) : '—', sub: peerCount != null ? 'live' : 'loading…', color: 'var(--blue)' },
          { label: 'Agents Discovered', value: agentCount != null ? String(agentCount) : '—', sub: `Across ${displayParanets.length} paranet${displayParanets.length !== 1 ? 's' : ''}`, color: 'var(--amber)' },
        ] as Array<{ label: string; value: string; sub: React.ReactNode; color: string }>).map(s => (
          <div className="stat-card" key={s.label}>
            <div className="accent" style={{ background: `linear-gradient(90deg,${s.color}44,transparent)` }} />
            <div className="stat-label">{s.label}</div>
            <div className="stat-value mono">{s.value}</div>
            <div className="stat-sub">{s.sub}</div>
          </div>
        ))}
      </div>

      {/* Network viz — full width */}
      <div style={{ position: 'relative', height: 340, borderRadius: 12, overflow: 'hidden', background: '#0a0f1a', border: '1px solid var(--border)', marginBottom: 16 }}>
        <div style={{ position: 'absolute', top: 14, left: 18, zIndex: 2, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="pulse-dot" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--green)', boxShadow: '0 0 6px rgba(74,222,128,.53)', display: 'inline-block' }} />
          <span className="mono" style={{ fontSize: 12, fontWeight: 700 }}>{status?.networkName ?? 'DKG Network'}</span>
          <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>{peerCount != null ? `${peerCount} PEERS` : '… PEERS'}</span>
          <span className="mono" style={{ fontSize: 9, color: 'var(--text-dim)', marginLeft: 4 }}>scroll to zoom · drag to pan</span>
        </div>
        <DashboardNetworkViz agents={agentData?.agents ?? []} nodeName={status?.name ?? ''} />
      </div>

      {/* Paranets — horizontal card grid */}
      <div style={{ marginBottom: 16 }}>
        <div className="section-title">
          Paranets
          {!isLiveParanets && <span className="mono" style={{ fontSize: 9, color: 'var(--text-dim)', fontWeight: 400 }}>DEMO</span>}
        </div>
        <div className="paranet-list">
          {displayParanets.map((p: any, i: number) => (
            <div key={p.id ?? `fallback-${i}`} className="paranet-card" onClick={() => p.id && navigate(`/explorer?paranet=${encodeURIComponent(p.id)}`)}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                <span style={{ width: 7, height: 7, borderRadius: 3, background: p.color, display: 'inline-block' }} />
                <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>{p.name}</h3>
                <span className="pulse-dot" style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--green)', display: 'inline-block', marginLeft: 'auto' }} />
              </div>
              <div className="mono" style={{ display: 'flex', gap: 14, fontSize: 10, color: 'var(--text-muted)' }}>
                <span>{p.assets.toLocaleString()} assets</span>
                <span>{p.agents} agents</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Recent operations waterfall */}
      <RecentOpsSection />

      {/* Health + Spending cards */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
        <ErrorHotspotsCard />
        <SpendingCard />
      </div>

      {/* Quick actions */}
      <div className="quick-actions" style={{ marginBottom: 16 }}>
        {[
          { label: 'Query the Graph', desc: 'SPARQL queries', icon: '⌘' },
          { label: 'Import Memories', desc: 'From Claude / ChatGPT', icon: '📥', onClick: () => setImportOpen(true) },
          { label: 'Play OriginTrail', desc: 'Test your node', icon: '🎮' },
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
