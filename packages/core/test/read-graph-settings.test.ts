import { describe, expect, it } from 'vitest';
import {
  READ_GRAPH_CREATE_MODE_INPUTS,
  READ_GRAPH_LAYER_INPUTS,
  READ_GRAPH_MODE_INPUTS,
  describeReadGraphChanges,
  describeReadGraphSettings,
  describeReadGraphSettingsRefusal,
  describeReadGraphsCreateOutcome,
  readGraphModeOf,
  readGraphModes,
  readGraphSettingsActorHeaders,
  readGraphSettingsPath,
} from '../src/read-graph-settings.js';

const view = (layer: string, state: string, readGraph = `urn:rg:${layer}:${state}`) => ({ readGraph, contextGraphId: 'team', layer, state, generation: 1 });
/** Words users never see: engine values and the internal name. */
const ENGINE_WORDS = /\b(build|serve)\b|read graph/i;

describe('read-graph settings requests', () => {
  it('names the settings route, for every context graph or one', () => {
    expect(readGraphSettingsPath()).toBe('/api/store/read-graphs/settings');
    expect(readGraphSettingsPath('0xabc/team notes&x')).toBe('/api/store/read-graphs/settings?contextGraphId=0xabc%2Fteam+notes%26x');
  });

  it('names the agent runtime that changes a setting', () => {
    expect(readGraphSettingsActorHeaders('openclaw')).toEqual({ 'X-DKG-Actor': 'agent:openclaw' });
  });

  it('takes only the words users see for a mode', () => {
    expect(READ_GRAPH_MODE_INPUTS.map(readGraphModeOf)).toEqual(['off', 'build', 'serve']);
    expect(READ_GRAPH_CREATE_MODE_INPUTS).toEqual(['preview', 'on']);
  });

  it('sets one layer, or all three', () => {
    expect(READ_GRAPH_LAYER_INPUTS).toEqual(['verifiable-memory', 'shared-working-memory', 'working-memory', 'all']);
    expect(readGraphModes('shared-working-memory', 'build')).toEqual({ 'shared-working-memory': 'build' });
    expect(readGraphModes('all', 'serve')).toEqual({
      'verifiable-memory': 'serve',
      'shared-working-memory': 'serve',
      'working-memory': 'serve',
    });
  });
});

describe('describeReadGraphSettings', () => {
  it('shows each memory in plain words, with how far its copies are', () => {
    const text = describeReadGraphSettings({
      policy: { enabled: true, layers: ['verifiable-memory', 'shared-working-memory', 'working-memory'] },
      contextGraphs: [{
        contextGraphId: 'team',
        layers: { 'verifiable-memory': 'serve', 'shared-working-memory': 'build' },
        viewSemantics: 'merged',
        effective: {
          layers: { 'verifiable-memory': 'serve', 'shared-working-memory': 'build', 'working-memory': 'serve' },
          viewSemantics: 'merged',
        },
        readGraphs: [view('vm', 'ready'), view('swm', 'ready'), view('wm', 'ready', 'urn:a'), view('wm', 'building', 'urn:b'), view('wm', 'dirty', 'urn:c')],
      }],
    });
    expect(text).toBe([
      'Search across assets in team:',
      '- Published assets: On: In use',
      '- Shared memory, shared with your team: Preview: Ready to turn on',
      '- Private drafts: On: 1 In use, 1 Getting ready, 1 Rebuilding',
      '- Queries search across assets by default: On.',
    ].join('\n'));
    expect(text).not.toMatch(ENGINE_WORDS);
  });

  it('says when the node keeps a memory from what was set, and why', () => {
    const text = describeReadGraphSettings({
      policy: { enabled: false, layers: ['verifiable-memory'] },
      refused: { code: 'READ_GRAPHS_UNSUPPORTED', error: 'This store cannot keep a combined copy.' },
      contextGraphs: [{
        contextGraphId: 'team',
        layers: { 'verifiable-memory': 'serve', 'working-memory': 'build' },
        effective: { layers: { 'verifiable-memory': 'off', 'shared-working-memory': 'off', 'working-memory': 'off' }, viewSemantics: 'per-asset' },
        readGraphs: [],
      }],
    });
    expect(text.split('\n')).toEqual([
      'Search across assets is switched off for this whole node.',
      "This node can't turn search across assets on: This store cannot keep a combined copy. (READ_GRAPHS_UNSUPPORTED)",
      'Search across assets in team:',
      '- Published assets: Off (set to On, but this node keeps it Off)',
      '- Shared memory, shared with your team: Off',
      '- Private drafts: Off (set to Preview, but this node does not allow it)',
      '- Queries search across assets by default: Off, each asset is searched on its own.',
    ]);
  });

  it('reads the rows alone when the answer has no modes in force, and names a state it does not know', () => {
    const text = describeReadGraphSettings({
      refused: {},
      contextGraphs: [{ contextGraphId: 'solo', layers: { 'verifiable-memory': 'build' }, readGraphs: [view('vm', 'paused'), null] }, null],
    });
    expect(text.split('\n')).toEqual([
      "This node can't turn search across assets on: no reason given",
      'Search across assets in solo:',
      '- Published assets: Preview: paused',
      '- Shared memory, shared with your team: not set',
      '- Private drafts: not set',
    ]);
  });

  it("shows the node's own default for context graphs without settings of their own", () => {
    expect(describeReadGraphSettings({
      node: { layers: { 'verifiable-memory': 'build', 'shared-working-memory': 'off', 'working-memory': 'serve' }, viewSemantics: 'merged' },
      contextGraphs: [],
    }).split('\n')).toEqual([
      "This node's default: Published assets: Preview · Shared memory, shared with your team: Off · Private drafts: On · Queries search across assets: On.",
      'No context graph has search across assets set up.',
    ]);
    expect(describeReadGraphSettings({ node: { layers: { 'verifiable-memory': 'off' }, viewSemantics: 'per-asset' }, contextGraphs: [] }).split('\n')[0])
      .toBe("This node's default: Published assets: Off · Shared memory, shared with your team: not set · Private drafts: not set · Queries search across assets: Off.");
    expect(describeReadGraphSettings({ node: { layers: { 'verifiable-memory': 'off' } }, contextGraphs: [] }).split('\n')[0])
      .toBe("This node's default: Published assets: Off · Shared memory, shared with your team: not set · Private drafts: not set.");
    expect(describeReadGraphSettings({ node: {}, contextGraphs: [] })).toBe('No context graph has search across assets set up.');
  });

  it('says how far the copy being built is', () => {
    const text = describeReadGraphSettings({
      contextGraphs: [{
        contextGraphId: 'team',
        effective: { layers: { 'verifiable-memory': 'build', 'shared-working-memory': 'serve', 'working-memory': 'build' } },
        readGraphs: [
          { ...view('vm', 'building'), progress: 0.405 },
          { ...view('swm', 'building', 'urn:a'), progress: 0 },
          { ...view('swm', 'ready', 'urn:b') },
          { ...view('wm', 'building'), progress: 1.5 },
        ],
      }],
    });
    expect(text.split('\n').slice(1)).toEqual([
      '- Published assets: Preview: Getting ready 41%',
      '- Shared memory, shared with your team: On: 1 Getting ready 0%, 1 In use',
      '- Private drafts: Preview: Getting ready',
    ]);
  });

  it('adds the assets and facts a memory held at its last build, only when every copy reports them', () => {
    const text = describeReadGraphSettings({
      contextGraphs: [{
        contextGraphId: 'team',
        effective: { layers: { 'verifiable-memory': 'serve', 'shared-working-memory': 'build', 'working-memory': 'build' } },
        readGraphs: [
          { ...view('vm', 'ready', 'urn:a'), members: 12_000, triples: 1_200_000 },
          { ...view('vm', 'ready', 'urn:b'), members: 400, triples: 48_000 },
          { ...view('swm', 'ready', 'urn:c'), members: 1, triples: 1 },
          { ...view('wm', 'ready', 'urn:e'), members: -1, triples: 10 },
          { ...view('wm', 'ready', 'urn:f'), members: 2.5 },
        ],
      }, {
        contextGraphId: 'empty',
        layers: { 'verifiable-memory': 'off', 'working-memory': 'build' },
        effective: { layers: { 'verifiable-memory': 'off', 'shared-working-memory': 'off', 'working-memory': 'build' } },
        readGraphs: [{ ...view('vm', 'ready', 'urn:g'), members: 5, triples: 50 }, { ...view('wm', 'ready', 'urn:h'), members: 0, triples: 0 }],
      }],
    });
    expect(text.split('\n')).toEqual([
      'Search across assets in team:',
      '- Published assets · 12,400 assets: On: In use. About 1,248,000 facts, at its last build',
      '- Shared memory, shared with your team · 1 asset: Preview: Ready to turn on. About 1 fact, at its last build',
      '- Private drafts: Preview: Ready to turn on',
      'Search across assets in empty:',
      '- Published assets: Off',
      '- Shared memory, shared with your team: Off',
      '- Private drafts · 0 assets: Preview: Ready to turn on. About 0 facts, at its last build',
    ]);
  });

  it('counts a memory\'s assets and facts from its whole copies, as a sub-graph\'s copy holds what the whole copy already holds', () => {
    const text = describeReadGraphSettings({
      contextGraphs: [{
        contextGraphId: 'team',
        effective: { layers: { 'verifiable-memory': 'serve', 'shared-working-memory': 'build', 'working-memory': 'build' } },
        readGraphs: [
          // One asset, in the registered sub-graph `code`: the whole copy and the sub-graph's copy both hold it.
          { ...view('vm', 'ready', 'urn:vm'), members: 1, triples: 20 },
          { ...view('vm', 'ready', 'urn:vm:code'), subGraphName: 'code', members: 1, triples: 20 },
          // A count stays unknown while the whole copy lacks it, whatever the sub-graph's copy says.
          view('swm', 'ready', 'urn:swm'),
          { ...view('swm', 'ready', 'urn:swm:code'), subGraphName: 'code', members: 1, triples: 2 },
          // Each agent's drafts are its own, so the agents' whole copies add up. States still come from every copy.
          { ...view('wm', 'ready', 'urn:wm:a'), agentAddress: '0xa', members: 2, triples: 6 },
          { ...view('wm', 'ready', 'urn:wm:b'), agentAddress: '0xb', members: 3, triples: 9 },
          { ...view('wm', 'building', 'urn:wm:a:code'), agentAddress: '0xa', subGraphName: 'code', members: 2, triples: 6 },
        ],
      }],
    });
    expect(text.split('\n').slice(1)).toEqual([
      '- Published assets · 1 asset: On: In use. About 20 facts, at its last build',
      '- Shared memory, shared with your team: Preview: Ready to turn on',
      '- Private drafts · 5 assets: Preview: 2 Ready to turn on, 1 Getting ready. About 15 facts, at its last build',
    ]);
  });

  it('says when a memory is still getting ready, and when nothing is set up', () => {
    expect(describeReadGraphSettings({ contextGraphs: [{ contextGraphId: 'new', effective: { layers: { 'verifiable-memory': 'build' } } }] }))
      .toContain('- Published assets: Preview: Getting ready');
    expect(describeReadGraphSettings({ contextGraphs: [] })).toBe('No context graph has search across assets set up.');
    expect(describeReadGraphSettings(null)).toBe('No context graph has search across assets set up.');
    expect(describeReadGraphSettings({ policy: [], contextGraphs: 'none' })).toBe('No context graph has search across assets set up.');
  });
});

describe('describeReadGraphChanges', () => {
  const change = (layer: string, from: unknown, to: unknown, outcome: unknown, contextGraphId: unknown = 'my-project') => ({ contextGraphId, layer, from, to, outcome });

  it('says what each change did, in a sentence', () => {
    const text = describeReadGraphChanges({
      changes: [
        change('verifiable-memory', 'off', 'build', 'applied'),
        change('shared-working-memory', 'build', 'serve', 'applied'),
        change('working-memory', 'serve', 'build', 'applied'),
        change('vm', 'serve', 'off', 'applied'),
        change('swm', 'serve', 'serve', 'unchanged'),
        change('wm', 'off', 'serve', { refused: 'Turn Preview on first.' }),
        change('verifiable-memory', 'off', 'serve', { refused: { code: 'X', error: 'No.' } }),
      ],
    }, { contextGraphId: 'my-project', layers: { 'shared-working-memory': 'serve' } });
    expect(text?.split('\n')).toEqual([
      "Getting search across assets ready for my-project's published assets. Preview shows how results would change before it is turned on.",
      "Turned search across assets on for my-project's shared memory.",
      "Search across assets is back to Preview for my-project's private drafts: queries no longer search across them, and the combined copy stays up to date.",
      "Turned search across assets off for my-project's published assets; its combined copy is removed.",
      "Search across assets was already On for my-project's shared memory.",
      "Search across assets was not changed for my-project's private drafts: Turn Preview on first.",
      "Search across assets was not changed for my-project's published assets: No. (X)",
    ]);
    expect(text).not.toMatch(ENGINE_WORDS);
  });

  it('keeps going on values it does not know', () => {
    expect(describeReadGraphChanges({
      changes: [
        change('elsewhere', 'odd', 'other', 'unchanged', ''),
        change('wm', 'serve', 'off', { refused: 7 }, 3),
        change('wm', 'serve', 'off', 'odd'),
        change('vm', 'off', 'sideways', 'applied'),
      ],
    }, { contextGraphId: '', layers: { elsewhere: 'off' } as never })?.split('\n')).toEqual([
      'Search across assets was already other for elsewhere.',
      'Search across assets was not changed for private drafts: no reason given',
      "Search across assets was not changed for my-project's private drafts: no reason given",
      "Search across assets for my-project's published assets: sideways.",
    ]);
  });

  it('is undefined when the answer lists no changes', () => {
    expect(describeReadGraphChanges({ contextGraphs: [] })).toBeUndefined();
    expect(describeReadGraphChanges(undefined)).toBeUndefined();
  });

  // The node reports every memory of each context graph in its settings, not only the ones a change names.
  const nodeWide = {
    changes: [
      change('working-memory', 'off', 'off', 'unchanged', 'team'),
      change('shared-working-memory', 'off', 'build', 'applied', 'team'),
      change('verifiable-memory', 'build', 'build', 'unchanged', 'team'),
      change('working-memory', 'off', 'off', 'unchanged', 'other'),
      change('verifiable-memory', 'serve', 'serve', 'unchanged', 'other'),
      change('verifiable-memory', 'off', 'build', 'applied', 'third'),
    ],
  };

  it('describes a memory left as it was only when the request set it, and every change', () => {
    const preview = 'Preview shows how results would change before it is turned on.';
    expect(describeReadGraphChanges(nodeWide, { contextGraphId: 'team', layers: { 'shared-working-memory': 'build', 'verifiable-memory': 'build' } })
      ?.split('\n')).toEqual([
      `Getting search across assets ready for team's shared memory. ${preview}`,
      "Search across assets was already Preview for team's published assets.",
      `Getting search across assets ready for third's published assets. ${preview}`,
    ]);
    expect(describeReadGraphChanges(nodeWide, { contextGraphId: 'team', layers: { 'shared-working-memory': 'build' } })?.split('\n')).toEqual([
      `Getting search across assets ready for team's shared memory. ${preview}`,
      `Getting search across assets ready for third's published assets. ${preview}`,
    ]);
    expect(describeReadGraphChanges(nodeWide)?.split('\n')).toHaveLength(2);
    // A change of the default semantics alone sets no memory: nothing to say about the memories left as they were.
    const unchanged = { changes: nodeWide.changes.filter((entry) => entry.outcome === 'unchanged') };
    expect(describeReadGraphChanges(unchanged, { contextGraphId: 'team', viewSemantics: 'merged' })).toBeUndefined();
    expect(describeReadGraphChanges(unchanged, { contextGraphId: 'other', layers: { vm: 'serve' } as never })).toBeUndefined();
    expect(describeReadGraphChanges({ changes: [change('vm', 'serve', 'serve', 'unchanged', 'other')] }, { contextGraphId: 'other', layers: { 'verifiable-memory': 'serve' } }))
      .toBe("Search across assets was already On for other's published assets.");
  });
});

describe('describeReadGraphsCreateOutcome', () => {
  const preview = { layers: { 'verifiable-memory': 'build' as const } };
  const on = { layers: { 'verifiable-memory': 'serve' as const, 'shared-working-memory': 'serve' as const, 'working-memory': 'serve' as const } };

  it('reports an applied setting', () => {
    expect(describeReadGraphsCreateOutcome('my-project', preview, { applied: true })).toBe(
      "Getting search across assets ready for my-project's published assets. Preview shows how results would change before it is turned on.",
    );
    expect(describeReadGraphsCreateOutcome('my-project', on, { applied: {} }))
      .toBe("Turned search across assets on for my-project's published assets, shared memory and private drafts.");
    expect(describeReadGraphsCreateOutcome('my-project', { layers: { 'working-memory': 'off', 'odd-layer': 'off' } as never }, { applied: true }))
      .toBe("Search across assets stays off for my-project's private drafts and odd-layer.");
  });

  it('reports a refused setting, as a sentence or with a code', () => {
    expect(describeReadGraphsCreateOutcome('my-project', preview, { refused: 'Only the node admin can change this.' })).toBe(
      'Search across assets was not turned on for my-project: Only the node admin can change this. '
        + 'The context graph was created; search across assets can be turned on later with dkg_read_graphs_set.',
    );
    expect(describeReadGraphsCreateOutcome('my-project', preview, { refused: { code: 'READ_GRAPHS_DISABLED', error: 'Switched off for this node.' } }))
      .toContain('was not turned on for my-project: Switched off for this node. (READ_GRAPHS_DISABLED) ');
    expect(describeReadGraphsCreateOutcome('my-project', preview, { refused: null })).toContain('was not turned on for my-project: no reason given ');
    expect(describeReadGraphsCreateOutcome('my-project', preview, { refused: 'Only the node admin can turn search across assets on.', code: 'NODE_ADMIN_REQUIRED' }))
      .toBe('Search across assets was not turned on for my-project: Only the node admin can turn search across assets on. (NODE_ADMIN_REQUIRED) '
        + 'The context graph was created; search across assets can be turned on later with dkg_read_graphs_set.');
  });

  it('says a node that answers without the setting did not apply it', () => {
    for (const outcome of [undefined, null, 'applied', {}]) {
      expect(describeReadGraphsCreateOutcome('my-project', preview, outcome))
        .toMatch(/^Search across assets was not turned on for my-project: the node did not apply the setting.*dkg_read_graphs_status\.$/);
    }
  });
});

describe('describeReadGraphSettingsRefusal', () => {
  const caller = 'this adapter';

  it('says only the node admin may use the settings, for 401 and 403, without the node\'s wording', () => {
    const forbidden = describeReadGraphSettingsRefusal({ status: 403, body: { error: 'GET /api/store/read-graphs/settings requires a node-level admin token.' }, message: 'HTTP 403' }, caller);
    expect(forbidden).toBe("Only the node admin can see or change search across assets, and the node did not accept this adapter's token as the node admin token (HTTP 403).");
    expect(forbidden).not.toMatch(ENGINE_WORDS);
    expect(describeReadGraphSettingsRefusal({ status: 401, message: 'GET … → 401: Unauthorized' }, caller)).toMatch(/\(HTTP 401\)\.$/);
  });

  it('names a node from before the settings, but not a coded 404', () => {
    expect(describeReadGraphSettingsRefusal({ status: 404, body: { error: 'Not found' }, message: 'x' }, caller))
      .toMatch(/runs a DKG version from before them/);
    expect(describeReadGraphSettingsRefusal({ status: 404, body: { code: 'NO_SUCH', error: 'Gone.' }, message: 'x' }, caller))
      .toBe('The node refused: Gone. (NO_SUCH)');
  });

  it("gives the node's sentence and code, what each memory did, or the client's message", () => {
    expect(describeReadGraphSettingsRefusal({ status: 409, body: { code: 'READ_GRAPHS_LAYER_NOT_ALLOWED', error: 'This node does not allow that memory.' }, message: 'x' }, caller))
      .toBe('The node refused: This node does not allow that memory. (READ_GRAPHS_LAYER_NOT_ALLOWED)');
    expect(describeReadGraphSettingsRefusal({
      status: 409,
      body: {
        code: 'READ_GRAPHS_APPLY_REFUSED',
        error: 'The node could not apply the change; nothing changed.',
        changes: [{ contextGraphId: 'team', layer: 'verifiable-memory', from: 'off', to: 'serve', outcome: { refused: 'The store is busy.' } }],
      },
      message: 'x',
    }, caller)).toBe('The node refused: The node could not apply the change; nothing changed. (READ_GRAPHS_APPLY_REFUSED)\n'
      + "Search across assets was not changed for team's published assets: The store is busy.");
    expect(describeReadGraphSettingsRefusal({ status: 500, body: 'oops', message: 'HTTP 500 oops' }, caller)).toBe('The node refused: HTTP 500 oops');
    expect(describeReadGraphSettingsRefusal({ message: 'fetch failed' }, caller)).toBe('No answer from the node: fetch failed');
  });

  it('lists, from the node-wide report, what the refused change set and nothing left as it was elsewhere', () => {
    const body = {
      code: 'READ_GRAPHS_APPLY_REFUSED',
      error: 'The node could not apply the change; nothing changed.',
      changes: [
        { contextGraphId: 'team', layer: 'working-memory', from: 'off', to: 'serve', outcome: { refused: 'Turn Preview on first.' } },
        { contextGraphId: 'team', layer: 'verifiable-memory', from: 'build', to: 'serve', outcome: { refused: 'not applied: another change in the same apply was refused' } },
        { contextGraphId: 'team', layer: 'shared-working-memory', from: 'off', to: 'off', outcome: 'unchanged' },
        { contextGraphId: 'other', layer: 'verifiable-memory', from: 'serve', to: 'serve', outcome: 'unchanged' },
      ],
    };
    expect(describeReadGraphSettingsRefusal({ status: 409, body, message: 'x' }, caller, {
      contextGraphId: 'team', layers: { 'working-memory': 'serve', 'verifiable-memory': 'serve' },
    })).toBe('The node refused: The node could not apply the change; nothing changed. (READ_GRAPHS_APPLY_REFUSED)\n'
      + "Search across assets was not changed for team's private drafts: Turn Preview on first.\n"
      + "Search across assets was not changed for team's published assets: not applied: another change in the same apply was refused");
  });
});
