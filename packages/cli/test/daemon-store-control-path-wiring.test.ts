/**
 * OT-RFC-73 P14 wiring guard: `runDaemonInner` gives the store control path the configured backend and
 * `store.controlReservedSlots` before any store call can build the path, and logs the resulting geometry with the
 * setting that decided it. The resolution itself is covered in the storage package; this locks the one line between
 * them, which neither sees: a daemon that configured the path late (or not at all) would keep every other test green
 * and leave Blazegraph and managed Oxigraph nodes on today's lanes.
 *
 * Pattern: the shared mocked lifecycle fixture. The external store's reachability probe (the first store contact of
 * the boot) and `DKGAgent.create` (which builds the agent's store) are mocked and record the path as they see it.
 */
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  STORE_CONTROL_RESERVED_SLOTS_ENV,
  configureStoreControlPath,
  createManagedOxigraphRuntimeStoreConfigV1,
  describeStoreControlPath,
  getStoreControlPath,
  setStoreControlPathForTesting,
} from '@origintrail-official/dkg-storage';
import { daemonWiringMocks as mocks, installDaemonLifecycleWiringFixture } from './helpers/daemon-lifecycle-wiring.js';

const BLAZEGRAPH = { backend: 'blazegraph', options: { url: 'http://127.0.0.1:9999/blazegraph/namespace/kb/sparql' } };
const MANAGED = { backend: 'oxigraph-server', options: {} };
const SPARQL_HTTP = { backend: 'sparql-http', options: { queryEndpoint: 'http://127.0.0.1:7200/sparql', updateEndpoint: 'http://127.0.0.1:7200/update' } };
const OXIGRAPH_QUERY = 'http://127.0.0.1:7878/query';
const geometryLines = (lines: string[]) => lines.join('').split('\n').filter((line) => /Store control path: (on|off) \(/.test(line));

describe('runDaemonInner configures the store control path before the store is used', () => {
  const fixture = installDaemonLifecycleWiringFixture();

  beforeEach(() => {
    setStoreControlPathForTesting(undefined);
    vi.stubEnv(STORE_CONTROL_RESERVED_SLOTS_ENV, undefined);
  });
  afterEach(() => {
    setStoreControlPathForTesting(undefined);
    vi.unstubAllEnvs();
  });

  /** A managed Oxigraph server as the daemon starts it: the persisted backend stays `oxigraph-server`, the runtime is sparql-http. */
  function startManagedOxigraph() {
    mocks.startManagedOxigraph.mockResolvedValueOnce({
      handle: {
        queryEndpoint: OXIGRAPH_QUERY,
        updateEndpoint: 'http://127.0.0.1:7878/update',
        getRecoveryState: () => ({ recovering: false }),
        registerStoreActivity: () => ({ report: () => undefined, dispose: () => undefined }),
        killSync: vi.fn(),
      },
      storeConfig: createManagedOxigraphRuntimeStoreConfigV1({
        backend: 'sparql-http',
        options: { queryEndpoint: OXIGRAPH_QUERY, updateEndpoint: 'http://127.0.0.1:7878/update', managedByDkg: true },
        graphSetIndex: true,
      }),
      largeLiteralStorage: { enabled: true, directory: join(fixture.tempHome!, 'literal-blobs') },
    });
  }

  /** Boot with `store`; returns the logged geometry line and the path as the first store contact and the agent saw it. */
  async function boot(store: Record<string, unknown> | undefined) {
    // Each boot starts from clean mocks and output, also when one test boots twice.
    mocks.agentCreate.mockReset();
    mocks.agentCreate.mockRejectedValue(new Error('after-agent-create'));
    fixture.stdoutLines.length = 0;
    if (store?.backend === 'oxigraph-server') startManagedOxigraph();
    const seen: { probe?: string; agent?: string } = {};
    mocks.checkExternalStoreReachable.mockReset();
    mocks.checkExternalStoreReachable.mockImplementation(async () => {
      seen.probe = describeStoreControlPath();
      return { ok: true, backend: 'sparql-http', endpoint: OXIGRAPH_QUERY };
    });
    await fixture.captureCreateArg(store ? { store } : {}, async () => { seen.agent = describeStoreControlPath(); });
    const lines = geometryLines(fixture.stdoutLines);
    expect(lines).toHaveLength(1);
    return { line: lines[0].replace(/^\[[^\]]+\] /, ''), seen, output: fixture.stdoutLines.join('') };
  }

  it('turns the path on by default for Blazegraph on more than 2 CPUs, before the first store contact', async () => {
    const cpus = availableParallelism();
    const { line, seen } = await boot(BLAZEGRAPH);
    expect(line).toBe(cpus > 2
      ? `Store control path: on (added slots share=1 publisher=2; default for blazegraph, ${cpus} CPUs; effective until daemon restart)`
      : `Store control path: off (added slots share=0 publisher=0; default: 2 CPUs or fewer (blazegraph, ${cpus} CPUs); effective until daemon restart)`);
    // Configured before anything touched the store: the boot's first store contact and the agent saw the same path.
    expect(seen.probe).toBe(line);
    expect(seen.agent).toBe(line);
    expect(Object.keys(getStoreControlPath())).toEqual(cpus > 2 ? ['share', 'publisher'] : []);
  });

  it('turns it on by default for managed oxigraph-server on more than 2 CPUs (its configured name, not the runtime sparql-http view)', async () => {
    const cpus = availableParallelism();
    const managed = await boot(MANAGED);
    expect(managed.line).toBe(cpus > 2
      ? `Store control path: on (added slots share=1 publisher=2; default for oxigraph-server, ${cpus} CPUs; effective until daemon restart)`
      : `Store control path: off (added slots share=0 publisher=0; default: 2 CPUs or fewer (oxigraph-server, ${cpus} CPUs); `
        + 'effective until daemon restart)');
    expect(managed.seen.probe).toBe(managed.line);
    expect(managed.seen.agent).toBe(managed.line);
    expect(Object.keys(getStoreControlPath())).toEqual(cpus > 2 ? ['share', 'publisher'] : []);
  });

  it('keeps it off by default for a generic sparql-http store', async () => {
    const generic = await boot(SPARQL_HTTP);
    expect(generic.line).toBe(
      'Store control path: off (added slots share=0 publisher=0; default for sparql-http; effective until daemon restart)',
    );
    expect(generic.seen.probe).toBe(generic.line);
    expect(getStoreControlPath()).toEqual({});
  });

  it('keeps it off by default for a node without a store block (embedded oxigraph-worker)', async () => {
    expect((await boot(undefined)).line).toBe(
      'Store control path: off (added slots share=0 publisher=0; default for oxigraph-worker; '
      + 'the embedded oxigraph-worker store never uses it; effective until daemon restart)',
    );
  });

  it.each([['Blazegraph', BLAZEGRAPH], ['managed oxigraph-server', MANAGED]] as const)(
    'lets store.controlReservedSlots turn the path off where the default is on (%s)',
    async (_name, store) => {
      const off = await boot({ ...store, controlReservedSlots: 0 });
      expect(off.line).toBe(
        'Store control path: off (added slots share=0 publisher=0; config store.controlReservedSlots=0; effective until daemon restart)',
      );
      expect(off.seen.probe).toBe(off.line);
      expect(getStoreControlPath()).toEqual({});
    },
  );

  it('lets store.controlReservedSlots turn the path on where the default is off', async () => {
    const on = await boot({ ...SPARQL_HTTP, controlReservedSlots: 'share:1,publisher:2' });
    expect(on.line).toBe(
      'Store control path: on (added slots share=1 publisher=2; config store.controlReservedSlots=share:1,publisher:2; '
      + 'effective until daemon restart)',
    );
  });

  it('lets the environment variable override the config', async () => {
    vi.stubEnv(STORE_CONTROL_RESERVED_SLOTS_ENV, '0');
    const { line } = await boot({ ...BLAZEGRAPH, controlReservedSlots: 'share:1,publisher:2' });
    expect(line).toBe(
      'Store control path: off (added slots share=0 publisher=0; DKG_STORE_CONTROL_RESERVED_SLOTS=0, '
      + 'over config store.controlReservedSlots; effective until daemon restart)',
    );
  });

  it('logs a malformed config value as refused and leaves the path off', async () => {
    const { line, output } = await boot({ ...BLAZEGRAPH, controlReservedSlots: 'share:1;publisher:2' });
    expect(output).toContain('Invalid config store.controlReservedSlots="share:1;publisher:2"');
    expect(line).toBe(
      'Store control path: off (added slots share=0 publisher=0; config store.controlReservedSlots refused as malformed; '
      + 'effective until daemon restart)',
    );
    expect(getStoreControlPath()).toEqual({});
  });

  it('refuses, loudly, a configuration that comes after the path was built', async () => {
    const first = await boot({ ...BLAZEGRAPH, controlReservedSlots: 0 });
    const warn = vi.fn();
    expect(configureStoreControlPath({ backend: 'blazegraph' }, { warn })).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('configuration refused, the path was already built');

    // A second boot in the same process with other settings cannot change the path either: its log says so.
    const second = await boot(BLAZEGRAPH);
    expect(second.output).toContain('Store control path: configuration refused, the path was already built '
      + '(config store.controlReservedSlots=0). Backend blazegraph and store.controlReservedSlots absent take effect only after a restart.');
    expect(second.line).toBe(first.line);
  });
});
