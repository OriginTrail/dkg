import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
vi.mock('@origintrail-official/dkg-core', async () => {
  const actual = await vi.importActual<typeof import('@origintrail-official/dkg-core')>(
    '@origintrail-official/dkg-core',
  );
  return {
    ...actual,
    resolveDkgConfigHome: vi.fn((opts) => actual.resolveDkgConfigHome(opts)),
    resolveDkgHome: vi.fn((opts) => actual.resolveDkgHome(opts)),
  };
});
import { resolveDkgHome } from '@origintrail-official/dkg-core';
import { HermesAdapterPlugin } from '../src/HermesAdapterPlugin.js';
import { registerHermesRoutes } from '../src/hermes-routes.js';
import { HermesDkgClient, redact } from '../src/dkg-client.js';
import {
  disconnectHermesProfile,
  planHermesSetup,
  runDoctor,
  runDisconnect,
  runReconnect,
  resolveHermesProfile,
  runSetup,
  runUninstall,
  runVerify,
  setupHermesProfile,
  uninstallHermesProfile,
  verifyHermesProfile,
} from '../src/setup.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
import { createTrackingApi, trackingRes, type TrackingApi } from './hermes-adapter.shared';



describe('setup-entry.mjs', () => {


  it('skips runtime imports in setup-safe modes', async () => {
    const entry = await import('../setup-entry.mjs');
    const importRuntime = vi.fn(async () => {
      throw new Error('runtime import should be skipped');
    });

    for (const registrationMode of ['setup-only', 'cli-metadata'] as const) {
      const result = entry.default({
        registrationMode,
        _importRuntime: importRuntime,
        logger: { info: vi.fn() },
      });

      expect(result).toBeUndefined();
    }
    expect(importRuntime).not.toHaveBeenCalled();
  });

  it('lazy-loads the runtime plugin for daemon registration', async () => {
    const entry = await import('../setup-entry.mjs');
    const register = vi.fn(() => 'registered');
    let observedConfig: unknown;
    class FakePlugin {
      constructor(config: unknown) {
        observedConfig = config;
      }

      register = register;
    }
    const importRuntime = vi.fn(async () => ({ HermesAdapterPlugin: FakePlugin }));

    const result = await entry.default({
      _importRuntime: importRuntime,
      registerHttpRoute: vi.fn(),
      registerHook: vi.fn(),
      config: { hermes: { profileName: 'dev' } },
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(result).toBe('registered');
    expect(importRuntime).toHaveBeenCalledTimes(1);
    expect(observedConfig).toEqual({ profileName: 'dev' });
    expect(register).toHaveBeenCalledTimes(1);
  });

});
