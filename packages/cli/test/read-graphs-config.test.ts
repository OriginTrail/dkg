import { describe, expect, it } from 'vitest';
import { MemoryLayer, readScope, type ReadGraphKey } from '@origintrail-official/dkg-core';
import { readGraphModeOf, viewSemanticsOf } from '@origintrail-official/dkg-storage';
import {
  QueryConfigError,
  nodeReadGraphModes,
  readGraphStoreSettings,
  resolveEffectiveQueryConfig,
  resolveQueryConfig,
  resolveQuerySection,
  type ReadGraphsRefusal,
} from '../src/read-graphs-config.js';
import type { ReadGraphSettingsEntry } from '../src/read-graph-settings-store.js';

const CURATED = `0x${'cd'.repeat(20)}/my-project`;
const AGENT = `0x${'ab'.repeat(20)}`;
const key = (contextGraphId: string, layer: MemoryLayer): ReadGraphKey => layer === MemoryLayer.WorkingMemory
  ? { scope: readScope(contextGraphId), layer, agentAddress: AGENT }
  : { scope: readScope(contextGraphId), layer };
const table = (...entries: ReadGraphSettingsEntry[]): ReadGraphSettingsEntry[] => entries;
const NONE = { refusals: [] };

function issuesOf(input: unknown): Array<{ key: string; message: string }> {
  try {
    resolveQuerySection(input);
  } catch (error) {
    expect(error).toBeInstanceOf(QueryConfigError);
    return [...(error as QueryConfigError).issues];
  }
  throw new Error('expected the section to be refused');
}

describe('the query section', () => {
  it('keeps no read graph, matches per asset and allows every layer when absent', () => {
    const section = resolveQuerySection(undefined);
    expect(section).toEqual({
      policy: {
        readGraphs: { default: 'off' },
        viewSemantics: { default: 'per-asset' },
        readGraphsPolicy: { enabled: true, layers: ['working-memory', 'shared-working-memory', 'verifiable-memory'] },
      },
      contextGraphSettings: [],
      deprecatedKeys: [],
    });
    expect(resolveQuerySection({})).toEqual(section);
    expect(readGraphModeOf(nodeReadGraphModes(section.policy), key('any', MemoryLayer.VerifiableMemory))).toBe('off');
  });

  it('takes the node\'s mode, or a default with modes per layer, and its view-semantics default', () => {
    expect(resolveQuerySection({ readGraphs: 'build', viewSemantics: 'merged' }).policy)
      .toMatchObject({ readGraphs: { default: 'build' }, viewSemantics: { default: 'merged' } });
    const { policy } = resolveQuerySection({ readGraphs: { default: 'off', layers: { 'verifiable-memory': 'build' } } });
    expect(policy.readGraphs).toEqual({ default: 'off', layers: { [MemoryLayer.VerifiableMemory]: 'build' } });
  });

  it('turns rules for single context graphs into table entries, a default becoming a mode for each layer, and names their keys', () => {
    const section = resolveQuerySection({
      readGraphs: {
        layers: { 'verifiable-memory': 'build' },
        contextGraphs: {
          [CURATED]: 'serve',
          notes: { default: 'build', layers: { 'shared-working-memory': 'serve', 'working-memory': 'off' } },
          drafts: { layers: { 'working-memory': 'build' } },
        },
      },
      viewSemantics: { contextGraphs: { [CURATED]: 'merged', constructor: 'merged' } },
    });
    expect(section.policy.readGraphs).toEqual({ layers: { [MemoryLayer.VerifiableMemory]: 'build' } });
    expect(section.contextGraphSettings).toEqual([
      { contextGraphId: CURATED, layers: { 'working-memory': 'serve', 'shared-working-memory': 'serve', 'verifiable-memory': 'serve' }, viewSemantics: 'merged' },
      { contextGraphId: 'constructor', layers: {}, viewSemantics: 'merged' },
      { contextGraphId: 'drafts', layers: { 'working-memory': 'build' } },
      { contextGraphId: 'notes', layers: { 'working-memory': 'off', 'shared-working-memory': 'serve', 'verifiable-memory': 'build' } },
    ]);
    expect(section.deprecatedKeys).toEqual(['query.readGraphs.contextGraphs', 'query.viewSemantics.contextGraphs']);
    expect(resolveQuerySection({ readGraphs: { contextGraphs: {} } }).deprecatedKeys).toEqual([]);
  });

  it('takes a policy: a kill switch, and the layers that may keep read graphs', () => {
    const closed = resolveQuerySection({ readGraphs: 'serve', readGraphsPolicy: { enabled: false } }).policy;
    expect(closed.readGraphsPolicy).toEqual({ enabled: false, layers: ['working-memory', 'shared-working-memory', 'verifiable-memory'] });
    expect(nodeReadGraphModes(closed)).toEqual({ default: 'off' });
    const vmOnly = resolveQuerySection({ readGraphs: 'build', readGraphsPolicy: { layers: ['verifiable-memory', 'verifiable-memory'] } }).policy;
    expect(vmOnly.readGraphsPolicy.layers).toEqual(['verifiable-memory']);
    const modes = nodeReadGraphModes(vmOnly);
    expect(readGraphModeOf(modes, key('any', MemoryLayer.VerifiableMemory))).toBe('build');
    expect(readGraphModeOf(modes, key('any', MemoryLayer.WorkingMemory))).toBe('off');
    expect(readGraphModeOf(modes, key('any', MemoryLayer.SharedWorkingMemory))).toBe('off');
    expect(nodeReadGraphModes(resolveQuerySection({ readGraphs: 'build' }).policy)).toEqual({ default: 'build' });
  });

  it('keeps no read graph when the policy allows no layer, whatever the node\'s default', () => {
    for (const query of [
      { readGraphs: 'serve', readGraphsPolicy: { layers: [] } },
      { readGraphs: { default: 'build', layers: { 'verifiable-memory': 'serve' } }, readGraphsPolicy: { layers: [] } },
      // Every layer the node names off is the same: nothing is kept.
      { readGraphs: { default: 'serve', layers: { 'working-memory': 'off', 'shared-working-memory': 'off', 'verifiable-memory': 'off' } } },
    ]) {
      expect(nodeReadGraphModes(resolveQuerySection(query).policy), JSON.stringify(query)).toEqual({ default: 'off' });
    }
  });

  it('names every offending key in one error, and refuses unknown keys', () => {
    const issues = issuesOf({
      readGraphs: {
        default: 'on',
        layers: { wm: 'build', 'verifiable-memory': 'served' },
        contextGraphs: { _private: 'serve', ok: { layers: { 'working-memory': 'build' }, mode: 'serve' } },
        perLayer: {},
      },
      viewSemantics: { default: 'merged', contextGraphs: { ok: 'joined' } },
      readGraphsPolicy: { enabled: 'no', layers: ['vm', 'working-memory'], kill: true },
      readGraph: 'build',
    });
    expect(issues.map((issue) => issue.key).sort()).toEqual([
      'query.readGraph',
      'query.readGraphs.contextGraphs._private',
      'query.readGraphs.contextGraphs.ok.mode',
      'query.readGraphs.default',
      'query.readGraphs.layers.verifiable-memory',
      'query.readGraphs.layers.wm',
      'query.readGraphs.perLayer',
      'query.readGraphsPolicy.enabled',
      'query.readGraphsPolicy.kill',
      'query.readGraphsPolicy.layers[0]',
      'query.viewSemantics.contextGraphs.ok',
    ]);
    expect(issues.find((issue) => issue.key === 'query.readGraphs.default')?.message)
      .toBe('must be one of "off", "build", "serve" (got "on")');
    expect(issues.find((issue) => issue.key === 'query.readGraphsPolicy.enabled')?.message).toBe('must be true or false (got "no")');
  });

  it('refuses a section, a rule, a list of context graphs or a policy that is not of its shape', () => {
    expect(issuesOf('build').map((issue) => issue.key)).toEqual(['query']);
    expect(issuesOf({ readGraphs: ['build'] }).map((issue) => issue.key)).toEqual(['query.readGraphs']);
    expect(issuesOf({ readGraphs: { contextGraphs: 'serve' } }).map((issue) => issue.key)).toEqual(['query.readGraphs.contextGraphs']);
    expect(issuesOf({ viewSemantics: 42 }).map((issue) => issue.key)).toEqual(['query.viewSemantics']);
    expect(issuesOf({ readGraphsPolicy: false }).map((issue) => issue.key)).toEqual(['query.readGraphsPolicy']);
    expect(issuesOf({ readGraphsPolicy: { layers: 'verifiable-memory' } }).map((issue) => issue.key)).toEqual(['query.readGraphsPolicy.layers']);
  });
});

describe('the settings in force', () => {
  it('take the table\'s mode for a context graph and layer, then the node\'s mode for the layer, then its default', () => {
    const { policy } = resolveQuerySection({ readGraphs: { default: 'build', layers: { 'verifiable-memory': 'serve' } }, viewSemantics: 'merged' });
    const { config, warnings } = resolveEffectiveQueryConfig(policy, table(
      { contextGraphId: CURATED, layers: { 'verifiable-memory': 'off', 'working-memory': 'serve' }, viewSemantics: 'per-asset' },
      { contextGraphId: 'notes', layers: {}, viewSemantics: 'per-asset' },
    ), NONE);
    expect(warnings).toEqual([]);
    expect(readGraphModeOf(config.readGraphs, key(CURATED, MemoryLayer.VerifiableMemory))).toBe('off');
    expect(readGraphModeOf(config.readGraphs, key(CURATED, MemoryLayer.WorkingMemory))).toBe('serve');
    expect(readGraphModeOf(config.readGraphs, key(CURATED, MemoryLayer.SharedWorkingMemory))).toBe('build');
    expect(readGraphModeOf(config.readGraphs, key('other', MemoryLayer.VerifiableMemory))).toBe('serve');
    expect(viewSemanticsOf(config.viewSemantics, CURATED)).toBe('per-asset');
    expect(viewSemanticsOf(config.viewSemantics, 'notes')).toBe('per-asset');
    expect(viewSemanticsOf(config.viewSemantics, 'other')).toBe('merged');
    expect(config.readGraphs.contextGraphs).toEqual({ [CURATED]: { layers: { [MemoryLayer.VerifiableMemory]: 'off', [MemoryLayer.WorkingMemory]: 'serve' } } });
  });

  it('are the node\'s own with an empty table', () => {
    const { policy } = resolveQuerySection({ readGraphs: 'build' });
    expect(resolveEffectiveQueryConfig(policy, table(), NONE)).toEqual({
      config: { readGraphs: { default: 'build' }, viewSemantics: { default: 'per-asset' } },
      warnings: [],
    });
  });

  it('turn off a mode that the policy does not allow, with one warning for each reason', () => {
    const vmOnly = resolveQuerySection({ readGraphsPolicy: { layers: ['verifiable-memory'] } }).policy;
    const entries = [
      { contextGraphId: CURATED, layers: { 'verifiable-memory': 'serve', 'working-memory': 'build', 'shared-working-memory': 'off' } },
      { contextGraphId: 'notes', layers: { 'working-memory': 'serve' } },
    ] as const;
    const open = resolveEffectiveQueryConfig(vmOnly, table(...entries), NONE);
    expect(readGraphModeOf(open.config.readGraphs, key(CURATED, MemoryLayer.VerifiableMemory))).toBe('serve');
    expect(readGraphModeOf(open.config.readGraphs, key(CURATED, MemoryLayer.WorkingMemory))).toBe('off');
    expect(readGraphModeOf(open.config.readGraphs, key('notes', MemoryLayer.WorkingMemory))).toBe('off');
    expect(open.warnings).toEqual([
      `read graphs set for ${CURATED} (working-memory), notes (working-memory) are off: `
        + 'query.readGraphsPolicy.layers in config.json does not allow working-memory',
    ]);
    const closed = resolveEffectiveQueryConfig(resolveQuerySection({ readGraphsPolicy: { enabled: false } }).policy, table(...entries), NONE);
    expect(closed.config.readGraphs.contextGraphs?.[CURATED]?.layers).toEqual({
      [MemoryLayer.VerifiableMemory]: 'off', [MemoryLayer.WorkingMemory]: 'off', [MemoryLayer.SharedWorkingMemory]: 'off',
    });
    expect(closed.warnings).toEqual([
      `read graphs set for ${CURATED} (working-memory), ${CURATED} (verifiable-memory), notes (working-memory) are off: `
        + 'query.readGraphsPolicy.enabled is false in config.json',
    ]);
  });

  it('turn off every mode of the table that the node refuses, naming at most ten settings in the warning', () => {
    const refusal: ReadGraphsRefusal = { code: 'READ_GRAPHS_CHECKPOINT_NODE', message: 'the node starts from a public checkpoint' };
    const entries = Array.from({ length: 12 }, (_, index) => ({ contextGraphId: `cg-${String(index).padStart(2, '0')}`, layers: { 'verifiable-memory': 'build' } as const }));
    const { config, warnings } = resolveEffectiveQueryConfig(resolveQuerySection({}).policy, table(...entries, {
      contextGraphId: 'quiet', layers: { 'verifiable-memory': 'off' },
    }), { refusals: [refusal] });
    expect(Object.values(config.readGraphs.contextGraphs ?? {}).every((rule) => rule.layers?.[MemoryLayer.VerifiableMemory] === 'off')).toBe(true);
    expect(warnings).toEqual([
      `read graphs set for ${entries.slice(0, 10).map((entry) => `${entry.contextGraphId} (verifiable-memory)`).join(', ')} and 2 more are off: `
        + 'the node starts from a public checkpoint',
    ]);
  });

  it('never fail on the table: an ID that can\'t have read graphs is skipped, with a warning', () => {
    const { policy } = resolveQuerySection({ readGraphs: 'build' });
    const skipped = resolveEffectiveQueryConfig(policy, table({ contextGraphId: '_private', layers: { 'verifiable-memory': 'serve' } }), NONE);
    expect(skipped.config.readGraphs).toEqual({ default: 'build' });
    expect(skipped.warnings).toEqual(['read graphs set for _private are off: it is not a context graph ID that can have read graphs']);
  });

  it('of config.json alone, its rules for single context graphs included, are what tools without a node read', () => {
    const config = resolveQueryConfig({
      readGraphs: { layers: { 'verifiable-memory': 'build' }, contextGraphs: { [CURATED]: 'serve', notes: { layers: { 'verifiable-memory': 'off' } } } },
      viewSemantics: { default: 'merged', contextGraphs: { notes: 'per-asset' } },
      readGraphsPolicy: { layers: ['verifiable-memory', 'shared-working-memory'] },
    });
    expect(readGraphModeOf(config.readGraphs, key(CURATED, MemoryLayer.SharedWorkingMemory))).toBe('serve');
    expect(readGraphModeOf(config.readGraphs, key(CURATED, MemoryLayer.WorkingMemory))).toBe('off');
    expect(readGraphModeOf(config.readGraphs, key('notes', MemoryLayer.VerifiableMemory))).toBe('off');
    expect(readGraphModeOf(config.readGraphs, key('other', MemoryLayer.VerifiableMemory))).toBe('build');
    expect(viewSemanticsOf(config.viewSemantics, 'notes')).toBe('per-asset');
    expect(viewSemanticsOf(config.viewSemantics, CURATED)).toBe('merged');
    expect(() => resolveQueryConfig({ readGraphs: 'on' })).toThrow(QueryConfigError);
  });

  it('give the store configuration both settings', () => {
    const { config } = resolveEffectiveQueryConfig(resolveQuerySection({ readGraphs: 'build', viewSemantics: 'merged' }).policy, table(), NONE);
    expect(readGraphStoreSettings(config)).toEqual({ modes: config.readGraphs, viewSemantics: config.viewSemantics });
  });
});
