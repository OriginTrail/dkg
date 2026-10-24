// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphModel } from '../src/core/graph-model.js';
import { TemporalFilter, type TemporalConfig } from '../src/core/temporal-filter.js';
import { TimelineOverlay } from '../src/overlays/timeline-overlay.js';

const day = 86400000;
const start = new Date('2025-01-01T12:00:00Z').getTime();
let container: HTMLDivElement;
const overlays: TimelineOverlay[] = [];
const paint = { clearRect: vi.fn(), fillRect: vi.fn(), fillStyle: '' };

function make(dates = [start, start + day, start + day, start + 2 * day], options: Partial<TemporalConfig> = {}) {
  const model = new GraphModel();
  dates.forEach((time, index) => model.addTriple({ subject: `urn:n${index}`, predicate: 'https://schema.org/dateCreated', object: new Date(time).toISOString() }));
  model.addTriple({ subject: 'urn:undated', predicate: 'urn:label', object: 'Undated' });
  const filter = new TemporalFilter({ showUndated: false });
  filter.scan(model);
  const overlay = new TimelineOverlay(container, filter, { enabled: true, ...options });
  overlays.push(overlay);
  return { model, filter, overlay };
}
function slider() { return container.querySelector<HTMLInputElement>('input[type=range]')!; }
function playButton() { return container.querySelector<HTMLButtonElement>('button')!; }

beforeEach(() => {
  vi.useFakeTimers();
  paint.clearRect.mockClear(); paint.fillRect.mockClear();
  // Canvas is the rendering boundary; DOM events and temporal filtering remain real.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    (() => paint) as unknown as HTMLCanvasElement['getContext'],
  );
  container = document.createElement('div'); document.body.appendChild(container);
});
afterEach(() => {
  for (const overlay of overlays.splice(0)) overlay.unmount();
  container.remove(); document.getElementById('gv-timeline-styles')?.remove();
  vi.restoreAllMocks(); vi.useRealTimers();
});

describe('timeline DOM interactions with the real temporal filter', () => {
  it('mounts once, starts at the latest date, and shares one stylesheet across overlays', () => {
    const { overlay, filter } = make();
    overlay.mount(); overlay.mount();
    expect(container.querySelectorAll('.gv-timeline-overlay')).toHaveLength(1);
    expect(overlay.mounted).toBe(true);
    expect([Number(slider().min), Number(slider().max), Number(slider().value)]).toEqual([start, start + 2 * day, start + 2 * day]);
    expect(filter.cursor?.getTime()).toBe(start + 2 * day);
    expect(container.querySelector('.gv-tl-date')?.textContent).toContain('2025');
    make().overlay.mount();
    expect(document.querySelectorAll('#gv-timeline-styles')).toHaveLength(1);
  });

  it('translates user slider input and programmatic cursors into actual visible graph nodes', () => {
    const { overlay, filter, model } = make();
    const changed = vi.fn(); overlay.onChange(changed); overlay.mount();
    slider().value = String(start + day);
    slider().dispatchEvent(new Event('input', { bubbles: true }));
    expect(filter.getVisibleNodeIds(model.nodes.keys())).toEqual(new Set(['urn:n0', 'urn:n1', 'urn:n2']));
    expect(changed).toHaveBeenCalledExactlyOnceWith(new Date(start + day), 0);
    overlay.setCursor(new Date(start));
    expect(filter.getVisibleNodeIds(model.nodes.keys())).toEqual(new Set(['urn:n0']));
    overlay.updateCount(1234);
    expect(container.querySelector('.gv-tl-count')?.textContent).toBe((1234).toLocaleString());
  });

  it('restarts playback at the beginning, stops at the end, and does not create duplicate timers', () => {
    const { overlay, filter, model } = make(); overlay.mount();
    playButton().click(); overlay.play();
    expect(filter.cursor?.getTime()).toBe(start);
    expect(playButton().textContent).toBe('⏸');
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(200);
    expect(filter.getVisibleNodeIds(model.nodes.keys())?.size).toBe(3);
    vi.advanceTimersByTime(200);
    expect(filter.cursor?.getTime()).toBe(start + 2 * day);
    expect(playButton().textContent).toBe('▶');
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(filter.cursor?.getTime()).toBe(start + 2 * day);
  });

  it.each([
    ['hour', 3600000, 2 * day], ['day', day, 10 * day],
    ['week', 7 * day, 100 * day], ['month', 30 * day, 100 * day],
  ] as const)('honors %s steps and a custom playback interval', (stepSize, step, range) => {
    const { overlay, filter } = make([start, start + range], { stepSize, playSpeed: 50 });
    overlay.mount(); overlay.setCursor(new Date(start)); overlay.play();
    vi.advanceTimersByTime(49); expect(filter.cursor?.getTime()).toBe(start);
    vi.advanceTimersByTime(1); expect(filter.cursor?.getTime()).toBe(start + step);
    playButton().click();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(500); expect(filter.cursor?.getTime()).toBe(start + step);
  });

  it('scales playback steps for a very long date range', () => {
    const { overlay, filter } = make([start, start + 400 * day], { stepSize: 'hour' });
    overlay.mount(); overlay.setCursor(new Date(start)); overlay.play();
    vi.advanceTimersByTime(200);
    expect(filter.cursor?.getTime()).toBe(start + 2 * day);
  });

  it('clears playback on unmount and permits a fresh mount without duplicate callbacks', () => {
    const { overlay } = make(); const changed = vi.fn(); overlay.onChange(changed); overlay.mount();
    playButton().click(); changed.mockClear(); overlay.unmount(); overlay.unmount();
    expect(overlay.mounted).toBe(false); expect(container.children).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0); vi.advanceTimersByTime(1000); expect(changed).not.toHaveBeenCalled();
    overlay.mount(); slider().value = String(start); slider().dispatchEvent(new Event('input'));
    expect(changed).toHaveBeenCalledExactlyOnceWith(new Date(start), 0);
  });

  it('refreshes ranges after ingestion and removes the overlay when dated data disappears', () => {
    const { model, filter, overlay } = make(); overlay.refresh(); overlay.mount();
    model.addTriple({ subject: 'urn:later', predicate: 'https://schema.org/dateCreated', object: new Date(start + 10 * day).toISOString() });
    filter.scan(model); overlay.refresh();
    expect(Number(slider().max)).toBe(start + 10 * day);
    overlay.play(); filter.scan(new GraphModel()); overlay.refresh();
    expect(overlay.mounted).toBe(false); expect(vi.getTimerCount()).toBe(0);
    overlay.mount(); expect(container.children).toHaveLength(0);
  });

  it('draws a density histogram whose relative bar heights match the real dated nodes', () => {
    make().overlay.mount();
    expect(paint.clearRect).toHaveBeenCalledExactlyOnceWith(0, 0, 600, 32);
    const nonempty = paint.fillRect.mock.calls.filter(([, , , height]) => height > 0);
    expect(nonempty).toEqual([[0, 17, 3, 15], [300, 2, 3, 30], [596, 17, 3, 15]]);
  });

  it('keeps the slider usable when a canvas context is unavailable', () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);
    const { overlay, filter } = make(); overlay.mount(); overlay.setCursor(new Date(start));
    expect(filter.cursor?.getTime()).toBe(start); expect(paint.fillRect).not.toHaveBeenCalled();
  });
});
