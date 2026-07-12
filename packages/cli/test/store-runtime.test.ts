import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveDaemonStoreBootPlan,
  type DaemonStoreBootDecision,
  type DaemonStoreBootPlan,
} from '../src/daemon/store-runtime.js';
import { saveConfig, type DkgConfig } from '../src/config.js';

function mk(overrides: Partial<DkgConfig> = {}): DkgConfig {
  return {
    name: 'dkg-node',
    apiPort: 9200,
    listenPort: 4001,
    nodeRole: 'edge',
    ...overrides,
  } as DkgConfig;
}

function expectBootable(
  decision: DaemonStoreBootDecision,
): asserts decision is DaemonStoreBootPlan {
  expect(decision.kind).toBe('bootable');
  if (decision.kind !== 'bootable') {
    throw new Error(`Expected a bootable store plan, got ${decision.kind}`);
  }
}

describe('resolveDaemonStoreBootPlan', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('keeps blockless operator config separate from the materialized daemon store default', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-store-runtime-'));
    const config = mk();

    const plan = resolveDaemonStoreBootPlan({
      config,
      dataDir,
      acceptStoreReset: false,
    });

    expectBootable(plan);
    expect(plan.operatorConfig).toBe(config);
    expect(plan.operatorConfig.store).toBeUndefined();
    expect(plan.effectiveConfig.store).toEqual({ backend: 'oxigraph-server', options: {} });
    expect(plan.effectiveStore).toEqual({ backend: 'oxigraph-server', options: {} });
  });

  it('does not persist the materialized store default during an unrelated config save', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-store-runtime-save-'));
    vi.stubEnv('DKG_HOME', dataDir);
    const plan = resolveDaemonStoreBootPlan({
      config: mk(),
      dataDir,
      acceptStoreReset: false,
    });

    expectBootable(plan);
    plan.operatorConfig.sharedMemoryTtlMs = 1234;
    await saveConfig(plan.operatorConfig);

    const persisted = JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf8')) as DkgConfig;
    expect(persisted.sharedMemoryTtlMs).toBe(1234);
    expect(persisted.store).toBeUndefined();
    expect(plan.effectiveConfig.store).toEqual({ backend: 'oxigraph-server', options: {} });
  });

  it('gates an oxigraph-server cutover when legacy store.nq exists without a backend marker', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-store-runtime-cutover-'));
    await writeFile(join(dataDir, 'store.nq'), '<s> <p> <o> .');

    const plan = resolveDaemonStoreBootPlan({
      config: mk({ store: { backend: 'oxigraph-server', options: {} } }),
      dataDir,
      acceptStoreReset: false,
    });

    expect(plan.kind).toBe('blocked-legacy-cutover');
    if (plan.kind !== 'blocked-legacy-cutover') {
      throw new Error(`Expected a blocked legacy cutover, got ${plan.kind}`);
    }
    expect(plan.message).toContain('DKG_ACCEPT_STORE_RESET=1');
  });

  it('does not repeatedly gate a cutover already recorded as oxigraph-server', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-store-runtime-recorded-'));
    await writeFile(join(dataDir, 'store.nq'), '<s> <p> <o> .');
    await writeFile(
      join(dataDir, '.network-state.json'),
      JSON.stringify({ chainResetMarker: null, lastBackend: 'oxigraph-server', savedAt: Date.now() }),
    );

    const plan = resolveDaemonStoreBootPlan({
      config: mk(),
      dataDir,
      acceptStoreReset: false,
    });

    expectBootable(plan);
    expect(plan.effectiveStore.backend).toBe('oxigraph-server');
  });

  it('migrates an explicit worker config only after acknowledging its legacy store', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-store-runtime-worker-'));
    await writeFile(join(dataDir, 'store.nq'), '<s> <p> <o> .');
    const config = mk({ store: { backend: 'oxigraph-worker' } });

    const blocked = resolveDaemonStoreBootPlan({ config, dataDir, acceptStoreReset: false });
    expect(blocked.kind).toBe('blocked-legacy-cutover');
    if (blocked.kind !== 'blocked-legacy-cutover') {
      throw new Error(`Expected a blocked legacy cutover, got ${blocked.kind}`);
    }
    expect(blocked.message).toContain('legacy store.nq from the old worker backend');

    const acknowledged = resolveDaemonStoreBootPlan({ config, dataDir, acceptStoreReset: true });
    expectBootable(acknowledged);
    expect(acknowledged.effectiveStore).toEqual({ backend: 'oxigraph-server', options: {} });
    expect(acknowledged.operatorConfig).toBe(config);
    expect(acknowledged.operatorConfig.store?.backend).toBe('oxigraph-worker');
  });

  it('classifies an explicit worker config without legacy data as invalid', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-store-runtime-invalid-worker-'));
    const config = mk({ store: { backend: 'oxigraph-worker' } });

    const decision = resolveDaemonStoreBootPlan({ config, dataDir, acceptStoreReset: false });

    expect(decision).toEqual({ kind: 'invalid-config', operatorConfig: config });
  });
});
