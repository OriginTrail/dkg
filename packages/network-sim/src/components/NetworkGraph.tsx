import { useRef, useEffect, useCallback } from 'react';
import type { DevnetNode, GraphAnimation, OperationType } from '../types';
import { OP_COLORS } from '../types';

interface Props {
  nodes: DevnetNode[];
  animations: GraphAnimation[];
  selectedNode: number;
  onSelectNode: (id: number) => void;
}

interface NodePos {
  x: number;
  y: number;
}

const NODE_RADIUS = 22;
const GLOW_RADIUS = 36;
const PARTICLE_RADIUS = 6;
const PARTICLE_GLOW = 18;

function getNodePositions(nodes: DevnetNode[], cx: number, cy: number, radius: number): NodePos[] {
  return nodes.map((_, i) => {
    const angle = (i / nodes.length) * Math.PI * 2 - Math.PI / 2;
    return {
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
    };
  });
}

function drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.save();
  ctx.strokeStyle = 'rgba(99, 102, 241, 0.04)';
  ctx.lineWidth = 1;
  const step = 40;
  for (let x = 0; x < w; x += step) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let y = 0; y < h; y += step) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawConnection(
  ctx: CanvasRenderingContext2D,
  from: NodePos,
  to: NodePos,
  active: boolean,
) {
  ctx.save();
  ctx.strokeStyle = active ? 'rgba(99, 102, 241, 0.25)' : 'rgba(99, 102, 241, 0.08)';
  ctx.lineWidth = active ? 1.5 : 1;
  ctx.setLineDash(active ? [] : [4, 4]);
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.restore();
}

function drawNode(
  ctx: CanvasRenderingContext2D,
  pos: NodePos,
  node: DevnetNode,
  isSelected: boolean,
  _dpr: number,
) {
  ctx.save();

  if (isSelected) {
    const glow = ctx.createRadialGradient(pos.x, pos.y, NODE_RADIUS, pos.x, pos.y, GLOW_RADIUS);
    glow.addColorStop(0, 'rgba(99, 102, 241, 0.35)');
    glow.addColorStop(1, 'transparent');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, GLOW_RADIUS, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.beginPath();
  ctx.arc(pos.x, pos.y, NODE_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = isSelected ? '#1e1b4b' : '#0f0f23';
  ctx.fill();
  ctx.strokeStyle = node.online
    ? isSelected
      ? '#818cf8'
      : '#4f46e5'
    : '#374151';
  ctx.lineWidth = isSelected ? 2.5 : 1.5;
  ctx.stroke();

  const statusColor = node.online ? '#10b981' : '#ef4444';
  ctx.beginPath();
  ctx.arc(pos.x + 15, pos.y - 15, 4.5, 0, Math.PI * 2);
  ctx.fillStyle = statusColor;
  ctx.fill();
  ctx.strokeStyle = '#0a0a1a';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  if (node.online) {
    const pulse = ctx.createRadialGradient(
      pos.x + 15,
      pos.y - 15,
      4,
      pos.x + 15,
      pos.y - 15,
      10,
    );
    pulse.addColorStop(0, 'rgba(16, 185, 129, 0.3)');
    pulse.addColorStop(1, 'transparent');
    ctx.fillStyle = pulse;
    ctx.beginPath();
    ctx.arc(pos.x + 15, pos.y - 15, 10, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.font = '600 11px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = node.online ? '#e2e8f0' : '#64748b';
  ctx.fillText(`N${node.id}`, pos.x, pos.y);

  ctx.font = '500 10px Inter, system-ui, sans-serif';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText(node.name.replace('devnet-', ''), pos.x, pos.y + NODE_RADIUS + 14);

  const roleLabel = node.nodeRole === 'core' ? 'RELAY' : 'EDGE';
  ctx.font = '600 8px JetBrains Mono, monospace';
  ctx.fillStyle = node.nodeRole === 'core' ? '#818cf8' : '#64748b';
  ctx.fillText(roleLabel, pos.x, pos.y + NODE_RADIUS + 26);

  if (node.online && node.status) {
    ctx.font = '500 9px JetBrains Mono, monospace';
    ctx.fillStyle = '#6366f1';
    ctx.fillText(`${node.status.connectedPeers}p`, pos.x, pos.y + NODE_RADIUS + 38);
  }

  ctx.restore();
}

function drawParticle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  type: OperationType,
) {
  const color = OP_COLORS[type] || '#ffffff';
  ctx.save();

  const glow = ctx.createRadialGradient(x, y, 0, x, y, PARTICLE_GLOW);
  glow.addColorStop(0, color + 'aa');
  glow.addColorStop(0.4, color + '44');
  glow.addColorStop(1, 'transparent');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(x, y, PARTICLE_GLOW, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, PARTICLE_RADIUS, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(x, y, 2, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function drawPulse(
  ctx: CanvasRenderingContext2D,
  pos: NodePos,
  type: OperationType,
  progress: number,
) {
  const color = OP_COLORS[type] || '#ffffff';
  const r = NODE_RADIUS + progress * 40;
  const alpha = 1 - progress;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.globalAlpha = alpha * 0.6;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawLegend(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const entries: [string, string][] = [
    ['Publish', OP_COLORS.publish],
    ['Shared Memory', OP_COLORS.workspace],
    ['Query', OP_COLORS.query],
    ['Chat', OP_COLORS.chat],
    ['Access', OP_COLORS.access],
    ['Stake', OP_COLORS.stake],
    ['FairSwap', OP_COLORS.fairswap],
    ['Conviction', OP_COLORS.conviction],
  ];

  const padding = 12;
  const lineH = 18;
  const boxW = 100;
  const boxH = padding * 2 + entries.length * lineH;
  const x = w - boxW - 16;
  const y = h - boxH - 16;

  ctx.save();
  ctx.fillStyle = 'rgba(10, 10, 26, 0.85)';
  ctx.strokeStyle = 'rgba(99, 102, 241, 0.2)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x, y, boxW, boxH, 6);
  ctx.fill();
  ctx.stroke();

  ctx.font = '500 10px Inter, system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  entries.forEach(([label, color], i) => {
    const ly = y + padding + i * lineH + lineH / 2;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x + padding + 4, ly, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(label, x + padding + 14, ly);
  });

  ctx.restore();
}

export function NetworkGraph({ nodes, animations, selectedNode, onSelectNode }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    const cx = w / 2;
    const cy = h / 2;
    const graphRadius = Math.min(cx, cy) * 0.55;

    ctx.save();
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0a0a1a';
    ctx.fillRect(0, 0, w, h);

    drawGrid(ctx, w, h);

    const positions = getNodePositions(nodes, cx, cy, graphRadius);

    const activeEdges = new Set<string>();
    for (const anim of animations) {
      if (anim.from !== anim.to) {
        const key = [Math.min(anim.from, anim.to), Math.max(anim.from, anim.to)].join('-');
        activeEdges.add(key);
      }
    }

    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        const key = `${i}-${j}`;
        drawConnection(ctx, positions[i], positions[j], activeEdges.has(key));
      }
    }

    for (const anim of animations) {
      if (anim.progress < 0) continue;
      if (anim.from === anim.to) {
        drawPulse(ctx, positions[anim.from], anim.type, anim.progress);
      } else {
        const from = positions[anim.from];
        const to = positions[anim.to];
        if (from && to) {
          const ease = anim.progress < 0.5
            ? 2 * anim.progress * anim.progress
            : 1 - Math.pow(-2 * anim.progress + 2, 2) / 2;
          const x = from.x + (to.x - from.x) * ease;
          const y = from.y + (to.y - from.y) * ease;
          drawParticle(ctx, x, y, anim.type);
        }
      }
    }

    for (let i = 0; i < nodes.length; i++) {
      drawNode(ctx, positions[i], nodes[i], nodes[i].id === selectedNode, dpr);
    }

    drawLegend(ctx, w, h);
    ctx.restore();
  }, [nodes, animations, selectedNode]);

  useEffect(() => {
    let raf: number;
    const loop = () => {
      draw();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
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

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current!;
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const w = canvas.width / dpr;
      const h = canvas.height / dpr;
      const cx = w / 2;
      const cy = h / 2;
      const graphRadius = Math.min(cx, cy) * 0.55;
      const positions = getNodePositions(nodes, cx, cy, graphRadius);

      for (let i = 0; i < positions.length; i++) {
        const dx = mx - positions[i].x;
        const dy = my - positions[i].y;
        if (Math.sqrt(dx * dx + dy * dy) < NODE_RADIUS + 8) {
          onSelectNode(nodes[i].id);
          return;
        }
      }
    },
    [nodes, onSelectNode],
  );

  return (
    <div ref={containerRef} className="network-graph">
      <canvas ref={canvasRef} onClick={handleClick} style={{ cursor: 'pointer' }} />
    </div>
  );
}
