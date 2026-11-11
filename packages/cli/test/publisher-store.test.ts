import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DkgConfig } from '../src/config.js';
import { publisherStoreConfig } from '../src/publisher-store.js';
import { QueryConfigError } from '../src/read-graphs-config.js';

const DATA_DIR = '/tmp/dkg-publisher-store-test';

function config(overrides: Partial<DkgConfig>): DkgConfig {
  return { name: 'test', apiPort: 0, listenPort: 0, nodeRole: 'edge', ...overrides } as DkgConfig;
}

describe('the store of a publisher runtime outside the daemon', () => {
  it('carries the read-graph settings and keeps the change log off for a configured store', () => {
    const built = publisherStoreConfig(DATA_DIR, config({
      store: { backend: 'sparql-http', options: { queryEndpoint: 'http://127.0.0.1:7878/query' }, changelog: true },
      query: { readGraphs: { layers: { 'verifiable-memory': 'build' } }, viewSemantics: 'merged' },
    }));
    expect(built.backend).toBe('sparql-http');
    expect(built.changelog).toBe(false);
    expect(built.largeLiteralStorage).toBeUndefined();
    expect(built.readGraphs).toEqual({
      modes: { layers: { VM: 'build' } },
      viewSemantics: { default: 'merged' },
    });
  });

  it('carries them for the default embedded store too, read-only when asked', () => {
    const built = publisherStoreConfig(DATA_DIR, config({}), true);
    expect(built).toMatchObject({
      backend: 'oxigraph-worker',
      options: { path: join(DATA_DIR, 'store.nq'), readOnly: true },
      readGraphs: { modes: { default: 'off' }, viewSemantics: { default: 'per-asset' } },
    });
  });

  it('refuses a query section with an offending key', () => {
    expect(() => publisherStoreConfig(DATA_DIR, config({ query: { readGraphs: 'on' as never } }))).toThrow(QueryConfigError);
  });
});
