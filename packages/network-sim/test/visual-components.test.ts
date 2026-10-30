// @vitest-environment happy-dom
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NetworkGraph } from '../src/components/NetworkGraph';
import { ActivityFeed } from '../src/components/ActivityFeed';
import type { Activity, GraphAnimation } from '../src/types';
import { makeStore, mountUi, type MountedUi } from './ui-test-support';

let ui: MountedUi;
let frames: Map<number, FrameRequestCallback>;
let resize: () => void;
let disconnect: ReturnType<typeof vi.fn>;
let ctx: ReturnType<typeof recorder>;
function recorder() {
  const gradient = { addColorStop: vi.fn() };
  return { save: vi.fn(), restore: vi.fn(), scale: vi.fn(), clearRect: vi.fn(), fillRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(),
    stroke: vi.fn(), fill: vi.fn(), arc: vi.fn(), fillText: vi.fn(), roundRect: vi.fn(), setLineDash: vi.fn(), createRadialGradient: vi.fn(() => gradient), gradient,
    fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1, font: '', textAlign: '', textBaseline: '' };
}
function renderFrame() { act(() => { const pending = Array.from(frames.values()); frames.clear(); pending.forEach(callback => callback(0)); }); }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('devicePixelRatio', 2);
  frames = new Map(); let nextId = 0;
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { const id = ++nextId; frames.set(id, callback); return id; }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => frames.delete(id)));
  disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback; } observe = vi.fn(); disconnect = disconnect; });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 20, y: 30, left: 20, top: 30, right: 820, bottom: 630, width: 800, height: 600, toJSON: () => ({}) });
  ctx = recorder(); vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
});
afterEach(() => { ui?.unmount(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('network graph drawing and interaction', () => {
  it('draws topology at CSS coordinates despite a high-DPI canvas and selects by hit testing', async () => {
    const nodes = makeStore().state.nodes;
    const onSelectNode = vi.fn();
    ui = await mountUi(React.createElement(NetworkGraph, { nodes, selectedNode: 2, animations: [], onSelectNode }));
    const canvas = ui.container.querySelector('canvas')!;
    expect([canvas.width, canvas.height, canvas.style.width, canvas.style.height]).toEqual([1600, 1200, '800px', '600px']);
    renderFrame();
    expect(ctx.scale).toHaveBeenCalledWith(2, 2); expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 800, 600);
    expect(ctx.fillText).toHaveBeenCalledWith('N1', 400, 135);
    expect(ctx.fillText).toHaveBeenCalledWith('node-1', 400, 171);
    expect(ctx.fillText).toHaveBeenCalledWith('RELAY', 400, 183);
    expect(ctx.fillText).toHaveBeenCalledWith('2p', 400, 195);
    expect(ctx.fillText.mock.calls.filter(([text]) => text === 'EDGE')).toHaveLength(2);
    expect(ctx.setLineDash.mock.calls.filter(([dash]) => dash.length === 2)).toHaveLength(3);
    await act(async () => canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 420, clientY: 165 })));
    expect(onSelectNode).toHaveBeenCalledExactlyOnceWith(1);
    await act(async () => canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 451, clientY: 165 })));
    expect(onSelectNode).toHaveBeenCalledTimes(1);
    await act(async () => canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 420 + Math.sqrt(3) * 82.5, clientY: 412.5 })));
    expect(onSelectNode).toHaveBeenLastCalledWith(2);
    ui.unmount(); expect(disconnect).toHaveBeenCalledTimes(1); expect(frames.size).toBe(0);
  });
  it('interpolates particles, draws local pulses and ignores delayed or invalid endpoints', async () => {
    const nodes = makeStore().state.nodes;
    const animation = (id: string, from: number, to: number, progress: number, type = 'query'): GraphAnimation => ({ id, from, to, progress, type: type as GraphAnimation['type'], speed: 1 });
    const animations = [animation('early', 0, 1, .25), animation('late', 0, 1, .75, 'unknown'), animation('pulse', 2, 2, .25, 'publish'),
      animation('fallback-pulse', 1, 1, .5, 'unknown'), animation('delayed', 0, 1, -.1), animation('missing', 99, 0, .5)];
    ui = await mountUi(React.createElement(NetworkGraph, { nodes, selectedNode: 3, animations, onSelectNode: vi.fn() }));
    renderFrame();
    const particles = ctx.arc.mock.calls.filter(([, , radius]) => radius === 6);
    expect(particles).toHaveLength(2);
    expect(particles[0][0]).toBeCloseTo(400 + Math.sqrt(3) * 82.5 * .125);
    expect(particles[0][1]).toBeCloseTo(135 + 247.5 * .125);
    expect(particles[1][0]).toBeCloseTo(400 + Math.sqrt(3) * 82.5 * .875);
    expect(particles[1][1]).toBeCloseTo(135 + 247.5 * .875);
    expect(ctx.arc.mock.calls.some(([, , radius]) => radius === 32)).toBe(true);
    expect(ctx.arc.mock.calls.some(([, , radius]) => radius === 42)).toBe(true);
    expect(ctx.setLineDash).toHaveBeenCalledWith([]);
    expect(ctx.gradient.addColorStop).toHaveBeenCalledWith(0, '#ffffffaa');
    expect(ctx.fillText).toHaveBeenCalledWith('Conviction', expect.any(Number), expect.any(Number));
  });
  it('resizes with device-pixel-ratio fallback and handles empty topology', async () => {
    vi.stubGlobal('devicePixelRatio', 0);
    ui = await mountUi(React.createElement(NetworkGraph, { nodes: [], selectedNode: 1, animations: [], onSelectNode: vi.fn() }));
    act(() => resize()); renderFrame();
    const canvas = ui.container.querySelector('canvas')!;
    expect([canvas.width, canvas.height]).toEqual([800, 600]); expect(ctx.scale).toHaveBeenCalledWith(1, 1);
    expect(ctx.fillText.mock.calls.filter(([text]) => /^N\d+$/.test(text))).toEqual([]);
    await act(async () => canvas.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  });
});

describe('activity feed presentation', () => {
  it('shows an empty state, then statuses, destinations and escaped details while scrolling to the newest item', async () => {
    ui = await mountUi(React.createElement(ActivityFeed, { activities: [] }));
    expect(ui.container.textContent).toContain('No activity yet');
    const list = ui.container.querySelector<HTMLElement>('.activity-list')!; list.scrollTop = 120;
    const activities: Activity[] = [
      { id: '1', ts: 0, type: 'publish', sourceNode: 1, targetNode: 2, status: 'success', label: 'published', detail: '<script>unsafe</script>' },
      { id: '2', ts: 0, type: 'query', sourceNode: 1, targetNode: 1, status: 'error', label: 'query failed' },
      { id: '3', ts: 0, type: 'chat', sourceNode: 2, status: 'pending', label: 'sending' },
    ];
    await ui.render(React.createElement(ActivityFeed, { activities }));
    expect(list.scrollTop).toBe(0); expect(ui.container.querySelector('.badge')?.textContent).toBe('3');
    expect(Array.from(ui.container.querySelectorAll('.activity-icon')).map(e => e.textContent)).toEqual(['✓', '✗', '◌']);
    expect(ui.container.querySelectorAll('.activity-arrow')).toHaveLength(1);
    expect(ui.container.querySelectorAll('script')).toHaveLength(0);
    expect(ui.container.querySelector('.activity-detail')?.textContent).toBe('<script>unsafe</script>');
    expect(ui.container.querySelector('.activity-time')?.textContent).toBe(new Date(0).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  });
});
