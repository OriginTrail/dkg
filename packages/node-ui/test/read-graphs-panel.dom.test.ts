// @vitest-environment happy-dom

// The "Search across assets" section of a context graph's overview, against
// a stubbed node: what the node admin sees per memory, the Off/Preview/On
// switch, the comparison of results, and that anyone else sees nothing.

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { formatDateTime, formatNumber } from '../src/ui/lib/format.js';
import { READ_GRAPHS_POLL_MS, ReadGraphsSection, searchAssetsText, searchSizeText, searchState } from '../src/ui/views/project/components/read-graphs.js';

const CG = '0x1111111111111111111111111111111111111111/read-graphs';
const SETTINGS = '/api/store/read-graphs/settings';
const CHANGES = '/api/query/view-semantics-delta';

type Json = Record<string, unknown>;
interface Request { method: string; url: string; body?: Json }

let requests: Request[] = [];
let getAnswers: Array<[number, unknown]> = [];
let changesAnswer: [number, unknown] = [200, { contextGraphs: [] }];
/** When set, the next settings read waits for it: a slow node. */
let slowGet: Promise<[number, unknown]> | undefined;
let putAnswer: (body: Json) => Promise<[number, unknown]>;
let root: Root | null = null;

function answer(status: number, json: unknown) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => json };
}

/** A settings answer with the node's defaults: published assets On and ready, shared memory in Preview from config, drafts Off. */
function settings(overrides: { rows?: Json; effective?: Json; readGraphs?: Json[]; policy?: Json; refused?: Json } = {}, contextGraphId = CG): Json {
  return {
    policy: overrides.policy ?? { enabled: true, layers: ['working-memory', 'shared-working-memory', 'verifiable-memory'] },
    ...(overrides.refused ? { refused: overrides.refused } : {}),
    contextGraphs: [{
      contextGraphId,
      layers: overrides.rows ?? { 'verifiable-memory': 'serve' },
      effective: { layers: overrides.effective ?? { 'working-memory': 'off', 'shared-working-memory': 'build', 'verifiable-memory': 'serve' }, viewSemantics: 'per-asset' },
      readGraphs: overrides.readGraphs ?? [{ readGraph: 'urn:rg:vm', contextGraphId, layer: 'vm', state: 'ready', generation: 2 }],
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
  const found = Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).find(candidate => candidate.textContent?.trim() === name);
  if (!found) throw new Error(`no button ${name}`);
  return found;
}

function pressed(scope: HTMLElement): string[] {
  return Array.from(scope.querySelectorAll('button[aria-pressed="true"]')).map(node => node.textContent ?? '');
}

function state(scope: HTMLElement): string | null | undefined {
  return scope.querySelector('[data-testid="search-state"]')?.textContent;
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => { target.click(); });
  await flush();
}

const gets = () => requests.filter(request => request.method === 'GET' && request.url.startsWith(SETTINGS));
const puts = () => requests.filter(request => request.method === 'PUT');

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  requests = [];
  getAnswers = [];
  changesAnswer = [200, { contextGraphs: [] }];
  slowGet = undefined;
  putAnswer = async () => [500, { error: 'unexpected PUT' }];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const url = String(input);
    requests.push({ method, url, ...(typeof init.body === 'string' ? { body: JSON.parse(init.body) } : {}) });
    if (method === 'PUT') return answer(...await putAnswer(JSON.parse(String(init.body))));
    if (url.startsWith(CHANGES)) return answer(...changesAnswer);
    if (slowGet) {
      const pending = slowGet;
      slowGet = undefined;
      return answer(...await pending);
    }
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

  it('shows each memory\'s state, where its mode comes from, and the Off, Preview and On switch', async () => {
    getAnswers = [[200, settings()]];
    const container = await render();

    expect(gets()[0].url).toBe(`${SETTINGS}?contextGraphId=${encodeURIComponent(CG)}`);
    const section = container.querySelector<HTMLElement>('[data-section="read-graphs"]')!;
    expect(section.querySelector('.v10-po-section-title')?.textContent).toBe('Search across assets');
    expect(section.textContent).toContain('Preview: Prepares the combined copy and shows how results would change, without changing any results yet.');
    expect(section.textContent).toContain('On: Lets queries that ask for it search across assets.');
    expect(section.textContent).not.toMatch(/read graph/i);
    const vm = row(container, 'verifiable-memory');
    const swm = row(container, 'shared-working-memory');
    const wm = row(container, 'working-memory');
    expect([vm, swm, wm].map(layer => layer.querySelector('.v10-po-join-name')?.textContent)).toEqual(['Published assets', 'Shared memory', 'Private drafts']);
    expect([vm, swm, wm].map(state)).toEqual(['In use', 'Getting ready', 'Off']);
    expect([vm, swm, wm].map(pressed)).toEqual([['On'], ['Preview'], ['Off']]);
    expect(vm.querySelector('.v10-po-rg-source')?.textContent).toBe('Set for this context graph');
    expect(swm.querySelector('.v10-po-rg-source')?.textContent).toBe('Node default');
    expect(swm.querySelector('.v10-po-rg-detail')?.textContent).toBe('Shared with your team.');
    expect(button(swm, 'Preview').title).toBe('Prepares the combined copy and shows how results would change, without changing any results yet.');
    expect(button(swm, 'On').title).toBe('Lets queries that ask for it search across assets.');
    expect(container.querySelectorAll('button:disabled')).toHaveLength(0);
  });

  it('says how far a memory has got while it is getting ready, and what a combined copy held at its last build', async () => {
    getAnswers = [[200, settings({ readGraphs: [
      { readGraph: 'urn:rg:vm', layer: 'vm', state: 'ready', generation: 2, triples: 1204, members: 12400 },
      { readGraph: 'urn:rg:swm', layer: 'swm', state: 'building', generation: 1, progress: 0.426 },
    ] })]];
    const container = await render();
    expect(state(row(container, 'shared-working-memory'))).toBe('Getting ready 42%');
    expect(row(container, 'shared-working-memory').querySelector('[data-testid="search-size"]')).toBeNull();
    expect(row(container, 'shared-working-memory').querySelector('[data-testid="search-assets"]')).toBeNull();
    const vm = row(container, 'verifiable-memory');
    expect(vm.querySelector('[data-testid="search-size"]')?.textContent).toBe(`About ${formatNumber(1204)} facts, at its last build`);
    expect(vm.querySelector('[data-testid="search-assets"]')?.textContent).toBe(`${formatNumber(12400)} assets`);
    expect(vm.querySelector('.v10-po-join-name')?.textContent).toBe('Published assets');
  });

  it('switches a memory, shows the node\'s answer, and reads the settings again', async () => {
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
            { readGraph: 'urn:rg:swm', layer: 'swm', state: 'building', generation: 1, progress: 0 },
            { readGraph: 'urn:rg:vm', layer: 'vm', state: 'ready', generation: 2 },
          ],
        }),
        changes: [{ contextGraphId: CG, layer: 'shared-working-memory', from: 'build', to: 'serve', outcome: 'applied' }],
      }];
    };
    const container = await render();

    await click(button(row(container, 'shared-working-memory'), 'On'));
    expect(puts().map(request => request.body)).toEqual([{ contextGraphId: CG, layers: { 'shared-working-memory': 'serve' } }]);
    expect(row(container, 'shared-working-memory').querySelector('[role="status"]')?.textContent).toBe('Applying…');
    const modes = Array.from(container.querySelectorAll<HTMLButtonElement>('.v10-po-rg-modes button'));
    expect(modes).toHaveLength(9);
    expect(modes.every(node => node.disabled)).toBe(true);

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
    expect(pressed(swm)).toEqual(['On']);
    expect(swm.textContent).toContain('Set for this context graph');
    expect(swm.querySelector('[role="status"]')).toBeNull();
    expect(gets()).toHaveLength(2);
    expect(state(swm)).toBe('In use');
  });

  it('asks before turning a memory off, and can be cancelled', async () => {
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
    expect(confirm?.getAttribute('aria-label')).toBe('Turn off Published assets');
    expect(confirm?.textContent).toContain('Turning this off removes the combined copy. Getting it ready again takes time.');
    expect(puts()).toHaveLength(0);

    await click(button(confirm!, 'Cancel'));
    expect(row(container, 'verifiable-memory').querySelector('.v10-po-rg-confirm')).toBeNull();
    expect(puts()).toHaveLength(0);

    await click(button(row(container, 'verifiable-memory'), 'Off'));
    await click(button(row(container, 'verifiable-memory'), 'Turn off'));
    expect(puts().map(request => request.body)).toEqual([{ contextGraphId: CG, layers: { 'verifiable-memory': 'off' } }]);
    const vm = row(container, 'verifiable-memory');
    expect(pressed(vm)).toEqual(['Off']);
    expect(state(vm)).toBe('Off');
  });

  it('switches a memory that is off on without asking, and a click on its own mode does nothing', async () => {
    getAnswers = [[200, settings()]];
    putAnswer = async body => [200, settings({ rows: { ...(body.layers as Json), 'verifiable-memory': 'serve' } })];
    const container = await render();

    await click(button(row(container, 'verifiable-memory'), 'On'));
    expect(puts()).toHaveLength(0);

    await click(button(row(container, 'working-memory'), 'Preview'));
    expect(row(container, 'working-memory').querySelector('.v10-po-rg-confirm')).toBeNull();
    expect(puts().map(request => request.body)).toEqual([{ contextGraphId: CG, layers: { 'working-memory': 'build' } }]);
  });

  it('shows the node\'s refusal on the memory and keeps its mode', async () => {
    getAnswers = [[200, settings()]];
    const sentence = 'This node\'s rollback target is 10.1.0, and this needs 10.1.1 or later there first.';
    putAnswer = async () => [409, {
      code: 'READ_GRAPHS_ROLLBACK_TARGET_OLDER',
      error: sentence,
      rollbackTarget: { source: 'config', version: '10.1.0' },
      firstRecognizingRelease: '10.1.1',
    }];
    const container = await render();

    await click(button(row(container, 'working-memory'), 'Preview'));
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

    await click(button(row(container, 'working-memory'), 'Preview'));
    getAnswers = [[200, settings({ rows: {}, effective: allOff, readGraphs: [] }, other)]];
    await show(other);
    expect(button(row(container, 'shared-working-memory'), 'Preview').disabled).toBe(false);
    expect(pressed(row(container, 'shared-working-memory'))).toEqual(['Off']);

    await act(async () => { settle([200, settings({ rows: { 'working-memory': 'build', 'verifiable-memory': 'serve' } })]); });
    await flush();
    expect(pressed(row(container, 'working-memory'))).toEqual(['Off']);
    expect(gets().map(request => request.url).at(-1)).toBe(`${SETTINGS}?contextGraphId=${encodeURIComponent(other)}`);

    await click(button(row(container, 'shared-working-memory'), 'Preview'));
    getAnswers = [[200, settings()]];
    await show(CG);
    await act(async () => { settle([409, { code: 'READ_GRAPHS_APPLY_REFUSED', error: 'The node could not apply the change.' }]); });
    await flush();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(pressed(row(container, 'shared-working-memory'))).toEqual(['Preview']);

    getAnswers = [[200, settings({ rows: {}, effective: allOff, readGraphs: [] }, other)]];
    await show(other);
    expect(row(container, 'shared-working-memory').querySelector('[role="alert"]')?.textContent).toBe('The node could not apply the change.');
  });

  it('keeps Off available when the node\'s config switches search across assets off', async () => {
    getAnswers = [[200, settings({ policy: { enabled: false } })]];
    const container = await render();

    const switchedOff = 'This node\'s config switches search across assets off for every context graph.';
    expect(container.querySelector('[role="note"]')?.textContent).toBe(switchedOff);
    const vm = row(container, 'verifiable-memory');
    expect(button(vm, 'Off').disabled).toBe(false);
    expect(button(vm, 'Preview').disabled).toBe(true);
    expect(button(vm, 'On').disabled).toBe(true);
    expect(button(vm, 'On').title).toBe(switchedOff);
  });

  it('shows why the node can\'t switch memories on, and which memories its config leaves out', async () => {
    const refused = { code: 'READ_GRAPHS_CHECKPOINT_NODE', error: 'This node starts from a public checkpoint, so it can\'t keep a combined copy.' };
    getAnswers = [[200, settings({ refused })]];
    const container = await render();
    expect(container.querySelector('[role="note"]')?.textContent).toBe(refused.error);
    expect(button(row(container, 'shared-working-memory'), 'On').disabled).toBe(true);
    expect(button(row(container, 'shared-working-memory'), 'Off').disabled).toBe(false);
    await act(async () => { root!.unmount(); });

    getAnswers = [[200, settings({ policy: { enabled: true, layers: ['verifiable-memory'] } })]];
    const second = await render();
    expect(second.querySelector('[role="note"]')).toBeNull();
    const wm = row(second, 'working-memory');
    expect(wm.querySelector('.v10-po-rg-source')?.textContent).toBe('Node default');
    expect(wm.querySelector('[data-testid="search-not-allowed"]')?.textContent).toBe('Not allowed on this node');
    expect(button(wm, 'Preview').disabled).toBe(true);
    expect(button(wm, 'Preview').title).toBe('This node\'s config doesn\'t allow it for this memory.');
    expect(button(row(second, 'verifiable-memory'), 'Preview').disabled).toBe(false);
  });

  it('says when the settings can\'t be read, and reads them again on Retry', async () => {
    getAnswers = [
      [503, { code: 'READ_GRAPH_SETTINGS_UNAVAILABLE', error: 'The read-graph settings file cannot be opened.' }],
      [200, settings()],
    ];
    const container = await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Search across assets settings are unavailable: The read-graph settings file cannot be opened.');

    await click(button(container, 'Retry'));
    expect(gets()).toHaveLength(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(pressed(row(container, 'verifiable-memory'))).toEqual(['On']);
  });

  it('shows how results would change, from the node\'s comparison of sampled queries', async () => {
    getAnswers = [[200, settings()]];
    const since = '2026-11-12T06:00:00.000Z';
    changesAnswer = [200, { contextGraphs: [{ contextGraphId: CG, since, kinds: { 'none': 1235, 'rows-added': 3, 'rows-removed-or-changed': 2 } }] }];
    const container = await render();
    const link = button(container, 'How results would change');
    expect(link.getAttribute('aria-expanded')).toBe('false');
    expect(requests.some(request => request.url.startsWith(CHANGES))).toBe(false);

    await click(link);
    expect(link.getAttribute('aria-expanded')).toBe('true');
    expect(requests.filter(request => request.url.startsWith(CHANGES)).map(request => request.url))
      .toEqual([`${CHANGES}?contextGraphId=${encodeURIComponent(CG)}`]);
    // Dates and counts read the way they do on every other screen.
    expect(container.querySelector('.v10-po-rg-changes')?.textContent)
      .toBe(`Since ${formatDateTime(since)}: 5 of ${formatNumber(1240)} compared queries would give different results.`);

    await click(link);
    expect(container.querySelector('.v10-po-rg-changes')).toBeNull();
  });

  it('says when no query was compared yet, and when the comparison isn\'t available', async () => {
    getAnswers = [[200, settings()]];
    const container = await render();
    await click(button(container, 'How results would change'));
    expect(container.querySelector('.v10-po-rg-changes')?.textContent)
      .toBe('No queries compared yet. The node compares some of the queries people run on this context graph.');
    await click(button(container, 'How results would change'));

    changesAnswer = [200, { contextGraphs: [{ contextGraphId: CG, since: 'not a date', kinds: { 'rows-added': 1 } }] }];
    await click(button(container, 'How results would change'));
    expect(container.querySelector('.v10-po-rg-changes')?.textContent).toBe('1 of 1 compared query would give different results.');
    await click(button(container, 'How results would change'));

    changesAnswer = [200, { contextGraphs: [{ contextGraphId: CG, kinds: { 'none': 2, 'copies-removed': 3, 'rows-added': 1 } }] }];
    await click(button(container, 'How results would change'));
    expect(container.querySelector('.v10-po-rg-changes')?.textContent)
      .toBe('1 of 6 compared queries would give different results, and 3 would only drop repeated rows.');
    await click(button(container, 'How results would change'));

    changesAnswer = [404, { error: 'Not found' }];
    await click(button(container, 'How results would change'));
    expect(container.querySelector('.v10-po-rg-changes')?.textContent).toBe('The comparison isn\'t available: Not found');
  });

  it('reads the settings again while a memory is getting ready, and stops once every memory has settled', async () => {
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
    expect(state(row(container, 'shared-working-memory'))).toBe('Ready to turn on');

    await act(async () => { vi.advanceTimersByTime(3 * READ_GRAPHS_POLL_MS); });
    await flush();
    expect(gets()).toHaveLength(2);
  });

  it('waits for a slow read before polling again, and shows its answer', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    getAnswers = [[200, settings()]];
    const container = await render();
    expect(gets()).toHaveLength(1);

    let answerSlowly!: (outcome: [number, unknown]) => void;
    slowGet = new Promise(resolve => { answerSlowly = resolve; });
    await act(async () => { vi.advanceTimersByTime(READ_GRAPHS_POLL_MS); });
    await flush();
    expect(gets()).toHaveLength(2);

    // Three more polls fall due while that read is still answering: none starts another read.
    await act(async () => { vi.advanceTimersByTime(3 * READ_GRAPHS_POLL_MS); });
    await flush();
    expect(gets()).toHaveLength(2);

    await act(async () => {
      answerSlowly([200, settings({ readGraphs: [
        { readGraph: 'urn:rg:swm', layer: 'swm', state: 'ready', generation: 1 },
        { readGraph: 'urn:rg:vm', layer: 'vm', state: 'ready', generation: 2 },
      ] })]);
    });
    await flush();
    expect(state(row(container, 'shared-working-memory'))).toBe('Ready to turn on');
  });
});

describe('searchState', () => {
  const layer = (mode: 'off' | 'build' | 'serve' | undefined, states: Record<string, number>, progress?: number) =>
    ({ view: 'verifiable-memory' as const, mode, setHere: false, allowed: true, states, ...(progress === undefined ? {} : { progress }) });

  it('says a memory is getting ready while it is built, with how far when the node says', () => {
    expect(searchState(layer('serve', { building: 1 })).text).toBe('Getting ready');
    expect(searchState(layer('build', { building: 1, ready: 1 }, 0.426)).text).toBe('Getting ready 42%');
    expect(searchState(layer('build', { building: 1 }, 1)).text).toBe('Getting ready 99%');
    expect(searchState(layer('serve', {})).text).toBe('Getting ready');
  });

  it('says a memory is rebuilding, being checked, in use or ready to turn on', () => {
    expect(searchState(layer('serve', { ready: 1, rebuilding: 1 })).text).toBe('Rebuilding');
    expect(searchState(layer('build', { repairing: 1 })).text).toBe('Rebuilding');
    expect(searchState(layer('serve', { dirty: 1, ready: 2 })).text).toBe('Checking');
    expect(searchState(layer('serve', { surprising: 1 })).text).toBe('Checking');
    expect(searchState(layer('serve', { ready: 2 })).text).toBe('In use');
    expect(searchState(layer('build', { ready: 1 })).text).toBe('Ready to turn on');
  });

  it('draws ready states as success, work under way as pending, and the rest as a muted tag', () => {
    expect(searchState(layer('serve', { ready: 1 })).tone).toBe('success');
    expect(searchState(layer('build', { ready: 1 })).tone).toBe('success');
    expect(searchState(layer('serve', { building: 1 })).tone).toBe('pending');
    expect(searchState(layer('serve', { dirty: 1, ready: 1 })).tone).toBe('pending');
    expect(searchState(layer('build', { rebuilding: 1 })).tone).toBe('pending');
    expect(searchState(layer('off', {})).tone).toBe('muted');
    expect(searchState(layer(undefined, {})).tone).toBe('muted');
  });

  it('says Off for a memory that is off, and when the node didn\'t say', () => {
    expect(searchState(layer('off', { ready: 1 })).text).toBe('Off');
    expect(searchState(layer(undefined, {})).text).toBe('Not known');
  });
});

describe('searchSizeText and searchAssetsText', () => {
  const layer = (mode: 'off' | 'build' | 'serve', count?: number) => ({
    view: 'verifiable-memory' as const, mode, setHere: false, allowed: true, states: { ready: 1 },
    ...(count === undefined ? {} : { triples: count, members: count }),
  });

  it('counts facts in a memory that is on or in preview, once the node gives the count', () => {
    expect(searchSizeText(layer('serve', 1))).toBe('About 1 fact, at its last build');
    expect(searchSizeText(layer('build', 0))).toBe('About 0 facts, at its last build');
    expect(searchSizeText(layer('serve'))).toBeUndefined();
    expect(searchSizeText(layer('off', 40))).toBeUndefined();
  });

  it('counts assets in a memory that is on or in preview, once the node gives the count', () => {
    expect(searchAssetsText(layer('serve', 1))).toBe('1 asset');
    expect(searchAssetsText(layer('build', 12400))).toBe(`${formatNumber(12400)} assets`);
    expect(searchAssetsText(layer('serve'))).toBeUndefined();
    expect(searchAssetsText(layer('off', 40))).toBeUndefined();
  });
});
