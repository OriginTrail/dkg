import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureDkgNodeConfig, readPersistedNetworkConfigName } from '../src/ensure-dkg-node-config.js';

// `dkgDir()` inside ensureDkgNodeConfig resolves via `resolveDkgConfigHome`,
// where an explicit `DKG_HOME` wins — so pointing it at a temp dir lets us
// assert the written config without touching the real `~/.dkg-dev`.
const NETWORK = { networkName: 'Test Net', defaultNodeRole: 'edge', defaultContextGraphs: [] as string[] };

describe('ensureDkgNodeConfig — store-backend default (issue #960)', () => {
  let tempHome: string;
  const originalEnv = process.env.DKG_HOME;

  beforeEach(() => {
    tempHome = join(tmpdir(), `dkg-ensure-cfg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempHome, { recursive: true });
    process.env.DKG_HOME = tempHome;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.DKG_HOME;
    else process.env.DKG_HOME = originalEnv;
    rmSync(tempHome, { recursive: true, force: true });
  });

  const readWritten = (): Record<string, any> =>
    JSON.parse(readFileSync(join(tempHome, 'config.json'), 'utf-8'));

  it('seeds the oxigraph-server default on a fresh install with no explicit store', () => {
    ensureDkgNodeConfig({ agentName: 'node-a', network: NETWORK, networkConfigName: 'testnet', apiPort: 9200, existing: {} });
    expect(readWritten().store).toEqual({ backend: 'oxigraph-server' });
  });

  it('persists the selected network as config.networkConfig', () => {
    ensureDkgNodeConfig({ agentName: 'node-a', network: NETWORK, networkConfigName: 'mainnet-gnosis', apiPort: 9200, existing: {} });
    expect(readWritten().networkConfig).toBe('mainnet-gnosis');
  });

  it('exposes KA lifecycle debug logging in fresh config and defaults it off', () => {
    ensureDkgNodeConfig({ agentName: 'node-a', network: NETWORK, networkConfigName: 'testnet', apiPort: 9200, existing: {} });
    expect(readWritten().logging).toEqual({ kaLifecycleDebug: false });
  });

  it('preserves an explicit KA lifecycle debug logging config', () => {
    ensureDkgNodeConfig({
      agentName: 'node-a',
      network: NETWORK,
      networkConfigName: 'testnet',
      apiPort: 9200,
      existing: { logging: { kaLifecycleDebug: true } },
    });
    expect(readWritten().logging).toEqual({ kaLifecycleDebug: true });
  });

  it('rewrites networkConfig to the selected value even when one already exists', () => {
    writeFileSync(
      join(tempHome, 'config.json'),
      JSON.stringify({ name: 'node-a', nodeRole: 'edge', networkConfig: 'testnet' }) + '\n',
    );
    ensureDkgNodeConfig({
      agentName: 'node-a',
      network: NETWORK,
      networkConfigName: 'mainnet-base',
      apiPort: 9200,
      existing: { name: 'node-a', nodeRole: 'edge', networkConfig: 'testnet' },
    });
    expect(readWritten().networkConfig).toBe('mainnet-base');
  });

  it('does NOT flip an existing (block-less) node onto a new backend', () => {
    // Simulate an existing node: a config.json is already on disk (it had been
    // running on the oxigraph-worker runtime fallback). Re-running setup must
    // not silently switch its backend (which would force a store reset).
    writeFileSync(join(tempHome, 'config.json'), JSON.stringify({ name: 'node-a', nodeRole: 'edge' }) + '\n');
    ensureDkgNodeConfig({
      agentName: 'node-a',
      network: NETWORK,
      networkConfigName: 'testnet',
      apiPort: 9200,
      existing: { name: 'node-a', nodeRole: 'edge' },
    });
    expect(readWritten().store).toBeUndefined();
  });

  it('treats a YAML-only existing node as existing (does NOT seed)', () => {
    // loadConfig / resolveDkgConfigHome accept config.yaml as a valid config, so
    // a YAML-only node must not be misclassified as fresh and flipped.
    writeFileSync(join(tempHome, 'config.yaml'), 'name: node-a\nnodeRole: edge\n');
    ensureDkgNodeConfig({
      agentName: 'node-a',
      network: NETWORK,
      networkConfigName: 'testnet',
      apiPort: 9200,
      existing: { name: 'node-a', nodeRole: 'edge' },
    });
    expect(readWritten().store).toBeUndefined();
  });

  it('preserves an explicit existing store block (even on a fresh write)', () => {
    const store = { backend: 'blazegraph', options: { url: 'http://localhost:9999/blazegraph' } };
    ensureDkgNodeConfig({ agentName: 'node-a', network: NETWORK, networkConfigName: 'testnet', apiPort: 9200, existing: { store } });
    expect(readWritten().store).toEqual(store);
  });
});

describe('readPersistedNetworkConfigName — JSON + YAML aware', () => {
  let tempHome: string;
  beforeEach(() => {
    tempHome = join(tmpdir(), `dkg-read-net-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempHome, { recursive: true });
  });
  afterEach(() => rmSync(tempHome, { recursive: true, force: true }));

  it('returns undefined when no config exists', () => {
    expect(readPersistedNetworkConfigName(tempHome)).toBeUndefined();
  });

  it('reads networkConfig from config.json', () => {
    writeFileSync(join(tempHome, 'config.json'), JSON.stringify({ networkConfig: 'mainnet-base' }));
    expect(readPersistedNetworkConfigName(tempHome)).toBe('mainnet-base');
  });

  it('reads networkConfig from a YAML-only node (the gap the review caught)', () => {
    writeFileSync(join(tempHome, 'config.yaml'), 'name: n\nnetworkConfig: mainnet-gnosis\n');
    expect(readPersistedNetworkConfigName(tempHome)).toBe('mainnet-gnosis');
  });

  it('prefers config.json over config.yaml when both exist', () => {
    writeFileSync(join(tempHome, 'config.json'), JSON.stringify({ networkConfig: 'testnet' }));
    writeFileSync(join(tempHome, 'config.yaml'), 'networkConfig: mainnet-base\n');
    expect(readPersistedNetworkConfigName(tempHome)).toBe('testnet');
  });

  it('returns undefined for an existing config that does not set networkConfig', () => {
    writeFileSync(join(tempHome, 'config.json'), JSON.stringify({ name: 'n', nodeRole: 'edge' }));
    expect(readPersistedNetworkConfigName(tempHome)).toBeUndefined();
  });
});
