import { describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import {
  registerUpdateCommand,
  runDefaultUpdatePreflight,
  runMaintenanceUpdateWorkflow,
  type MaintenanceUpdateDoctorOps,
  type MaintenanceUpdatePreflightResult,
  type MaintenanceUpdateWorkflowDeps,
} from '../src/commands/maintenance.js';
import {
  fetchNpmDistTags,
  resolveExplicitNpmUpdateTarget,
  resolveLatestNpmVersion,
  resolveNpmDistTag,
  type NpmDistTagResult,
  type NpmRegistryFetch,
} from '../src/update/npm-registry.js';
import { UPDATE_PREFLIGHT_CHECKS } from '../src/doctor/policy.js';
import type { DoctorDeps, DoctorReport } from '../src/doctor/types.js';
import {
  loadProjectConfig,
  resolveAutoUpdateConfig,
  resolveAutoUpdateSource,
  type DkgConfig,
} from '../src/config.js';

describe('resolveExplicitNpmUpdateTarget', () => {
  const resolverReturning = (result: NpmDistTagResult) =>
    vi.fn(async () => result);

  it('allows an exact prerelease only when allowPrerelease=true', async () => {
    const resolve = resolverReturning({ status: 'not-found' });
    expect(await resolveExplicitNpmUpdateTarget('10.1.0-rc.1', true, {
      resolveNpmDistTag: resolve,
    })).toEqual({ status: 'allowed', version: '10.1.0-rc.1' });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('allows an exact stable version without a registry lookup', async () => {
    const resolve = resolverReturning({ status: 'not-found' });
    expect(await resolveExplicitNpmUpdateTarget('10.1.0', false, {
      resolveNpmDistTag: resolve,
    })).toEqual({ status: 'allowed', version: '10.1.0' });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('rejects an exact prerelease on a stable-only node', async () => {
    const result = await resolveExplicitNpmUpdateTarget('10.1.0-rc.1', false);
    expect(result.status).toBe('rejected');
  });

  it('pins a stable dist-tag to the concrete version that passed policy', async () => {
    const resolve = resolverReturning({ status: 'resolved', version: '10.0.0' });
    expect(await resolveExplicitNpmUpdateTarget('latest', false, {
      resolveNpmDistTag: resolve,
    })).toEqual({ status: 'allowed', version: '10.0.0' });
    expect(resolve).toHaveBeenCalledWith('latest');
  });

  it('uses the shared registry policy through one injected transport', async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ 'dist-tags': { latest: '10.0.2' } }),
    })) as NpmRegistryFetch;

    await expect(resolveExplicitNpmUpdateTarget('latest', false, { fetch }))
      .resolves.toEqual({ status: 'allowed', version: '10.0.2' });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('pins a prerelease dist-tag when prereleases are explicitly allowed', async () => {
    const resolve = resolverReturning({ status: 'resolved', version: '10.1.0-rc.1' });
    expect(await resolveExplicitNpmUpdateTarget('next', true, {
      resolveNpmDistTag: resolve,
    })).toEqual({ status: 'allowed', version: '10.1.0-rc.1' });
  });

  it('rejects a dist-tag resolving to a prerelease on a stable-only node', async () => {
    const resolve = resolverReturning({ status: 'resolved', version: '10.1.0-rc.1' });
    const result = await resolveExplicitNpmUpdateTarget('latest', false, {
      resolveNpmDistTag: resolve,
    });
    expect(result.status).toBe('rejected');
  });

  it('reports registry resolution errors separately and fails closed', async () => {
    const resolve = resolverReturning({
      status: 'error',
      failure: { kind: 'http-error', status: 503 },
    });
    const result = await resolveExplicitNpmUpdateTarget('latest', false, {
      resolveNpmDistTag: resolve,
    });
    expect(result.status).toBe('registry-error');
  });

  it.each(['nonexistent-tag', '=10.1.0-rc.1', '^10.0.0', 'npm:other-package@10.0.0'])(
    'rejects unresolved or non-exact npm target %s',
    async (target) => {
      const resolve = resolverReturning({ status: 'not-found' });
      const result = await resolveExplicitNpmUpdateTarget(target, false, {
        resolveNpmDistTag: resolve,
      });
      expect(result.status).toBe('rejected');
    },
  );
});

describe('resolveNpmDistTag registry boundary', () => {
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

    await expect(resolveNpmDistTag('next', {
      fetchNpmDistTags,
    })).resolves.toEqual({ status: 'resolved', version: '10.1.0-rc.1' });
    expect(fetchNpmDistTags).toHaveBeenCalledOnce();
  });

  it.each(['constructor', '__proto__'])(
    'rejects inherited Object property %s as an unknown tag',
    async (tag) => {
      const fetchNpmDistTags = vi.fn(async () => ({
        status: 'ok' as const,
        tags: { latest: '10.0.1' },
      }));

      await expect(resolveNpmDistTag(tag, {
        fetchNpmDistTags,
      })).resolves.toEqual({ status: 'not-found' });
    },
  );

  it('rejects a non-string own dist-tag value', async () => {
    const fetchNpmDistTags = vi.fn(async () => ({
      status: 'ok' as const,
      tags: { latest: 10_000_001 } as unknown as Record<string, string>,
    }));

    await expect(resolveNpmDistTag('latest', {
      fetchNpmDistTags,
    })).resolves.toEqual({ status: 'not-found' });
  });

  it.each(['constructor', '__proto__'])(
    'treats inherited Object property %s as a missing pinned channel',
    async (channel) => {
      const fetchNpmDistTags = vi.fn(async () => ({
        status: 'ok' as const,
        tags: { latest: '10.0.1' },
      }));

      await expect(resolveLatestNpmVersion(true, channel, {
        fetchNpmDistTags,
      })).resolves.toEqual({
        status: 'no-target',
        reason: { kind: 'missing-channel', channel },
      });
    },
  );
});

describe('dkg update doctor adapter', () => {
  const preflightDeps = {} as DoctorDeps;

  function doctorOps(
    runDoctor: MaintenanceUpdateDoctorOps['runDoctor'],
  ): MaintenanceUpdateDoctorOps {
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

describe('dkg update command stable-only wiring', () => {
  function commandHarness(
    resolvedTag: string | null = null,
    runPreflight = vi.fn(async (): Promise<MaintenanceUpdatePreflightResult> => ({
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
    const resolveTag = vi.fn(async (): Promise<NpmDistTagResult> => resolvedTag === null
      ? { status: 'not-found' }
      : { status: 'resolved', version: resolvedTag });
    const deps: MaintenanceUpdateWorkflowDeps = {
      loadConfig: vi.fn(async () => config),
      loadNetworkConfig: vi.fn(async () => null),
      loadResolvedNetworkConfig: vi.fn(async () => ({ name: 'testnet', network: null })),
      loadProjectConfig,
      resolveAutoUpdateConfig,
      resolveAutoUpdateSource,
      resolveStandaloneInstall: vi.fn(() => true),
      resolveExplicitNpmUpdateTarget: (target, allowPrerelease) =>
        resolveExplicitNpmUpdateTarget(target, allowPrerelease, {
          resolveNpmDistTag: resolveTag,
        }),
      checkForNpmVersionUpdate: vi.fn(async () => ({ status: 'up-to-date' })),
      performNpmUpdate,
      performNpmUpdateEdge,
      getCurrentCliVersion: () => '10.0.0',
      stopDaemonIfRunning: vi.fn(async () => true),
      runPreflight,
    };
    return { config, deps, performNpmUpdate, performNpmUpdateEdge, runPreflight };
  }

  it('refuses an explicit prerelease before dispatching either installer', async () => {
    const harness = commandHarness();
    const outcome = await runMaintenanceUpdateWorkflow({
      versionOrRef: '10.1.0-rc.1',
    }, harness.deps);
    expect(outcome.exitCode).toBe(1);
    expect(harness.performNpmUpdate).not.toHaveBeenCalled();
    expect(harness.performNpmUpdateEdge).not.toHaveBeenCalled();
  });

  it('refuses a dist-tag resolving to a prerelease before installer dispatch', async () => {
    const harness = commandHarness('10.1.0-rc.1');
    const outcome = await runMaintenanceUpdateWorkflow({
      versionOrRef: 'latest',
    }, harness.deps);
    expect(outcome.exitCode).toBe(1);
    expect(harness.performNpmUpdate).not.toHaveBeenCalled();
    expect(harness.performNpmUpdateEdge).not.toHaveBeenCalled();
  });

  it('installs the concrete stable version resolved from a mutable dist-tag', async () => {
    const harness = commandHarness('10.0.1');
    const outcome = await runMaintenanceUpdateWorkflow({
      versionOrRef: 'latest',
    }, harness.deps);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain(
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

  it('returns the real doctor adapter exit code and blocks installer dispatch', async () => {
    const preflightDeps = {} as DoctorDeps;
    const doctorOps: MaintenanceUpdateDoctorOps = {
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

    const outcome = await runMaintenanceUpdateWorkflow({
      versionOrRef: '10.0.1',
    }, harness.deps);
    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain('  • [install-layout] layout mismatch');
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
    harness.deps.performNpmUpdateEdge = installer;
    const writeStdout = vi.fn();

    const update = runMaintenanceUpdateWorkflow({
      versionOrRef: '10.0.1',
    }, harness.deps, { writeStdout });

    await vi.waitFor(() => expect(installer).toHaveBeenCalledOnce());
    expect(writeStdout).toHaveBeenCalledWith(
      'Updating to 10.0.1 via NPM (global npm install)...',
    );
    finishInstall('updated');
    await expect(update).resolves.toMatchObject({ exitCode: 0 });
  });

  it('emits failure diagnostics before setting the command exit code', async () => {
    const harness = commandHarness();
    harness.deps.performNpmUpdateEdge = vi.fn(async () => 'failed' as const);
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
    expect(setExitCode).toHaveBeenCalledWith(1);
    expect(writeStderr.mock.invocationCallOrder.at(-1))
      .toBeLessThan(setExitCode.mock.invocationCallOrder[0]);
  });

  it('lets --allow-prerelease override stable-only config through installer dispatch', async () => {
    const harness = commandHarness();
    const outcome = await runMaintenanceUpdateWorkflow({
      versionOrRef: '10.1.0-rc.1',
      allowPrerelease: true,
    }, harness.deps);
    expect(outcome.exitCode).toBe(0);
    expect(harness.performNpmUpdateEdge).toHaveBeenCalledWith(
      '10.1.0-rc.1',
      '10.0.0',
      expect.any(Function),
    );
  });

  it('routes fallback project configuration through the workflow boundary', async () => {
    const harness = commandHarness();
    const loadFallbackProject = vi.fn(() => ({
      repo: 'example/dkg',
      defaultBranch: 'release',
      githubUrl: 'https://github.com/example/dkg',
      projectName: 'dkg',
      syslogAppName: 'dkg',
      defaultNetwork: 'testnet',
    }));
    harness.deps.resolveAutoUpdateConfig = vi.fn(() => undefined);
    harness.deps.loadProjectConfig = loadFallbackProject;

    const outcome = await runMaintenanceUpdateWorkflow({
      versionOrRef: '10.0.1',
    }, harness.deps);

    expect(outcome.exitCode).toBe(0);
    expect(loadFallbackProject).toHaveBeenCalledOnce();
  });
});
