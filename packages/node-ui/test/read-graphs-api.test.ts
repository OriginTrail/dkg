import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../src/ui/http.js';
import {
  READ_GRAPH_SETTINGS_PATH,
  RESULT_CHANGES_PATH,
  decodeReadGraphSettings,
  decodeResultChanges,
  fetchReadGraphSettings,
  fetchResultChanges,
  setReadGraphMode,
} from '../src/ui/read-graphs-api.js';

const CG = '0x1111111111111111111111111111111111111111/read-graphs';

function response(status: number, json: unknown) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => json };
}

function stubFetch(status: number, json: unknown) {
  const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) => response(status, json));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('decodeReadGraphSettings', () => {
  it('gives each layer its mode in force, whether it is set here, whether it is allowed, its states and how far its build has got', () => {
    const settings = decodeReadGraphSettings({
      policy: { enabled: true, layers: ['shared-working-memory', 'verifiable-memory'] },
      contextGraphs: [
        { contextGraphId: 'another', layers: { 'working-memory': 'serve' } },
        {
          contextGraphId: CG,
          layers: { 'verifiable-memory': 'serve' },
          effective: { layers: { 'working-memory': 'off', 'shared-working-memory': 'build', 'verifiable-memory': 'serve' } },
          readGraphs: [
            { readGraph: 'urn:rg:vm', layer: 'vm', state: 'ready', generation: 3 },
            { readGraph: 'urn:rg:swm', layer: 'swm', state: 'building', generation: 1, progress: 0.4 },
            { readGraph: 'urn:rg:swm-notes', layer: 'shared-working-memory', state: 'building', generation: 1 },
          ],
        },
      ],
    }, CG);

    expect(settings).toEqual({
      contextGraphId: CG,
      enabled: true,
      layers: [
        { view: 'verifiable-memory', mode: 'serve', setHere: true, allowed: true, states: { ready: 1 } },
        { view: 'shared-working-memory', mode: 'build', setHere: false, allowed: true, states: { building: 2 }, progress: 0.2 },
        { view: 'working-memory', mode: 'off', setHere: false, allowed: false, states: {} },
      ],
    });
  });

  it('sums the triples of a layer\'s read graphs only when the node gives them for each', () => {
    const settings = decodeReadGraphSettings({
      contextGraphs: [{
        contextGraphId: CG,
        effective: { layers: { 'verifiable-memory': 'serve', 'shared-working-memory': 'serve', 'working-memory': 'serve' } },
        readGraphs: [
          { layer: 'vm', state: 'ready', triples: 1000 },
          { layer: 'vm', state: 'ready', triples: 204.9 },
          { layer: 'swm', state: 'ready', triples: 5 },
          { layer: 'swm', state: 'ready' },
          { layer: 'wm', state: 'ready', triples: -1 },
        ],
      }],
    }, CG);
    expect(settings.layers.map(layer => layer.triples)).toEqual([1204, undefined, undefined]);
  });

  it('sums the asset counts of a layer\'s read graphs on the same rule', () => {
    const settings = decodeReadGraphSettings({
      contextGraphs: [{
        contextGraphId: CG,
        effective: { layers: { 'verifiable-memory': 'serve', 'shared-working-memory': 'serve', 'working-memory': 'serve' } },
        readGraphs: [
          { layer: 'vm', state: 'ready', members: 12000, triples: 9 },
          { layer: 'vm', state: 'building', members: 400.5 },
          { layer: 'swm', state: 'ready', members: 'many' },
          { layer: 'wm', state: 'ready', members: 3 },
        ],
      }],
    }, CG);
    expect(settings.layers.map(layer => layer.members)).toEqual([12400, undefined, 3]);
    expect(settings.layers.map(layer => layer.triples)).toEqual([undefined, undefined, undefined]);
  });

  it('keeps the node-wide refusal and the kill switch', () => {
    const settings = decodeReadGraphSettings({
      policy: { enabled: false },
      refused: { code: 'READ_GRAPHS_UNSUPPORTED', error: 'This store cannot keep read graphs.' },
      contextGraphs: [{ contextGraphId: CG, layers: {}, effective: { layers: {} }, readGraphs: [] }],
    }, CG);

    expect(settings.enabled).toBe(false);
    expect(settings.refused).toEqual({ code: 'READ_GRAPHS_UNSUPPORTED', error: 'This store cannot keep read graphs.' });
    expect(settings.layers.every(layer => layer.allowed)).toBe(true);
  });

  it('reads the rows alone without effective modes, and ignores what it does not know', () => {
    const settings = decodeReadGraphSettings({
      refused: { error: 42 },
      contextGraphs: [{
        contextGraphId: CG,
        layers: { 'working-memory': 'build', 'shared-working-memory': 'sometimes', 'long-term-memory': 'serve' },
        readGraphs: [
          { layer: 'wm', state: 'dirty' },
          { layer: 'ltm', state: 'ready' },
          { layer: 'vm', state: '' },
          { layer: 'vm' },
          { layer: 'vm', state: 'building', progress: -1 },
          { layer: 'swm', state: 'building', progress: 7 },
          'not a read graph',
        ],
        extra: true,
      }],
    }, CG);

    expect(settings.refused).toBeUndefined();
    expect(settings.enabled).toBe(true);
    expect(settings.layers).toEqual([
      { view: 'verifiable-memory', setHere: false, allowed: true, states: { building: 1 } },
      { view: 'shared-working-memory', setHere: false, allowed: true, states: { building: 1 }, progress: 1 },
      { view: 'working-memory', mode: 'build', setHere: true, allowed: true, states: { dirty: 1 } },
    ]);
  });

  it('shows every mode as unknown for an answer without this context graph, or no object at all', () => {
    for (const body of [{ contextGraphs: [{ contextGraphId: 'another', layers: { 'working-memory': 'serve' } }] }, null, 'text', []]) {
      const settings = decodeReadGraphSettings(body, CG);
      expect(settings.layers.map(layer => layer.mode)).toEqual([undefined, undefined, undefined]);
      expect(settings.layers.every(layer => !layer.setHere && layer.allowed)).toBe(true);
    }
  });
});

describe('decodeResultChanges', () => {
  it('counts the compared queries and those whose results would differ', () => {
    const changes = decodeResultChanges({
      contextGraphs: [
        { contextGraphId: 'another', since: '2026-11-01T00:00:00.000Z', kinds: { none: 9 } },
        {
          contextGraphId: CG,
          since: '2026-11-12T06:00:00.000Z',
          samples: 50,
          skipped: 6,
          uncomparable: 4,
          kinds: { 'none': 30, 'copies-removed': 5, 'rows-added': 2, 'rows-removed-or-changed': 3 },
          shapes: [],
        },
      ],
    }, CG);
    expect(changes).toEqual({ compared: 40, different: 5, since: '2026-11-12T06:00:00.000Z' });
  });

  it('counts nothing for a context graph the report doesn\'t hold, and ignores counts it can\'t use', () => {
    expect(decodeResultChanges({ contextGraphs: [] }, CG)).toEqual({ compared: 0, different: 0 });
    expect(decodeResultChanges(null, CG)).toEqual({ compared: 0, different: 0 });
    expect(decodeResultChanges({
      contextGraphs: [{ contextGraphId: CG, since: '2026-11-12T06:00:00.000Z', kinds: { 'none': -3, 'rows-added': 2.7, 'rows-removed-or-changed': '4' } }],
    }, CG)).toEqual({ compared: 2, different: 2, since: '2026-11-12T06:00:00.000Z' });
    expect(decodeResultChanges({ contextGraphs: [{ contextGraphId: CG, since: '2026-11-12T06:00:00.000Z', kinds: {} }] }, CG))
      .toEqual({ compared: 0, different: 0 });
  });
});

describe('fetchReadGraphSettings', () => {
  it('asks for one context graph and decodes its settings', async () => {
    const fetchMock = stubFetch(200, {
      policy: { enabled: true },
      contextGraphs: [{ contextGraphId: CG, layers: {}, effective: { layers: { 'verifiable-memory': 'build' } }, readGraphs: [] }],
    });

    const load = await fetchReadGraphSettings(CG);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`${READ_GRAPH_SETTINGS_PATH}?contextGraphId=${encodeURIComponent(CG)}`);
    expect(load.kind).toBe('settings');
    expect(load.kind === 'settings' && load.settings.layers[0]).toMatchObject({ view: 'verifiable-memory', mode: 'build' });
  });

  it.each([
    [403, { error: 'GET /api/store/read-graphs/settings requires a node-level admin token.' }],
    [404, { error: 'Not found' }],
  ])('hides the settings on %i', async (status, body) => {
    stubFetch(status, body);
    await expect(fetchReadGraphSettings(CG)).resolves.toEqual({ kind: 'hidden' });
  });

  it('throws any other failure with the node\'s sentence', async () => {
    stubFetch(503, { code: 'READ_GRAPH_SETTINGS_UNAVAILABLE', error: 'The read-graph settings file cannot be opened.' });
    const failure = fetchReadGraphSettings(CG);
    await expect(failure).rejects.toBeInstanceOf(HttpError);
    await expect(failure).rejects.toMatchObject({ status: 503, message: 'The read-graph settings file cannot be opened.' });
  });
});

describe('setReadGraphMode', () => {
  it('puts one layer\'s mode and decodes the settings after the change', async () => {
    const fetchMock = stubFetch(200, {
      policy: { enabled: true },
      contextGraphs: [{ contextGraphId: CG, layers: { 'shared-working-memory': 'serve' }, effective: { layers: { 'shared-working-memory': 'serve' } }, readGraphs: [] }],
      changes: [{ contextGraphId: CG, layer: 'shared-working-memory', from: 'off', to: 'serve', outcome: 'applied' }],
    });

    const settings = await setReadGraphMode(CG, 'shared-working-memory', 'serve');

    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe(READ_GRAPH_SETTINGS_PATH);
    expect(init?.method).toBe('PUT');
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
    expect(new Headers(init?.headers).get('X-DKG-Actor')).toBe('ui');
    expect(JSON.parse(String(init?.body))).toEqual({ contextGraphId: CG, layers: { 'shared-working-memory': 'serve' } });
    expect(settings.layers[1]).toMatchObject({ view: 'shared-working-memory', mode: 'serve', setHere: true });
  });

  it('throws the node\'s refusal with its code', async () => {
    const refusal = {
      code: 'READ_GRAPHS_ROLLBACK_TARGET_OLDER',
      error: 'The rollback target of this node is older than the first release that recognizes read graphs.',
      rollbackTarget: { source: 'config', version: '10.1.1' },
      firstRecognizingRelease: '10.1.2',
    };
    stubFetch(409, refusal);

    const failure = setReadGraphMode(CG, 'verifiable-memory', 'build');
    await expect(failure).rejects.toBeInstanceOf(HttpError);
    await expect(failure).rejects.toMatchObject({ status: 409, message: refusal.error, body: refusal });
  });
});

describe('fetchResultChanges', () => {
  it('asks for one context graph\'s comparison and decodes it', async () => {
    const fetchMock = stubFetch(200, {
      contextGraphs: [{ contextGraphId: CG, since: '2026-11-12T06:00:00.000Z', kinds: { 'none': 3, 'rows-added': 1 } }],
    });
    await expect(fetchResultChanges(CG)).resolves.toEqual({ compared: 4, different: 1, since: '2026-11-12T06:00:00.000Z' });
    expect(fetchMock.mock.calls[0][0]).toBe(`${RESULT_CHANGES_PATH}?contextGraphId=${encodeURIComponent(CG)}`);
  });

  it('throws a refusal with the node\'s sentence', async () => {
    stubFetch(403, { error: 'GET /api/query/view-semantics-delta requires a node-level admin token.' });
    await expect(fetchResultChanges(CG)).rejects.toMatchObject({ status: 403, message: 'GET /api/query/view-semantics-delta requires a node-level admin token.' });
  });
});
