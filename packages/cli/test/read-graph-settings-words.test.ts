// Search across assets in the CLI's words: its option values, and the words it
// shows for the engine's values.
import { describe, expect, it } from 'vitest';
import type { ReadGraphModeChange } from '@origintrail-official/dkg-storage';
import type { ReadGraphContextGraphSettings, ReadGraphSettingsReadGraph } from '../src/read-graph-settings-wire.js';
import {
  MEMORIES,
  changeLine,
  changesToName,
  createReadGraphsLines,
  layerLine,
  parseCreateReadGraphsOptions,
  parseLayerOption,
  parseModeOption,
  parseQueryViewOptions,
  parseSemanticsArgument,
  policyLine,
  semanticsLine,
  sizeWords,
  stateWords,
} from '../src/read-graph-settings-words.js';

const VM = 'did:dkg:context-graph:research/_read/vm';
const readGraph = (state: string, extra: Partial<ReadGraphSettingsReadGraph> = {}): ReadGraphSettingsReadGraph =>
  ({ readGraph: VM, contextGraphId: 'research', layer: 'vm', state, generation: 1, ...extra });

describe('the options in the words users know', () => {
  it('takes preview and on for build and serve, and a memory, its short label, or all', () => {
    expect(parseModeOption(undefined)).toEqual({ mode: 'build' });
    expect(parseModeOption('preview')).toEqual({ mode: 'build' });
    expect(parseModeOption('on')).toEqual({ mode: 'serve' });
    expect(parseModeOption('serve')).toEqual({ mode: 'serve' });
    expect(parseModeOption('off')).toEqual({ error: '--mode must be preview or on (or build or serve).' });
    expect(parseLayerOption(undefined)).toEqual({ layers: ['verifiable-memory'] });
    expect(parseLayerOption('all')).toEqual({ layers: MEMORIES });
    expect(parseLayerOption('working-memory')).toEqual({ layers: ['working-memory'] });
    expect(parseLayerOption('swm')).toEqual({ layers: ['shared-working-memory'] });
    expect(parseLayerOption('toString')).toEqual({ error: '--layer must be one of verifiable-memory, shared-working-memory, working-memory, or all.' });
    expect(parseSemanticsArgument('merged')).toEqual({ viewSemantics: 'merged' });
    expect(parseSemanticsArgument('none')).toEqual({ viewSemantics: null });
    expect(parseSemanticsArgument('union')).toEqual({ error: 'The default must be merged, per-asset or none.' });
  });

  it('builds the creation\'s setting only when --read-graphs asks, and names the flag that is wrong', () => {
    expect(parseCreateReadGraphsOptions(undefined, undefined)).toEqual({});
    expect(parseCreateReadGraphsOptions(undefined, 'all')).toEqual({ error: '--read-graph-layer needs --read-graphs.' });
    expect(parseCreateReadGraphsOptions('on', undefined)).toEqual({ setting: { layers: { 'verifiable-memory': 'serve' } } });
    expect(parseCreateReadGraphsOptions('preview', 'all')).toEqual({ setting: { layers: {
      'verifiable-memory': 'build', 'shared-working-memory': 'build', 'working-memory': 'build',
    } } });
    expect(parseCreateReadGraphsOptions('soon', undefined)).toEqual({ error: '--read-graphs must be preview or on (or build or serve).' });
    expect(parseCreateReadGraphsOptions('on', 'drafts')).toHaveProperty('error', expect.stringMatching(/^--read-graph-layer must be/));
  });

  it('gives a query a view and semantics; semantics alone reads published assets', () => {
    expect(parseQueryViewOptions(undefined, undefined)).toEqual({});
    expect(parseQueryViewOptions(undefined, 'merged')).toEqual({ view: 'verifiable-memory', semantics: 'merged' });
    expect(parseQueryViewOptions('wm', 'per-asset')).toEqual({ view: 'working-memory', semantics: 'per-asset' });
    expect(parseQueryViewOptions('shared-working-memory', undefined)).toEqual({ view: 'shared-working-memory' });
    expect(parseQueryViewOptions('long-term-memory', undefined)).toHaveProperty('error', expect.stringMatching(/^--view must be/));
    expect(parseQueryViewOptions(undefined, 'union')).toEqual({ error: '--semantics must be merged or per-asset.' });
  });
});

describe('the words for a memory\'s state', () => {
  it('says Off, Getting ready with how far, Rebuilding, Checking, In use, or Ready to turn on', () => {
    expect(stateWords('off', [readGraph('ready')])).toBe('Off');
    expect(stateWords('build', [])).toBe('Getting ready');
    expect(stateWords('build', [readGraph('building')])).toBe('Getting ready');
    // The builder reports one read graph at a time; one without a figure counts as not started.
    expect(stateWords('serve', [readGraph('building', { progress: 0.8 }), readGraph('building')])).toBe('Getting ready 40%');
    expect(stateWords('serve', [readGraph('ready'), readGraph('rebuilding')])).toBe('Rebuilding');
    expect(stateWords('serve', [readGraph('repairing'), readGraph('dirty')])).toBe('Rebuilding');
    expect(stateWords('serve', [readGraph('ready'), readGraph('dirty')])).toBe('Checking');
    expect(stateWords('serve', [readGraph('ready')])).toBe('In use');
    expect(stateWords('build', [readGraph('ready')])).toBe('Ready to turn on');
    expect(stateWords('build', [readGraph('removing')])).toBe('Getting ready');
  });

  it('sums assets and facts only when every read graph of the memory reports them', () => {
    expect(sizeWords('verifiable-memory', [readGraph('ready', { members: 1_200, triples: 24_000 }), readGraph('ready', { members: 4, triples: 80 })]))
      .toBe('1,204 assets, holds about 24,080 facts');
    expect(sizeWords('working-memory', [readGraph('ready', { members: 1 })])).toBe('1 draft');
    expect(sizeWords('verifiable-memory', [readGraph('ready', { members: 3 }), readGraph('ready')])).toBeUndefined();
    expect(sizeWords('verifiable-memory', [])).toBeUndefined();
  });

  it('says what a change did, in the words of the brief', () => {
    const change = { contextGraphId: 'my-project', layer: 'verifiable-memory', from: 'off', to: 'build', outcome: 'applied' } as const;
    expect(changeLine(change)).toBe('Published assets of my-project: off → preview. Getting ready in the background.');
    expect(changeLine({ ...change, layer: 'shared-working-memory', from: 'build', to: 'serve' }, 'In use')).toBe('Shared memory of my-project: preview → on. In use.');
    expect(changeLine({ ...change, from: 'serve', to: 'build' }, 'Ready to turn on')).toBe('Published assets of my-project: on → preview. Ready to turn on.');
    expect(changeLine({ ...change, to: 'serve' })).toBe('Published assets of my-project: off → on. '
      + 'Getting ready in the background; until then, queries that ask to search across assets are told it is not ready.');
    expect(changeLine({ ...change, layer: 'working-memory', from: 'serve', to: 'off' })).toBe('Private drafts of my-project: on → off. The combined copy is removed in the background.');
    expect(changeLine({ ...change, from: 'build', outcome: 'unchanged' })).toBe('Published assets of my-project: already preview.');
    expect(changeLine({ ...change, outcome: { refused: 'This node keeps no combined copies.' } })).toBe('Published assets of my-project: stays off. This node keeps no combined copies.');
  });

  it('lists a context graph\'s memories with their modes, whose they are, their state and size, and the default semantics', () => {
    const settings: ReadGraphContextGraphSettings = {
      contextGraphId: 'research',
      layers: { 'verifiable-memory': 'serve' },
      effective: { layers: { 'verifiable-memory': 'serve', 'shared-working-memory': 'off', 'working-memory': 'build' }, viewSemantics: 'per-asset' },
      readGraphs: [readGraph('ready', { members: 2, triples: 40 }), readGraph('dirty', { layer: 'wm', agentAddress: '0xab' })],
    };
    expect(layerLine(settings, 'verifiable-memory')).toBe('Published assets: on, in use. 2 assets, holds about 40 facts.');
    expect(layerLine(settings, 'shared-working-memory')).toBe('Shared memory, shared with your team: off (node default).');
    expect(layerLine(settings, 'working-memory')).toBe('Private drafts: preview (node default), checking.');
    expect(semanticsLine(settings)).toBe('Queries that don\'t choose: search each asset on its own (node default).');
    expect(semanticsLine({ ...settings, viewSemantics: 'merged', effective: { ...settings.effective, viewSemantics: 'merged' } })).toBe('Queries that don\'t choose: search across assets.');
    // An answer without the effective modes or the read graphs: the rows alone.
    const rowsOnly = { contextGraphId: 'research', layers: { 'working-memory': 'build' } } as unknown as ReadGraphContextGraphSettings;
    expect(layerLine(rowsOnly, 'working-memory')).toBe('Private drafts: preview, getting ready.');
  });

  it('says whether the node allows it, and for which memories', () => {
    expect(policyLine({ enabled: true, layers: ['verifiable-memory', 'shared-working-memory'] }))
      .toBe('Search across assets is allowed for: Published assets; Shared memory, shared with your team.');
    expect(policyLine({ enabled: false, layers: [] })).toBe('Search across assets is switched off on this node (query.readGraphsPolicy in its config.json).');
  });
});

describe('what a change names, from the node\'s report on every memory of each context graph in its settings', () => {
  const entry = (contextGraphId: string, layer: ReadGraphModeChange['layer'], from: ReadGraphModeChange['from'], to: ReadGraphModeChange['to'],
    outcome: ReadGraphModeChange['outcome'] = 'applied'): ReadGraphModeChange => ({ contextGraphId, layer, from, to, outcome });
  const report = [
    entry('team', 'working-memory', 'off', 'off', 'unchanged'),
    entry('team', 'shared-working-memory', 'off', 'build'),
    entry('team', 'verifiable-memory', 'build', 'build', 'unchanged'),
    entry('other', 'verifiable-memory', 'serve', 'serve', 'unchanged'),
    entry('third', 'verifiable-memory', 'off', 'build'),
    entry('fourth', 'working-memory', 'off', 'serve', { refused: 'not applied: another change in the same apply was refused' }),
  ];
  const [, teamShared, teamPublished, otherPublished, third, fourth] = report;

  it('a memory left as it was only when the request set it, and every change and refusal', () => {
    expect(changesToName(report, { contextGraphId: 'team', layers: { 'shared-working-memory': 'build', 'verifiable-memory': 'build' } }))
      .toEqual([teamShared, teamPublished, third, fourth]);
    expect(changesToName(report, { contextGraphId: 'team', layers: { 'shared-working-memory': 'build' } })).toEqual([teamShared, third, fourth]);
    // A change of the default semantics alone sets no memory.
    expect(changesToName(report, { contextGraphId: 'team' })).toEqual([teamShared, third, fourth]);
    expect(changesToName(report, { contextGraphId: 'other', layers: { 'verifiable-memory': 'serve' } })).toEqual([teamShared, otherPublished, third, fourth]);
  });
});

describe('what a creation says about its setting', () => {
  const vm = { layers: { 'verifiable-memory': 'build' } } as const;
  const all = { layers: { 'verifiable-memory': 'serve', 'shared-working-memory': 'serve', 'working-memory': 'serve' } } as const;

  it('nothing, when none was asked for', () => {
    expect(createReadGraphsLines('0xab/research', undefined, undefined)).toEqual({ lines: [], ok: true });
  });

  it('the changes the node applied, or the memories it switched when it lists none', () => {
    const changes = [{ contextGraphId: '0xab/research', layer: 'verifiable-memory', from: 'off', to: 'build', outcome: 'applied' }] as const;
    expect(createReadGraphsLines('0xab/research', vm, { applied: true, changes })).toEqual({
      lines: ['Published assets of 0xab/research: off → preview. Getting ready in the background.'], ok: true,
    });
    expect(createReadGraphsLines('0xab/research', vm, { applied: true, changes: [] })).toEqual({
      lines: ['Published assets of 0xab/research: preview. Getting ready in the background.'], ok: true,
    });
    expect(createReadGraphsLines('0xab/research', vm, { applied: true, changes: [{ ...changes[0], outcome: { refused: 'Not allowed.' } }] })).toEqual({
      lines: ['Published assets of 0xab/research: stays off. Not allowed.'], ok: false,
    });
  });

  it('from the node\'s report on every context graph, what the creation set and what changed elsewhere', () => {
    const report = [
      { contextGraphId: '0xab/research', layer: 'verifiable-memory', from: 'off', to: 'build', outcome: 'applied' },
      { contextGraphId: '0xab/research', layer: 'working-memory', from: 'off', to: 'off', outcome: 'unchanged' },
      { contextGraphId: 'other', layer: 'verifiable-memory', from: 'serve', to: 'serve', outcome: 'unchanged' },
      { contextGraphId: 'third', layer: 'shared-working-memory', from: 'off', to: 'build', outcome: 'applied' },
    ] as const;
    expect(createReadGraphsLines('0xab/research', vm, { applied: true, changes: report })).toEqual({
      lines: ['Published assets of 0xab/research: off → preview. Getting ready in the background.', 'Shared memory of third: off → preview. Getting ready in the background.'],
      ok: true,
    });
  });

  it('why it is not in force, and how to switch it on later', () => {
    const refused = { refused: 'Search across assets is switched off on this node.', code: 'READ_GRAPHS_DISABLED' };
    expect(createReadGraphsLines('0xab/research', all, refused)).toEqual({
      lines: ['Search across assets was not switched on: Search across assets is switched off on this node.',
        'Switch it on later with: dkg store read-graphs enable -c 0xab/research --layer all --mode on'],
      ok: false,
    });
    expect(createReadGraphsLines('0xab/research', { layers: { 'working-memory': 'build' } }, refused).lines[1])
      .toBe('Switch it on later with: dkg store read-graphs enable -c 0xab/research --layer working-memory');
    expect(createReadGraphsLines('0xab/research', vm, refused).lines[1]).toBe('Switch it on later with: dkg store read-graphs enable -c 0xab/research');
    expect(createReadGraphsLines('0xab/research', vm, undefined)).toEqual({
      lines: ['Search across assets: this node did not say whether it switched it on. Check with: dkg store read-graphs settings -c 0xab/research'],
      ok: false,
    });
  });
});
