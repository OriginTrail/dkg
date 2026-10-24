import { describe, expect, it } from 'vitest';
import { GraphManager, OxigraphStore } from '../src/index.js';

describe('new context-graph storage boundary', () => {
  it('rejects structural partition aliases before creating any graph', async () => {
    const store = new OxigraphStore();
    const manager = new GraphManager(store);

    await expect(manager.ensureNewContextGraph('victim/_meta'))
      .rejects.toThrow(/reserved storage partition/);

    await expect(store.listGraphs()).resolves.toEqual([]);
  });

  it('keeps the legacy ensure path available for existing read and sync callers', async () => {
    const store = new OxigraphStore();
    const manager = new GraphManager(store);

    await expect(manager.ensureContextGraph('legacy/_meta')).resolves.toBeUndefined();
  });
});
