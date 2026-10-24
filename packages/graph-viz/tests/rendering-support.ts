import { vi, type Mock } from 'vitest';
import { GraphModelNode } from '../src/core/graph-node.js';
import { PrefixManager } from '../src/core/prefix-manager.js';
import { StyleEngine } from '../src/core/style-engine.js';
import { HexagonPainter } from '../src/core/hexagon-painter.js';
import { GraphEventEmitter } from '../src/core/events.js';
import type { GraphEdge, StyleConfig } from '../src/core/types.js';

export function node(id: string, values: Partial<GraphModelNode> = {}) {
  return Object.assign(new GraphModelNode(id), values);
}
export function edge(source: string, target: string, label = 'knows'): GraphEdge {
  return { id: `${source}-${target}`, source, target, predicate: 'https://schema.org/knows', label };
}
export const nodes = (...items: GraphModelNode[]) => new Map(items.map(item => [item.id, item]));
export const edges = (...items: GraphEdge[]) => new Map(items.map(item => [item.id, item]));
export function config(style?: StyleConfig) {
  const container = document.createElement('div');
  const prefix = new PrefixManager();
  const styleEngine = new StyleEngine(style, prefix);
  return { container, styleEngine, hexPainter: new HexagonPainter(undefined, styleEngine, prefix), events: new GraphEventEmitter() };
}

/** Records pixels' drawing inputs and style at paint time; no browser/GPU is needed. */
export function canvasContext(): {
  ctx: CanvasRenderingContext2D & { [K in 'arc' | 'fill' | 'fillText' | 'drawImage']: Mock };
  paints: Array<{ method: string; args: unknown[]; fill: unknown; stroke: unknown; alpha: number; width: number; shadow: number }>;
  gradient: { addColorStop: Mock };
} {
  const paints: Array<{ method: string; args: unknown[]; fill: unknown; stroke: unknown; alpha: number; width: number; shadow: number }> = [];
  const ctx: Record<string, any> = { fillStyle: '', strokeStyle: '', globalAlpha: 1, lineWidth: 1, shadowBlur: 0 };
  const stack: Record<string, any>[] = [];
  for (const method of ['beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'clip', 'setLineDash', 'roundRect', 'clearRect']) ctx[method] = vi.fn();
  for (const method of ['fill', 'stroke', 'fillText', 'drawImage']) ctx[method] = vi.fn((...args: unknown[]) => {
    paints.push({ method, args, fill: ctx.fillStyle, stroke: ctx.strokeStyle, alpha: ctx.globalAlpha, width: ctx.lineWidth, shadow: ctx.shadowBlur });
  });
  ctx.save = vi.fn(() => stack.push(Object.fromEntries(Object.entries(ctx).filter(([, value]) => typeof value !== 'function'))));
  ctx.restore = vi.fn(() => Object.assign(ctx, stack.pop()));
  ctx.measureText = vi.fn((text: string) => ({ width: text.length * 6 }));
  const gradient = { addColorStop: vi.fn() };
  ctx.createRadialGradient = vi.fn(() => gradient);
  return { ctx: ctx as CanvasRenderingContext2D & { [K in 'arc' | 'fill' | 'fillText' | 'drawImage']: Mock }, paints, gradient };
}

/** force-graph's public fluent API boundary, including real getter/setter semantics. */
export function graphDriver() {
  const values = new Map<string, any>();
  const methods = new Map<string, ReturnType<typeof vi.fn>>();
  const forces = new Map<string, any>();
  const absent = new Set<string>();
  for (const name of ['charge', 'link', 'center']) {
    const force: Record<string, any> = {};
    for (const setter of ['strength', 'distance', 'distanceMax']) force[setter] = vi.fn(() => force);
    forces.set(name, force);
  }
  let chain: any;
  chain = new Proxy({}, { get: (_target, key) => {
    const name = String(key);
    if (absent.has(name)) return undefined;
    if (!methods.has(name)) methods.set(name, vi.fn((...args: any[]) => {
      if (name === 'd3Force') {
        if (args.length === 1) return forces.get(args[0]);
        forces.set(args[0], args[1]); return chain;
      }
      if (!args.length && values.has(name)) return values.get(name);
      if (args.length) values.set(name, args[0]);
      return chain;
    }));
    return methods.get(name);
  } });
  return { chain, values, forces, absent, call: (name: string, ...args: any[]) => values.get(name)(...args), method: (name: string) => chain[name] as ReturnType<typeof vi.fn> };
}
