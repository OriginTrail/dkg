import { describe, expect, it } from 'vitest';
import { MemoryLayer, readScope } from '@origintrail-official/dkg-core';
import { readGraphModeOf, viewSemanticsOf } from '@origintrail-official/dkg-storage';
import { QueryConfigError, readGraphStoreSettings, resolveQueryConfig } from '../src/read-graphs-config.js';

const CURATED = `0x${'cd'.repeat(20)}/my-project`;
const key = (contextGraphId: string, layer: MemoryLayer.SharedWorkingMemory | MemoryLayer.VerifiableMemory) =>
  ({ scope: readScope(contextGraphId), layer });

function issuesOf(input: unknown): Array<{ key: string; message: string }> {
  try {
    resolveQueryConfig(input);
  } catch (error) {
    expect(error).toBeInstanceOf(QueryConfigError);
    return [...(error as QueryConfigError).issues];
  }
  throw new Error('expected the section to be refused');
}

describe('the query section', () => {
  it('keeps no read graph and matches per asset when absent', () => {
    const resolved = resolveQueryConfig(undefined);
    expect(resolved).toEqual({ readGraphs: { default: 'off' }, viewSemantics: { default: 'per-asset' } });
    expect(resolveQueryConfig({})).toEqual(resolved);
    expect(readGraphModeOf(resolved.readGraphs, key('any', MemoryLayer.VerifiableMemory))).toBe('off');
  });

  it('takes one mode, or a node default with modes per layer and rules per context graph', () => {
    expect(resolveQueryConfig({ readGraphs: 'build', viewSemantics: 'merged' }))
      .toEqual({ readGraphs: { default: 'build' }, viewSemantics: { default: 'merged' } });
    const { readGraphs, viewSemantics } = resolveQueryConfig({
      readGraphs: {
        default: 'off',
        layers: { 'verifiable-memory': 'build' },
        contextGraphs: {
          [CURATED]: 'serve',
          notes: { layers: { 'shared-working-memory': 'serve', 'working-memory': 'off' } },
        },
      },
      viewSemantics: { contextGraphs: { [CURATED]: 'merged' } },
    });
    expect(readGraphs).toEqual({
      default: 'off',
      layers: { [MemoryLayer.VerifiableMemory]: 'build' },
      contextGraphs: {
        [CURATED]: { default: 'serve' },
        notes: { layers: { [MemoryLayer.SharedWorkingMemory]: 'serve', [MemoryLayer.WorkingMemory]: 'off' } },
      },
    });
    expect(readGraphModeOf(readGraphs, key(CURATED, MemoryLayer.SharedWorkingMemory))).toBe('serve');
    expect(readGraphModeOf(readGraphs, key('notes', MemoryLayer.SharedWorkingMemory))).toBe('serve');
    expect(readGraphModeOf(readGraphs, key('notes', MemoryLayer.VerifiableMemory))).toBe('build');
    expect(readGraphModeOf(readGraphs, key('other', MemoryLayer.SharedWorkingMemory))).toBe('off');
    expect(viewSemanticsOf(viewSemantics, CURATED)).toBe('merged');
    expect(viewSemanticsOf(viewSemantics, 'notes')).toBe('per-asset');
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
      'query.viewSemantics.contextGraphs.ok',
    ]);
    expect(issues.find((issue) => issue.key === 'query.readGraphs.default')?.message)
      .toBe('must be one of "off", "build", "serve" (got "on")');
  });

  it('refuses a section, a rule or a list of context graphs that is not an object', () => {
    expect(issuesOf('build').map((issue) => issue.key)).toEqual(['query']);
    expect(issuesOf({ readGraphs: ['build'] }).map((issue) => issue.key)).toEqual(['query.readGraphs']);
    expect(issuesOf({ readGraphs: { contextGraphs: 'serve' } }).map((issue) => issue.key)).toEqual(['query.readGraphs.contextGraphs']);
    expect(issuesOf({ viewSemantics: 42 }).map((issue) => issue.key)).toEqual(['query.viewSemantics']);
  });

  it('gives the store configuration both settings', () => {
    const resolved = resolveQueryConfig({ readGraphs: 'build', viewSemantics: 'merged' });
    expect(readGraphStoreSettings(resolved)).toEqual({ modes: resolved.readGraphs, viewSemantics: resolved.viewSemantics });
  });
});
