// @vitest-environment happy-dom

// The read-graphs section of a context graph's overview, against a stubbed
// node: what the node admin sees per layer, the off/build/serve switch, and
// that anyone else sees nothing.

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { READ_GRAPHS_POLL_MS, ReadGraphsSection, readGraphStateText } from '../src/ui/views/project/components/read-graphs.js';

const CG = '0x1111111111111111111111111111111111111111/read-graphs';
const SETTINGS = '/api/store/read-graphs/settings';

type Json = Record<string, unknown>;
interface Request { method: string; url: string; body?: Json }

let requests: Request[] = [];
let getAnswers: Array<[number, unknown]> = [];
let putAnswer: (body: Json) => Promise<[number, unknown]>;
let root: Root | null = null;

function answer(status: number, json: unknown) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => json };
}

/** A settings answer with the node's defaults: WM off, SWM build from config, VM serve set here and ready. */
function settings(overrides: { rows?: Json; effective?: Json; readGraphs?: Json[]; policy?: Json; refused?: Json } = {}, contextGraphId = CG): Json {
  return {
    policy: overrides.policy ?? { enabled: true, layers: ['working-memory', 'shared-working-memory', 'verifiable-memory'] },
    ...(overrides.refused ? { refused: overrides.refused } : {}),
    contextGraphs: [{
      contextGraphId,
      layers: overrides.rows ?? { 'verifiable-memory': 'serve' },
      effective: { layers: overrides.effective ?? { 'working-memory': 'off', 'shared-working-memory': 'build', 'verifiable-memory': 'serve' }, viewSemantics: 'per-asset' },
      readGraphs: overrides.readGraphs ?? [{ readGraph: 'urn:rg:vm', contextGraphId: CG, layer: 'vm', state: 'ready', generation: 2 }],
    }],
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

async function render(): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(React.createElement(ReadGraphsSection, { contextGraphId: CG }));
  });
  await flush();
  return container;
}

function row(container: HTMLElement, view: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`[data-layer="${view}"]`);
  if (!found) throw new Error(`no row for ${view}`);
  return found;
}

function button(scope: HTMLElement, name: string): HTMLButtonElement {
  const found = Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).find(candidate => candidate.textContent === name);
  if (!found) throw new Error(`no button ${name}`);
  return found;
}

function pressed(scope: HTMLElement): string[] {
  return Array.from(scope.querySelectorAll('button[aria-pressed="true"]')).map(node => node.textContent ?? '');
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => { target.click(); });
  await flush();
}

const gets = () => requests.filter(request => request.method === 'GET');
const puts = () => requests.filter(request => request.method === 'PUT');

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  requests = [];
  getAnswers = [];
  putAnswer = async () => [500, { error: 'unexpected PUT' }];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    requests.push({ method, url: String(input), ...(typeof init.body === 'string' ? { body: JSON.parse(init.body) } : {}) });
    if (method === 'PUT') return answer(...await putAnswer(JSON.parse(String(init.body))));
    const [status, json] = getAnswers.length > 1 ? getAnswers.shift()! : getAnswers[0] ?? [500, { error: 'no answer' }];
    return answer(status, json);
  }));
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ReadGraphsSection', () => {
  it.each([
    [403, { error: 'GET /api/store/read-graphs/settings requires a node-level admin token; agent-scoped tokens cannot read them.' }],
    [404, { error: 'Not found' }],
  ])('shows nothing when the node answers %i', async (status, body) => {
    getAnswers = [[status, body]];
    const container = await render();
    expect(gets()).toHaveLength(1);
    expect(container.innerHTML).toBe('');
  });

  it('shows each layer\'s mode, where it comes from, and its read graphs', async () => {
    getAnswers = [[200, settings()]];
    const container = await render();

    expect(gets()[0].url).toBe(`${SETTINGS}?contextGraphId=${encodeURIComponent(CG)}`);
    expect(container.querySelector('[data-section="read-graphs"]')?.textContent).toContain('Read graphs');
    const wm = row(container, 'working-memory');
    const swm = row(container, 'shared-working-memory');
    const vm = row(container, 'verifiable-memory');
    expect([wm, swm, vm].map(layer => layer.querySelector('.v10-po-join-name')?.textContent)).toEqual(['Working memory', 'Shared memory', 'Verifiable memory']);
    expect([wm, swm, vm].map(layer => layer.querySelector('[data-testid="read-graph-state"]')?.textContent)).toEqual(['No read graph', 'Waiting to be built', 'Ready']);
    expect([wm, swm, vm].map(pressed)).toEqual([['Off'], ['Build'], ['Serve']]);
    expect(wm.textContent).toContain('From the node\'s config');
    expect(vm.textContent).toContain('Set for this context graph');
    expect(container.querySelectorAll('button:disabled')).toHaveLength(0);
  });

  it('switches a layer, shows the node\'s answer, and reads the settings again', async () => {
    getAnswers = [[200, settings()]];
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    putAnswer = async () => {
      await released;
      return [200, {
        ...settings({
          effective: { 'working-memory': 'off', 'shared-working-memory': 'serve', 'verifiable-memory': 'serve' },
          rows: { 'shared-working-memory': 'serve', 'verifiable-memory': 'serve' },
          readGraphs: [
            { readGraph: 'urn:rg:swm', layer: 'swm', state: 'building', generation: 1 },
            { readGraph: 'urn:rg:vm', layer: 'vm', state: 'ready', generation: 2 },
          ],
        }),
        changes: [{ contextGraphId: CG, layer: 'shared-working-memory', from: 'build', to: 'serve', outcome: 'applied' }],
      }];
    };
    const container = await render();

    await click(button(row(container, 'shared-working-memory'), 'Serve'));
    expect(puts().map(request => request.body)).toEqual([{ contextGraphId: CG, layers: { 'shared-working-memory': 'serve' } }]);
    expect(row(container, 'shared-working-memory').querySelector('[role="status"]')?.textContent).toBe('Applying…');
    expect(Array.from(container.querySelectorAll<HTMLButtonElement>('.v10-po-rg-mode')).every(node => node.disabled)).toBe(true);

    getAnswers = [[200, settings({
      effective: { 'working-memory': 'off', 'shared-working-memory': 'serve', 'verifiable-memory': 'serve' },
      rows: { 'shared-working-memory': 'serve', 'verifiable-memory': 'serve' },
      readGraphs: [
        { readGraph: 'urn:rg:swm', layer: 'swm', state: 'ready', generation: 1 },
        { readGraph: 'urn:rg:vm', layer: 'vm', state: 'ready', generation: 2 },
      ],
    })]];
    await act(async () => { release(); });
    await flush();
    await flush();

    const swm = row(container, 'shared-working-memory');
    expect(pressed(swm)).toEqual(['Serve']);
    expect(swm.textContent).toContain('Set for this context graph');
    expect(swm.querySelector('[role="status"]')).toBeNull();
    expect(gets()).toHaveLength(2);
    expect(swm.querySelector('[data-testid="read-graph-state"]')?.textContent).toBe('Ready');
  });

  it('asks before switching a layer off, and can be cancelled', async () => {
    getAnswers = [[200, settings()]];
    const off = settings({
      rows: { 'verifiable-memory': 'off' },
      effective: { 'working-memory': 'off', 'shared-working-memory': 'build', 'verifiable-memory': 'off' },
    });
    putAnswer = async () => [200, off];
    const container = await render();
    getAnswers = [[200, off]];

    await click(button(row(container, 'verifiable-memory'), 'Off'));
    const confirm = row(container, 'verifiable-memory').querySelector<HTMLElement>('.v10-po-rg-confirm');
    expect(confirm?.getAttribute('aria-label')).toBe('Turn off Verifiable memory read graphs');
    expect(confirm?.textContent).toContain('drops the layer\'s read graphs');
    expect(puts()).toHaveLength(0);

    await click(button(confirm!, 'Cancel'));
    expect(row(container, 'verifiable-memory').querySelector('.v10-po-rg-confirm')).toBeNull();
    expect(puts()).toHaveLength(0);

    await click(button(row(container, 'verifiable-memory'), 'Off'));
    await click(button(row(container, 'verifiable-memory'), 'Turn off'));
    expect(puts().map(request => request.body)).toEqual([{ contextGraphId: CG, layers: { 'verifiable-memory': 'off' } }]);
    const vm = row(container, 'verifiable-memory');
    expect(pressed(vm)).toEqual(['Off']);
    expect(vm.querySelector('[data-testid="read-graph-state"]')?.textContent).toBe('Ready, being removed');
  });

  it('switches a layer that is off on without asking, and a click on its own mode does nothing', async () => {
    getAnswers = [[200, settings()]];
    putAnswer = async body => [200, settings({ rows: { ...(body.layers as Json), 'verifiable-memory': 'serve' } })];
    const container = await render();

    await click(button(row(container, 'verifiable-memory'), 'Serve'));
    expect(puts()).toHaveLength(0);

    await click(button(row(container, 'working-memory'), 'Build'));
    expect(row(container, 'working-memory').querySelector('.v10-po-rg-confirm')).toBeNull();
    expect(puts().map(request => request.body)).toEqual([{ contextGraphId: CG, layers: { 'working-memory': 'build' } }]);
  });

  it('shows the node\'s refusal on the layer and keeps its mode', async () => {
    getAnswers = [[200, settings()]];
    const sentence = 'This node\'s rollback target is 10.1.1, and read graphs need 10.1.2 or later there first.';
    putAnswer = async () => [409, {
      code: 'READ_GRAPHS_ROLLBACK_TARGET_OLDER',
      error: sentence,
      rollbackTarget: { source: 'config', version: '10.1.1' },
      firstRecognizingRelease: '10.1.2',
    }];
    const container = await render();

    await click(button(row(container, 'working-memory'), 'Build'));
    const wm = row(container, 'working-memory');
    expect(wm.querySelector('[role="alert"]')?.textContent).toBe(sentence);
    expect(pressed(wm)).toEqual(['Off']);
    expect(gets()).toHaveLength(1);

    await click(button(row(container, 'verifiable-memory'), 'Off'));
    expect(row(container, 'working-memory').querySelector('[role="alert"]')).toBeNull();
  });

  it('shows a change\'s answer or refusal only on the context graph it was for', async () => {
    const other = '0x2222222222222222222222222222222222222222/other';
    const allOff = { 'working-memory': 'off', 'shared-working-memory': 'off', 'verifiable-memory': 'off' };
    const show = async (contextGraphId: string) => {
      await act(async () => { root!.render(React.createElement(ReadGraphsSection, { contextGraphId })); });
      await flush();
    };
    let settle!: (outcome: [number, unknown]) => void;
    putAnswer = () => new Promise(resolve => { settle = resolve; });
    getAnswers = [[200, settings()]];
    const container = await render();

    await click(button(row(container, 'working-memory'), 'Build'));
    getAnswers = [[200, settings({ rows: {}, effective: allOff, readGraphs: [] }, other)]];
    await show(other);
    expect(button(row(container, 'shared-working-memory'), 'Build').disabled).toBe(false);
    expect(pressed(row(container, 'shared-working-memory'))).toEqual(['Off']);

    await act(async () => { settle([200, settings({ rows: { 'working-memory': 'build', 'verifiable-memory': 'serve' } })]); });
    await flush();
    expect(pressed(row(container, 'working-memory'))).toEqual(['Off']);
    expect(gets().map(request => request.url).at(-1)).toBe(`${SETTINGS}?contextGraphId=${encodeURIComponent(other)}`);

    await click(button(row(container, 'shared-working-memory'), 'Build'));
    getAnswers = [[200, settings()]];
    await show(CG);
    await act(async () => { settle([409, { code: 'READ_GRAPHS_APPLY_REFUSED', error: 'The node could not apply the change.' }]); });
    await flush();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(pressed(row(container, 'shared-working-memory'))).toEqual(['Build']);

    getAnswers = [[200, settings({ rows: {}, effective: allOff, readGraphs: [] }, other)]];
    await show(other);
    expect(row(container, 'shared-working-memory').querySelector('[role="alert"]')?.textContent).toBe('The node could not apply the change.');
  });

  it('keeps Off available when the node\'s config switches read graphs off', async () => {
    getAnswers = [[200, settings({ policy: { enabled: false } })]];
    const container = await render();

    expect(container.querySelector('[role="note"]')?.textContent).toBe('The node\'s config switches read graphs off for every context graph.');
    const vm = row(container, 'verifiable-memory');
    expect(button(vm, 'Off').disabled).toBe(false);
    expect(button(vm, 'Build').disabled).toBe(true);
    expect(button(vm, 'Serve').disabled).toBe(true);
    expect(button(vm, 'Serve').title).toBe('The node\'s config switches read graphs off for every context graph.');
  });

  it('shows why the node can\'t switch layers on, and which layers its config leaves out', async () => {
    const refused = { code: 'READ_GRAPHS_CHECKPOINT_NODE', error: 'This node starts from a public checkpoint, so it keeps no read graphs.' };
    getAnswers = [[200, settings({ refused })]];
    const container = await render();
    expect(container.querySelector('[role="note"]')?.textContent).toBe(refused.error);
    expect(button(row(container, 'shared-working-memory'), 'Serve').disabled).toBe(true);
    expect(button(row(container, 'shared-working-memory'), 'Off').disabled).toBe(false);
    await act(async () => { root!.unmount(); });

    getAnswers = [[200, settings({ policy: { enabled: true, layers: ['verifiable-memory'] } })]];
    const second = await render();
    expect(second.querySelector('[role="note"]')).toBeNull();
    const wm = row(second, 'working-memory');
    expect(wm.textContent).toContain('not allowed on this node');
    expect(button(wm, 'Build').disabled).toBe(true);
    expect(button(wm, 'Build').title).toBe('The node\'s config doesn\'t allow read graphs on this layer.');
    expect(button(row(second, 'verifiable-memory'), 'Build').disabled).toBe(false);
  });

  it('says when the settings can\'t be read, and reads them again on Retry', async () => {
    getAnswers = [
      [503, { code: 'READ_GRAPH_SETTINGS_UNAVAILABLE', error: 'The read-graph settings file cannot be opened.' }],
      [200, settings()],
    ];
    const container = await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Read-graph settings are unavailable: The read-graph settings file cannot be opened.');

    await click(button(container, 'Retry'));
    expect(gets()).toHaveLength(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(pressed(row(container, 'verifiable-memory'))).toEqual(['Serve']);
  });

  it('reads the settings again while a read graph is being built, and stops once every layer has settled', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    getAnswers = [
      [200, settings()],
      [200, settings({
        effective: { 'working-memory': 'off', 'shared-working-memory': 'build', 'verifiable-memory': 'serve' },
        readGraphs: [
          { readGraph: 'urn:rg:swm', layer: 'swm', state: 'ready', generation: 1 },
          { readGraph: 'urn:rg:vm', layer: 'vm', state: 'ready', generation: 2 },
        ],
      })],
    ];
    const container = await render();
    expect(gets()).toHaveLength(1);

    await act(async () => { vi.advanceTimersByTime(READ_GRAPHS_POLL_MS); });
    await flush();
    expect(gets()).toHaveLength(2);
    expect(row(container, 'shared-working-memory').querySelector('[data-testid="read-graph-state"]')?.textContent).toBe('Ready');

    await act(async () => { vi.advanceTimersByTime(3 * READ_GRAPHS_POLL_MS); });
    await flush();
    expect(gets()).toHaveLength(2);
  });
});

describe('readGraphStateText', () => {
  it('names one read graph by its state, counts several, and says what is about to happen', () => {
    const layer = (mode: 'off' | 'build' | 'serve' | undefined, states: Record<string, number>) => ({ view: 'working-memory' as const, mode, setHere: false, allowed: true, states });
    expect(readGraphStateText(layer('serve', { building: 1 }))).toBe('Building');
    expect(readGraphStateText(layer('build', { ready: 2, dirty: 1 }))).toBe('2 ready, 1 dirty');
    expect(readGraphStateText(layer('off', { ready: 2 }))).toBe('2 ready, being removed');
    expect(readGraphStateText(layer(undefined, {}))).toBe('No read graph');
    expect(readGraphStateText(layer('serve', { ready: 0 }))).toBe('Waiting to be built');
  });
});
