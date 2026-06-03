import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureDkgNodeConfig } from '../src/ensure-dkg-node-config.js';

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
    ensureDkgNodeConfig({ agentName: 'node-a', network: NETWORK, apiPort: 9200, existing: {} });
    expect(readWritten().store).toEqual({ backend: 'oxigraph-server' });
  });

  it('does NOT flip an existing (block-less) node onto a new backend', () => {
    // Simulate an existing node: a config.json is already on disk (it had been
    // running on the oxigraph-worker runtime fallback). Re-running setup must
    // not silently switch its backend (which would force a store reset).
    writeFileSync(join(tempHome, 'config.json'), JSON.stringify({ name: 'node-a', nodeRole: 'edge' }) + '\n');
    ensureDkgNodeConfig({
      agentName: 'node-a',
      network: NETWORK,
      apiPort: 9200,
      existing: { name: 'node-a', nodeRole: 'edge' },
    });
    expect(readWritten().store).toBeUndefined();
  });

  it('preserves an explicit existing store block (even on a fresh write)', () => {
    const store = { backend: 'blazegraph', options: { url: 'http://localhost:9999/blazegraph' } };
    ensureDkgNodeConfig({ agentName: 'node-a', network: NETWORK, apiPort: 9200, existing: { store } });
    expect(readWritten().store).toEqual(store);
  });
});
