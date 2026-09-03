import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { Command } from 'commander';
import {
  registerUpdateCommand,
  runManualUpdateWorkflow,
  type ManualUpdateDependencies,
} from '../src/commands/update.js';
import {
  applyManualUpdate,
  loadManualUpdateState,
  runDefaultUpdatePreflight,
  type ManualUpdateDoctorOps,
  type ManualUpdateInstallerOps,
  type ManualUpdatePreflightResult,
} from '../src/update/manual-update.js';
import {
  classifyNpmDistTag,
  fetchNpmDistTags,
  resolveExplicitNpmUpdateTarget,
  resolveNpmVersionTarget,
  resolveNpmDistTag,
  type NpmRegistryFetch,
  type NpmDistTagsResult,
} from '../src/update/npm-registry.js';
import type { NpmVersionStatus } from '../src/update/npm-version.js';
import { UPDATE_PREFLIGHT_CHECKS } from '../src/doctor/policy.js';
import type { DoctorDeps, DoctorReport } from '../src/doctor/types.js';
import { type DkgConfig, type NetworkConfig } from '../src/config.js';

describe('resolveExplicitNpmUpdateTarget', () => {
  const gatewayReturning = (result: NpmDistTagsResult) => vi.fn(async () => result);

  it('allows an exact prerelease only when allowPrerelease=true', async () => {
    const fetchNpmDistTags = gatewayReturning({ status: 'ok', tags: {} });
    expect(await resolveExplicitNpmUpdateTarget('10.1.0-rc.1', true, fetchNpmDistTags))
      .toEqual({ status: 'allowed', version: '10.1.0-rc.1' });
    expect(fetchNpmDistTags).not.toHaveBeenCalled();
  });

  it('allows an exact stable version without a registry lookup', async () => {
    const fetchNpmDistTags = gatewayReturning({ status: 'ok', tags: {} });
    expect(await resolveExplicitNpmUpdateTarget('10.1.0', false, fetchNpmDistTags))
      .toEqual({ status: 'allowed', version: '10.1.0' });
    expect(fetchNpmDistTags).not.toHaveBeenCalled();
  });

  it('rejects an exact prerelease on a stable-only node', async () => {
    const result = await resolveExplicitNpmUpdateTarget('10.1.0-rc.1', false);
    expect(result.status).toBe('rejected');
  });

  it('pins a stable dist-tag to the concrete version that passed policy', async () => {
    const fetchNpmDistTags = gatewayReturning({
      status: 'ok',
      tags: { latest: '10.0.0' },
    });
    expect(await resolveExplicitNpmUpdateTarget('latest', false, fetchNpmDistTags))
      .toEqual({ status: 'allowed', version: '10.0.0' });
    expect(fetchNpmDistTags).toHaveBeenCalledOnce();
  });

  it('uses the shared registry policy through one injected transport', async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ 'dist-tags': { latest: '10.0.2' } }),
    })) as NpmRegistryFetch;

    const loadDistTags = () => fetchNpmDistTags({ fetch });
    await expect(resolveExplicitNpmUpdateTarget('latest', false, loadDistTags))
      .resolves.toEqual({ status: 'allowed', version: '10.0.2' });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('pins a prerelease dist-tag when prereleases are explicitly allowed', async () => {
    const fetchNpmDistTags = gatewayReturning({
      status: 'ok',
      tags: { next: '10.1.0-rc.1' },
    });
    expect(await resolveExplicitNpmUpdateTarget('next', true, fetchNpmDistTags))
      .toEqual({ status: 'allowed', version: '10.1.0-rc.1' });
  });

  it('rejects a dist-tag resolving to a prerelease on a stable-only node', async () => {
    const fetchNpmDistTags = gatewayReturning({
      status: 'ok',
      tags: { latest: '10.1.0-rc.1' },
    });
    const result = await resolveExplicitNpmUpdateTarget('latest', false, fetchNpmDistTags);
    expect(result.status).toBe('rejected');
  });

  it('reports registry resolution errors separately and fails closed', async () => {
    const fetchNpmDistTags = gatewayReturning({
      status: 'error',
      failure: { kind: 'http-error', status: 503 },
    });
    const result = await resolveExplicitNpmUpdateTarget('latest', false, fetchNpmDistTags);
    expect(result.status).toBe('registry-error');
  });

  it.each(['nonexistent-tag', '=10.1.0-rc.1', '^10.0.0', 'npm:other-package@10.0.0'])(
    'rejects unresolved or non-exact npm target %s',
    async (target) => {
      const fetchNpmDistTags = gatewayReturning({ status: 'ok', tags: {} });
      const result = await resolveExplicitNpmUpdateTarget(target, false, fetchNpmDistTags);
      expect(result.status).toBe('rejected');
    },
  );
});

describe('resolveNpmDistTag registry boundary', () => {
  it('classifies missing, invalid, and validated tags through one pure boundary', () => {
    const tags = { latest: ' 10.0.1 ', broken: 'not-semver', numeric: 10_000_001 };
    expect(classifyNpmDistTag(tags, 'missing')).toEqual({ status: 'missing' });
    expect(classifyNpmDistTag(tags, 'broken')).toEqual({
      status: 'invalid',
      value: 'not-semver',
    });
    expect(classifyNpmDistTag(tags, 'numeric')).toEqual({
      status: 'invalid',
      value: 10_000_001,
    });
    expect(classifyNpmDistTag(tags, 'latest')).toEqual({
      status: 'resolved',
      version: '10.0.1',
    });
  });

  it('returns structured failures through an injected transport without daemon state', async () => {
    const fetch = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    })) as NpmRegistryFetch;

    await expect(fetchNpmDistTags({ fetch })).resolves.toEqual({
      status: 'error',
      failure: { kind: 'http-error', status: 503 },
    });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('registry.npmjs.org'),
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });

  it('resolves only the requested tag through the injected registry gateway', async () => {
    const fetchNpmDistTags = vi.fn(async () => ({
      status: 'ok' as const,
      tags: { latest: '10.0.1', next: '10.1.0-rc.1' },
    }));

    await expect(resolveNpmDistTag('next', fetchNpmDistTags))
      .resolves.toEqual({ status: 'resolved', version: '10.1.0-rc.1' });
    expect(fetchNpmDistTags).toHaveBeenCalledOnce();
  });

  it.each(['constructor', '__proto__'])(
    'rejects inherited Object property %s as an unknown tag',
    async (tag) => {
      const fetchNpmDistTags = vi.fn(async () => ({
        status: 'ok' as const,
        tags: { latest: '10.0.1' },
      }));

      await expect(resolveNpmDistTag(tag, fetchNpmDistTags))
        .resolves.toEqual({ status: 'missing' });
    },
  );

  it('rejects a non-string own dist-tag value', async () => {
    const fetchNpmDistTags = vi.fn(async () => ({
      status: 'ok' as const,
      tags: { latest: 10_000_001 } as unknown as Record<string, string>,
    }));

    await expect(resolveNpmDistTag('latest', fetchNpmDistTags))
      .resolves.toEqual({ status: 'invalid', value: 10_000_001 });
  });

  it.each(['constructor', '__proto__'])(
    'treats inherited Object property %s as a missing pinned channel',
    async (channel) => {
      const fetchNpmDistTags = vi.fn(async () => ({
        status: 'ok' as const,
        tags: { latest: '10.0.1' },
      }));

      await expect(resolveNpmVersionTarget(true, channel, fetchNpmDistTags)).resolves.toEqual({
        status: 'no-target',
        reason: { kind: 'missing-channel', channel },
      });
    },
  );
});

describe('dkg update doctor adapter', () => {
  const preflightDeps = {} as DoctorDeps;

  function doctorOps(
    runDoctor: ManualUpdateDoctorOps['runDoctor'],
  ): ManualUpdateDoctorOps {
    return {
      createProductionDeps: vi.fn(() => preflightDeps),
      runDoctor,
    };
  }

  it('runs exactly the update checks and maps doctor errors to a blocked preflight', async () => {
    const report = {
      exitCode: 2,
      findings: [
        {
          check: 'version-skew',
          severity: 'error',
          message: 'daemon and CLI differ',
          advisory: 'restart from the updated CLI',
        },
        { check: 'version-skew', severity: 'warning', message: 'secondary warning' },
      ],
    } as DoctorReport;
    const ops = doctorOps(vi.fn(async () => report));
    const config = { apiPort: 9321 } as DkgConfig;

    await expect(runDefaultUpdatePreflight(config, ops)).resolves.toEqual({
      status: 'blocked',
      findings: [{
        check: 'version-skew',
        message: 'daemon and CLI differ',
        advisory: 'restart from the updated CLI',
      }],
    });
    expect(ops.createProductionDeps).toHaveBeenCalledWith({ apiPort: 9321 });
    expect(ops.runDoctor).toHaveBeenCalledWith(preflightDeps, {
      checks: UPDATE_PREFLIGHT_CHECKS,
    });
  });

  it('returns the documented warning when doctor orchestration throws', async () => {
    const ops = doctorOps(vi.fn(async () => {
      throw new Error('doctor exploded');
    }));

    await expect(runDefaultUpdatePreflight({ apiPort: 9200 } as DkgConfig, ops))
      .resolves.toEqual({
        status: 'ok',
        warnings: [
          '[dkg update] WARNING: pre-flight doctor check crashed (doctor exploded); continuing without it.',
        ],
      });
  });
});

describe('manual update installer adapter', () => {
  const config = {
    name: 'installer-test',
    apiPort: 9200,
    listenPort: 0,
    nodeRole: 'edge',
  } as DkgConfig;

  function installerOps(
    edgeResult: 'updated' | 'failed',
    daemonStopped: boolean,
  ): ManualUpdateInstallerOps {
    return {
      applyCore: vi.fn(async () => edgeResult),
      applyEdge: vi.fn(async () => edgeResult),
      currentCliVersion: vi.fn(() => '10.0.0'),
      stopDaemon: vi.fn(async () => daemonStopped),
    };
  }

  it('does not stop the daemon after an installer failure', async () => {
    const ops = installerOps('failed', true);

    await expect(applyManualUpdate(config, '10.0.1', () => {}, ops))
      .resolves.toBe('failed');
    expect(ops.applyEdge).toHaveBeenCalledOnce();
    expect(ops.stopDaemon).not.toHaveBeenCalled();
  });

  it('surfaces daemon-stop failure after a successful install', async () => {
    const ops = installerOps('updated', false);

    await expect(applyManualUpdate(config, '10.0.1', () => {}, ops))
      .resolves.toBe('daemon-running');
    expect(ops.applyEdge).toHaveBeenCalledOnce();
    expect(ops.stopDaemon).toHaveBeenCalledOnce();
  });
});

describe('dkg update command stable-only wiring', () => {
  it('requires payloads for available and no-target update states', () => {
    expectTypeOf<{ status: 'available' }>().not.toMatchTypeOf<NpmVersionStatus>();
    expectTypeOf<{ status: 'no-target' }>().not.toMatchTypeOf<NpmVersionStatus>();
    expectTypeOf<{ status: 'available'; version: string }>()
      .toMatchTypeOf<NpmVersionStatus>();
    expectTypeOf<{ status: 'no-target'; channel: string }>()
      .toMatchTypeOf<NpmVersionStatus>();
  });

  const conflictingNetworkUpdatePolicy: NetworkConfig = {
    networkName: 'Testnet',
    genesisId: 'testnet-genesis',
    networkId: 'testnet',
    genesisVersion: 1,
    relays: [],
    defaultNodeRole: 'edge',
    autoUpdate: {
      enabled: true,
      source: 'git',
      repo: 'OriginTrail/dkg',
      branch: 'testnet-canary',
      checkIntervalMinutes: 30,
      allowPrerelease: true,
      channel: 'testnet',
    },
  };

  function commandHarness(
    resolvedTag: string | null = null,
    runPreflight = vi.fn(async (): Promise<ManualUpdatePreflightResult> => ({
      status: 'ok',
    })),
  ) {
    const config: DkgConfig = {
      name: 'update-test',
      apiPort: 9200,
      listenPort: 0,
      nodeRole: 'edge',
      autoUpdate: { enabled: true, source: 'npm', allowPrerelease: false },
    };
    const performNpmUpdate = vi.fn(async () => 'updated' as const);
    const performNpmUpdateEdge = vi.fn(async () => 'updated' as const);
    const reporter = {
      writeStdout: vi.fn(),
      writeStderr: vi.fn(),
    };
    const fetchNpmDistTags = vi.fn(async (): Promise<NpmDistTagsResult> => ({
      status: 'ok',
      tags: resolvedTag === null ? {} : { latest: resolvedTag },
    }));
    const installerOps: ManualUpdateInstallerOps = {
      applyCore: performNpmUpdate,
      applyEdge: performNpmUpdateEdge,
      currentCliVersion: () => '10.0.0',
      stopDaemon: vi.fn(async () => true),
    };
    const deps: ManualUpdateDependencies = {
      loadState: vi.fn(async () => ({
        config,
        context: {
          installMode: 'npm',
          allowPrerelease: false,
        },
      })),
      resolveExplicitTarget: (target, allowPrerelease) =>
        resolveExplicitNpmUpdateTarget(target, allowPrerelease, fetchNpmDistTags),
      checkForUpdate: vi.fn(async () => ({ status: 'up-to-date' })),
      runPreflight,
      applyUpdate: (updateConfig, version, log) =>
        applyManualUpdate(updateConfig, version, log, installerOps),
    };
    return {
      config,
      deps,
      performNpmUpdate,
      performNpmUpdateEdge,
      installerOps,
      reporter,
      runPreflight,
    };
  }

  it('refuses an explicit prerelease before dispatching either installer', async () => {
    const harness = commandHarness();
    const outcome = await runManualUpdateWorkflow({
      versionOrRef: '10.1.0-rc.1',
    }, harness.deps, harness.reporter);
    expect(outcome.exitCode).toBe(1);
    expect(harness.performNpmUpdate).not.toHaveBeenCalled();
    expect(harness.performNpmUpdateEdge).not.toHaveBeenCalled();
  });

  it('refuses a dist-tag resolving to a prerelease before installer dispatch', async () => {
    const harness = commandHarness('10.1.0-rc.1');
    const outcome = await runManualUpdateWorkflow({
      versionOrRef: 'latest',
    }, harness.deps, harness.reporter);
    expect(outcome.exitCode).toBe(1);
    expect(harness.performNpmUpdate).not.toHaveBeenCalled();
    expect(harness.performNpmUpdateEdge).not.toHaveBeenCalled();
  });

  it('installs the concrete stable version resolved from a mutable dist-tag', async () => {
    const harness = commandHarness('10.0.1');
    const outcome = await runManualUpdateWorkflow({
      versionOrRef: 'latest',
    }, harness.deps, harness.reporter);
    expect(outcome.exitCode).toBe(0);
    expect(harness.reporter.writeStdout).toHaveBeenCalledWith(
      'Update applied. Run "dkg start" to start with the new version.',
    );
    expect(harness.runPreflight).toHaveBeenCalledWith(harness.config);
    expect(harness.performNpmUpdate).not.toHaveBeenCalled();
    expect(harness.performNpmUpdateEdge).toHaveBeenCalledWith(
      '10.0.1',
      '10.0.0',
      expect.any(Function),
    );
    expect(harness.runPreflight.mock.invocationCallOrder[0])
      .toBeLessThan(harness.performNpmUpdateEdge.mock.invocationCallOrder[0]);
  });

  it('dispatches Core updates through the blue-green installer', async () => {
    const harness = commandHarness();
    harness.config.nodeRole = 'core';

    const outcome = await runManualUpdateWorkflow({
      versionOrRef: '10.0.1',
    }, harness.deps, harness.reporter);

    expect(outcome.exitCode).toBe(0);
    expect(harness.performNpmUpdate).toHaveBeenCalledWith(
      '10.0.1',
      expect.any(Function),
    );
    expect(harness.performNpmUpdateEdge).not.toHaveBeenCalled();
    expect(harness.reporter.writeStdout).toHaveBeenCalledWith(
      'Updating to 10.0.1 via NPM (blue-green slot)...',
    );
  });

  it('returns the real doctor adapter exit code and blocks installer dispatch', async () => {
    const preflightDeps = {} as DoctorDeps;
    const doctorOps: ManualUpdateDoctorOps = {
      createProductionDeps: vi.fn(() => preflightDeps),
      runDoctor: vi.fn(async () => ({
        exitCode: 2,
        findings: [{
          check: 'install-layout',
          severity: 'error',
          message: 'layout mismatch',
        }],
      } as DoctorReport)),
    };
    const runPreflight = vi.fn((config: DkgConfig) =>
      runDefaultUpdatePreflight(config, doctorOps));
    const harness = commandHarness(null, runPreflight);

    const outcome = await runManualUpdateWorkflow({
      versionOrRef: '10.0.1',
    }, harness.deps, harness.reporter);
    expect(outcome.exitCode).toBe(2);
    expect(harness.reporter.writeStderr)
      .toHaveBeenCalledWith('  • [install-layout] layout mismatch');
    expect(runPreflight).toHaveBeenCalledWith(harness.config);
    expect(harness.performNpmUpdate).not.toHaveBeenCalled();
    expect(harness.performNpmUpdateEdge).not.toHaveBeenCalled();
  });

  it('streams progress before a pending installer resolves', async () => {
    const harness = commandHarness();
    let finishInstall!: (status: 'updated') => void;
    const pendingInstall = new Promise<'updated'>((resolve) => {
      finishInstall = resolve;
    });
    const installer = vi.fn(() => pendingInstall);
    harness.installerOps.applyEdge = installer;
    const writeStdout = vi.fn();
    const writeStderr = vi.fn();

    const update = runManualUpdateWorkflow({
      versionOrRef: '10.0.1',
    }, harness.deps, { writeStdout, writeStderr });

    await vi.waitFor(() => expect(installer).toHaveBeenCalledOnce());
    expect(writeStdout).toHaveBeenCalledWith(
      'Updating to 10.0.1 via NPM (global npm install)...',
    );
    finishInstall('updated');
    await expect(update).resolves.toMatchObject({ exitCode: 0 });
  });

  it('emits failure diagnostics before setting the command exit code', async () => {
    const harness = commandHarness();
    harness.installerOps.applyEdge = vi.fn(async () => 'failed' as const);
    const writeStdout = vi.fn();
    const writeStderr = vi.fn();
    const setExitCode = vi.fn();
    const program = new Command().name('dkg');
    registerUpdateCommand(program, harness.deps, {
      writeStdout,
      writeStderr,
      setExitCode,
    });

    await program.parseAsync(['node', 'dkg', 'update', '10.0.1']);

    expect(writeStderr).toHaveBeenCalledWith('Update failed. Check logs and retry.');
    expect(harness.installerOps.stopDaemon).not.toHaveBeenCalled();
    expect(setExitCode).toHaveBeenCalledWith(1);
    expect(writeStderr.mock.invocationCallOrder.at(-1))
      .toBeLessThan(setExitCode.mock.invocationCallOrder[0]);
  });

  it('reports a successful install whose old daemon could not be stopped', async () => {
    const harness = commandHarness();
    harness.installerOps.stopDaemon = vi.fn(async () => false);

    const outcome = await runManualUpdateWorkflow({
      versionOrRef: '10.0.1',
    }, harness.deps, harness.reporter);

    expect(outcome).toEqual({ exitCode: 1 });
    expect(harness.performNpmUpdateEdge).toHaveBeenCalledOnce();
    expect(harness.installerOps.stopDaemon).toHaveBeenCalledOnce();
    expect(harness.reporter.writeStderr).toHaveBeenCalledWith(
      'Update applied but old daemon is still running. Stop it manually and run "dkg start".',
    );
  });

  it('lets --allow-prerelease override stable-only config through installer dispatch', async () => {
    const harness = commandHarness();
    const outcome = await runManualUpdateWorkflow({
      versionOrRef: '10.1.0-rc.1',
      allowPrerelease: true,
    }, harness.deps, harness.reporter);
    expect(outcome.exitCode).toBe(0);
    expect(harness.performNpmUpdateEdge).toHaveBeenCalledWith(
      '10.1.0-rc.1',
      '10.0.0',
      expect.any(Function),
    );
  });

  it('uses the resolved manual-update context as one workflow boundary', async () => {
    const harness = commandHarness();
    harness.deps.loadState = vi.fn(async () => ({
      config: harness.config,
      context: {
        installMode: 'npm',
        allowPrerelease: false,
        channel: 'mainnet',
      },
    }));

    const outcome = await runManualUpdateWorkflow({
      check: true,
    }, harness.deps, harness.reporter);

    expect(outcome.exitCode).toBe(0);
    expect(harness.deps.checkForUpdate).toHaveBeenCalledWith(
      expect.any(Function),
      false,
      'mainnet',
    );
  });

  it('preserves disabled local npm and stable-only policy through the real state adapter', async () => {
    const harness = commandHarness();
    const localConfig: DkgConfig = {
      ...harness.config,
      networkConfig: 'testnet',
      autoUpdate: {
        enabled: false,
        source: 'npm',
        allowPrerelease: false,
        channel: 'mainnet',
      },
    };
    const resolveInstallMode = vi.fn((source?: 'auto' | 'npm' | 'git' | 'monorepo') =>
      source === 'npm');
    harness.deps.loadState = () => loadManualUpdateState({
      loadConfig: async () => localConfig,
      loadNetworkConfig: async () => conflictingNetworkUpdatePolicy,
      resolveInstallMode,
    });

    const outcome = await runManualUpdateWorkflow({
      versionOrRef: '10.1.0-rc.1',
    }, harness.deps, harness.reporter);

    expect(outcome).toEqual({ exitCode: 1 });
    expect(resolveInstallMode).toHaveBeenCalledWith('npm');
    expect(harness.performNpmUpdate).not.toHaveBeenCalled();
    expect(harness.performNpmUpdateEdge).not.toHaveBeenCalled();
  });

  it('passes the real disabled-local channel policy to check-only registry lookup', async () => {
    const harness = commandHarness();
    const localConfig: DkgConfig = {
      ...harness.config,
      networkConfig: 'testnet',
      autoUpdate: {
        enabled: false,
        source: 'npm',
        allowPrerelease: false,
        channel: 'mainnet',
      },
    };
    harness.deps.loadState = () => loadManualUpdateState({
      loadConfig: async () => localConfig,
      loadNetworkConfig: async () => conflictingNetworkUpdatePolicy,
      resolveInstallMode: () => true,
    });

    await expect(runManualUpdateWorkflow({ check: true }, harness.deps, harness.reporter))
      .resolves.toEqual({ exitCode: 0 });
    expect(harness.deps.checkForUpdate).toHaveBeenCalledWith(
      expect.any(Function),
      false,
      'mainnet',
    );
  });
});
