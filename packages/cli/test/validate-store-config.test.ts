/**
 * `validateStoreConfig` enforces the extra requirements that external
 * triple-store backends impose:
 *
 *   - blazegraph requires `store.options.url`.
 *   - sparql-http requires `store.options.queryEndpoint`.
 *   - largeLiteralStorage/snapshot storage requires explicit `directory`
 *     when paired with an external backend (no local store path to
 *     infer from).
 *
 * Embedded local backends are unaffected. Managed Oxigraph additionally
 * validates memory-limit values and platform support before startup.
 *
 * Plan: `.cursor/plans/blazegraph_v10_support_178da670.plan.md` §PR 1 item 6.
 */
import { describe, it, expect } from 'vitest';
import { validateStoreConfig, type DkgConfig } from '../src/config.js';

function mk(overrides: Partial<DkgConfig> = {}): DkgConfig {
  return {
    name: 'dkg-node',
    apiPort: 9200,
    listenPort: 4001,
    ...overrides,
  } as DkgConfig;
}

describe('validateStoreConfig', () => {
  it.each(['darwin', 'win32'] as const)('rejects managed memory limits before startup on %s', (platform) => {
    const config = mk({ store: { backend: 'oxigraph-server', options: { memoryMaxMiB: 1024 } } });
    expect(validateStoreConfig(config, platform)[0].message).toContain('require Linux');
  });
  it('accepts valid Linux limits and unrestricted macOS stores', () => {
    expect(validateStoreConfig(mk({ store: { backend: 'oxigraph-server', options: { memoryHighMiB: 512, memoryMaxMiB: 1024 } } }), 'linux')).toEqual([]);
    expect(validateStoreConfig(mk({ store: { backend: 'oxigraph-server' } }), 'darwin')).toEqual([]);
  });
  it.each([0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid max memory %s on Linux', (memoryMaxMiB) => {
    expect(validateStoreConfig(mk({ store: { backend: 'oxigraph-server', options: { memoryMaxMiB } } }), 'linux')).not.toEqual([]);
  });

  describe('default (no store block)', () => {
    it('returns no errors when store is undefined', () => {
      expect(validateStoreConfig(mk())).toEqual([]);
    });
  });

  describe('local backends', () => {
    it('no-op for oxigraph-worker', () => {
      expect(
        validateStoreConfig(mk({ store: { backend: 'oxigraph-worker' } })),
      ).toEqual([]);
    });

    it('ignores stray external-shaped options on a local backend', () => {
      // An operator's leftover options field should not trip validation
      // if the backend is local; the wipe + health check honour
      // isExternalBackend the same way.
      const errors = validateStoreConfig(
        mk({ store: { backend: 'oxigraph-worker', options: { url: 'irrelevant' } } }),
      );
      expect(errors).toEqual([]);
    });
  });

  describe('blazegraph', () => {
    it('errors when options.url is missing', () => {
      const errors = validateStoreConfig(mk({ store: { backend: 'blazegraph' } }));
      expect(errors).toHaveLength(1);
      expect(errors[0].field).toBe('store.options.url');
      expect(errors[0].message).toMatch(/store\.options\.url/);
    });

    it('errors when options.url is empty / whitespace', () => {
      const errors = validateStoreConfig(
        mk({ store: { backend: 'blazegraph', options: { url: '  ' } } }),
      );
      expect(errors).toHaveLength(1);
      expect(errors[0].field).toBe('store.options.url');
    });

    it('passes with a non-empty url', () => {
      const errors = validateStoreConfig(
        mk({
          store: {
            backend: 'blazegraph',
            options: { url: 'http://127.0.0.1:9999/bigdata/namespace/x/sparql' },
          },
        }),
      );
      expect(errors).toEqual([]);
    });
  });

  describe('sparql-http', () => {
    it('errors when queryEndpoint is missing', () => {
      const errors = validateStoreConfig(
        mk({ store: { backend: 'sparql-http', options: {} } }),
      );
      expect(errors).toHaveLength(1);
      expect(errors[0].field).toBe('store.options.queryEndpoint');
    });

    it('passes with a queryEndpoint', () => {
      const errors = validateStoreConfig(
        mk({
          store: {
            backend: 'sparql-http',
            options: { queryEndpoint: 'http://server.test/query' },
          },
        }),
      );
      expect(errors).toEqual([]);
    });
  });

  describe('largeLiteralStorage', () => {
    it('errors when enabled with external backend but no directory', () => {
      const errors = validateStoreConfig(
        mk({
          store: { backend: 'blazegraph', options: { url: 'http://x/sparql' } },
          largeLiteralStorage: { enabled: true },
        }),
      );
      expect(errors).toHaveLength(1);
      expect(errors[0].field).toBe('largeLiteralStorage.directory');
    });

    it('passes when external + enabled + directory set', () => {
      const errors = validateStoreConfig(
        mk({
          store: { backend: 'blazegraph', options: { url: 'http://x/sparql' } },
          largeLiteralStorage: { enabled: true, directory: '/var/lib/dkg/blobs' },
        }),
      );
      expect(errors).toEqual([]);
    });

    it('does not error when external but largeLiteralStorage is disabled', () => {
      const errors = validateStoreConfig(
        mk({
          store: { backend: 'blazegraph', options: { url: 'http://x/sparql' } },
          largeLiteralStorage: { enabled: false },
        }),
      );
      expect(errors).toEqual([]);
    });

    it('does not enforce the directory requirement for local backends', () => {
      const errors = validateStoreConfig(
        mk({
          store: { backend: 'oxigraph-worker' },
          largeLiteralStorage: { enabled: true },
        }),
      );
      expect(errors).toEqual([]);
    });
  });

  describe('sharedMemoryPublicSnapshotStorage', () => {
    it('errors when external + enabled + missing directory', () => {
      const errors = validateStoreConfig(
        mk({
          store: { backend: 'blazegraph', options: { url: 'http://x/sparql' } },
          sharedMemoryPublicSnapshotStorage: { enabled: true },
        }),
      );
      expect(errors).toHaveLength(1);
      expect(errors[0].field).toBe('sharedMemoryPublicSnapshotStorage.directory');
    });

    it('passes when explicit directory set', () => {
      const errors = validateStoreConfig(
        mk({
          store: { backend: 'blazegraph', options: { url: 'http://x/sparql' } },
          sharedMemoryPublicSnapshotStorage: {
            enabled: true,
            directory: '/var/lib/dkg/snapshots',
          },
        }),
      );
      expect(errors).toEqual([]);
    });
  });

  describe('multi-error aggregation', () => {
    it('reports every problem in one pass, not first-fail', () => {
      const errors = validateStoreConfig(
        mk({
          store: { backend: 'blazegraph', options: {} }, // missing url
          largeLiteralStorage: { enabled: true }, // missing directory
          sharedMemoryPublicSnapshotStorage: { enabled: true }, // missing directory
        }),
      );
      expect(errors).toHaveLength(3);
      const fields = errors.map((e) => e.field).sort();
      expect(fields).toEqual([
        'largeLiteralStorage.directory',
        'sharedMemoryPublicSnapshotStorage.directory',
        'store.options.url',
      ]);
    });
  });
});
