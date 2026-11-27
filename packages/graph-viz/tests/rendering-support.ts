import { vi, type Mock } from 'vitest';
import type { Object3D, PerspectiveCamera, Sprite } from 'three';
import { GraphModelNode } from '../src/core/graph-node.js';
import { PrefixManager } from '../src/core/prefix-manager.js';
import { StyleEngine } from '../src/core/style-engine.js';
import { HexagonPainter } from '../src/core/hexagon-painter.js';
import { GraphEventEmitter } from '../src/core/events.js';
import type { ForceNode, ForceLink, GraphEdge, StyleConfig } from '../src/core/types.js';

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

type RenderNode = Partial<ForceNode> & { z?: number; __threeObj?: Object3D };
type RenderLink = Partial<Omit<ForceLink, 'source' | 'target'>> & {
  source?: string | RenderNode;
  target?: string | RenderNode;
};
type ParticleNumber = (link?: RenderLink) => number;
type ParticleColor = (link?: RenderLink) => string;
interface GraphCallbacks {
  nodeCanvasObjectMode: (node: RenderNode) => string;
  nodeCanvasObject: (node: RenderNode, ctx: CanvasRenderingContext2D, scale: number) => void;
  nodePointerAreaPaint: (node: RenderNode, color: string, ctx: CanvasRenderingContext2D) => void;
  linkColor: (link: RenderLink) => string;
  linkCanvasObjectMode: () => string;
  linkCanvasObject: (link: RenderLink, ctx: CanvasRenderingContext2D, scale: number) => void;
  onRenderFramePre: (ctx: CanvasRenderingContext2D, scale: number) => void;
  onNodeClick: (node: RenderNode) => void;
  onNodeHover: (node: RenderNode | null) => void;
  onNodeDrag: (node: RenderNode) => void;
  onNodeDragEnd: (node: RenderNode) => void;
  onLinkClick: (link: RenderLink) => void;
  onBackgroundClick: (event?: object) => void;
  onEngineStop: () => void;
  nodeColor: (node: RenderNode) => string;
  nodeVal: (node: RenderNode) => number;
  nodeThreeObject: (node: RenderNode) => Sprite | undefined;
  linkDirectionalParticles: ParticleNumber;
  linkDirectionalParticleSpeed: ParticleNumber;
  linkDirectionalParticleWidth: ParticleNumber;
  linkDirectionalParticleColor: ParticleColor;
}
interface CapturedValues extends Omit<GraphCallbacks, 'linkColor' | 'linkDirectionalParticles' | 'linkDirectionalParticleSpeed' | 'linkDirectionalParticleWidth' | 'linkDirectionalParticleColor'> {
  width: number;
  height: number;
  backgroundColor: string;
  linkColor: string | GraphCallbacks['linkColor'];
  linkWidth: number;
  linkDirectionalArrowLength: number;
  linkDirectionalArrowRelPos: number;
  cooldownTicks: number;
  warmupTicks: number;
  d3AlphaDecay: number;
  d3AlphaTarget: number;
  d3VelocityDecay: number;
  nodeOpacity: number;
  nodeResolution: number;
  nodeThreeObjectExtend: boolean;
  linkOpacity: number;
  linkDirectionalParticles: number | ParticleNumber;
  linkDirectionalParticleSpeed: number | ParticleNumber;
  linkDirectionalParticleWidth: number | ParticleNumber;
  linkDirectionalParticleColor: string | ParticleColor;
  graphData: { nodes: RenderNode[]; links: RenderLink[] };
  camera: PerspectiveCamera | null;
}

// Only these settings have force-graph's ordinary getter/fluent-setter behavior.
const fluentSettings = [
  'width', 'height', 'backgroundColor', 'nodeCanvasObjectMode', 'nodeCanvasObject',
  'nodePointerAreaPaint', 'linkColor', 'linkWidth', 'linkDirectionalArrowLength',
  'linkDirectionalArrowRelPos', 'linkCanvasObjectMode', 'linkCanvasObject',
  'onRenderFramePre', 'onNodeClick', 'onNodeHover', 'onNodeDrag', 'onNodeDragEnd',
  'onLinkClick', 'onBackgroundClick', 'onEngineStop', 'cooldownTicks', 'warmupTicks',
  'd3AlphaDecay', 'd3AlphaTarget', 'd3VelocityDecay', 'nodeColor', 'nodeVal',
  'nodeOpacity', 'nodeResolution', 'nodeThreeObject', 'nodeThreeObjectExtend',
  'linkOpacity', 'linkDirectionalParticles', 'linkDirectionalParticleSpeed',
  'linkDirectionalParticleWidth', 'linkDirectionalParticleColor',
] as const satisfies readonly (keyof CapturedValues)[];
const commands = ['refresh', '_destructor', 'd3ReheatSimulation', 'centerAt', 'zoom', 'zoomToFit', 'cameraPosition'] as const;
type GraphMethod = typeof fluentSettings[number] | typeof commands[number] | 'graphData' | 'camera' | 'd3Force';
type OptionalMethod = 'refresh' | '_destructor' | 'd3AlphaTarget' | 'linkDirectionalParticles';

function force() {
  const value = {
    strength: vi.fn((_strength: number) => value),
    distance: vi.fn((_distance: number) => value),
    distanceMax: vi.fn((_distance: number) => value),
  };
  return value;
}
interface Forces {
  charge?: ReturnType<typeof force>;
  link?: ReturnType<typeof force>;
  center?: ReturnType<typeof force>;
  chronoX?: ((alpha: number) => void) | null;
}

/** Explicit force-graph boundary: captured settings, commands, callbacks and registered forces. */
export function graphDriver() {
  const values: Partial<CapturedValues> = {};
  const forces: Forces = { charge: force(), link: force(), center: force() };
  const methods = {} as Record<GraphMethod, Mock>;
  const chain: Partial<Record<GraphMethod, Mock>> = {};
  function setting<K extends keyof CapturedValues>(name: K) {
    return vi.fn((...args: [] | [CapturedValues[K]]) => {
      if (!args.length) return values[name];
      values[name] = args[0];
      return chain;
    });
  }
  for (const name of fluentSettings) methods[name] = setting(name);
  for (const name of commands) methods[name] = vi.fn(() => chain);
  methods.graphData = setting('graphData');
  methods.camera = vi.fn(() => values.camera);
  methods.d3Force = vi.fn(<K extends keyof Forces>(name: K, ...args: [] | [Forces[K]]) => {
    if (!['charge', 'link', 'center', 'chronoX'].includes(name)) throw new Error(`Unsupported force: ${name}`);
    if (!args.length) return forces[name];
    forces[name] = args[0];
    return chain;
  });
  Object.assign(chain, methods);
  return {
    chain, values, forces,
    omit(name: OptionalMethod) { delete chain[name]; },
    clearForces() { for (const key of Object.keys(forces) as (keyof Forces)[]) delete forces[key]; },
    call<K extends keyof GraphCallbacks>(name: K, ...args: Parameters<GraphCallbacks[K]>): ReturnType<GraphCallbacks[K]> {
      const callback = values[name];
      if (typeof callback !== 'function') throw new Error(`No callback registered for ${name}`);
      return (callback as (...args: unknown[]) => unknown)(...args) as ReturnType<GraphCallbacks[K]>;
    },
    method(name: GraphMethod) {
      if (!Object.hasOwn(methods, name)) throw new Error(`Unsupported graph method: ${name}`);
      return methods[name];
    },
  };
}
