import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../src/ui/http.js';
import {
  READ_GRAPH_SETTINGS_PATH,
  decodeReadGraphSettings,
  fetchReadGraphSettings,
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
  it('gives each layer its mode in force, whether it is set here, whether it is allowed, and its read graphs by state', () => {
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
            { readGraph: 'urn:rg:swm', layer: 'swm', state: 'building', generation: 1 },
            { readGraph: 'urn:rg:swm-2', layer: 'shared-working-memory', state: 'ready', generation: 1 },
          ],
        },
      ],
    }, CG);

    expect(settings).toEqual({
      contextGraphId: CG,
      enabled: true,
      layers: [
        { view: 'working-memory', mode: 'off', setHere: false, allowed: false, states: {} },
        { view: 'shared-working-memory', mode: 'build', setHere: false, allowed: true, states: { building: 1, ready: 1 } },
        { view: 'verifiable-memory', mode: 'serve', setHere: true, allowed: true, states: { ready: 1 } },
      ],
    });
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
          'not a read graph',
        ],
        extra: true,
      }],
    }, CG);

    expect(settings.refused).toBeUndefined();
    expect(settings.enabled).toBe(true);
    expect(settings.layers).toEqual([
      { view: 'working-memory', mode: 'build', setHere: true, allowed: true, states: { dirty: 1 } },
      { view: 'shared-working-memory', setHere: false, allowed: true, states: {} },
      { view: 'verifiable-memory', setHere: false, allowed: true, states: {} },
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
    expect(load.kind === 'settings' && load.settings.layers[2].mode).toBe('build');
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
