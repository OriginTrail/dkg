import { describe, expect, it, vi } from 'vitest';
import {
  runMaintenanceUpdateWorkflow,
  type MaintenanceUpdatePreflightResult,
  type MaintenanceUpdateWorkflowDeps,
} from '../src/commands/maintenance.js';
import {
  resolveExplicitNpmUpdateTarget,
  resolveNpmDistTag,
  type NpmVersionResult,
} from '../src/daemon/auto-update.js';
import {
  loadProjectConfig,
  resolveAutoUpdateConfig,
  resolveAutoUpdateSource,
  type DkgConfig,
} from '../src/config.js';

describe('resolveExplicitNpmUpdateTarget', () => {
  const log = () => {};
  const resolverReturning = (result: NpmVersionResult) =>
    vi.fn(async () => result);

  it('allows an exact prerelease only when allowPrerelease=true', async () => {
    const resolve = resolverReturning({ version: null });
    expect(await resolveExplicitNpmUpdateTarget('10.1.0-rc.1', true, log, {
      resolveNpmDistTag: resolve,
    })).toEqual({ status: 'allowed', version: '10.1.0-rc.1' });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('allows an exact stable version without a registry lookup', async () => {
    const resolve = resolverReturning({ version: null });
    expect(await resolveExplicitNpmUpdateTarget('10.1.0', false, log, {
      resolveNpmDistTag: resolve,
    })).toEqual({ status: 'allowed', version: '10.1.0' });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('rejects an exact prerelease on a stable-only node', async () => {
    const result = await resolveExplicitNpmUpdateTarget('10.1.0-rc.1', false, log);
    expect(result.status).toBe('rejected');
  });

  it('pins a stable dist-tag to the concrete version that passed policy', async () => {
    const resolve = resolverReturning({ version: '10.0.0' });
    expect(await resolveExplicitNpmUpdateTarget('latest', false, log, {
      resolveNpmDistTag: resolve,
    })).toEqual({ status: 'allowed', version: '10.0.0' });
    expect(resolve).toHaveBeenCalledWith('latest', log);
  });

  it('pins a prerelease dist-tag when prereleases are explicitly allowed', async () => {
    const resolve = resolverReturning({ version: '10.1.0-rc.1' });
    expect(await resolveExplicitNpmUpdateTarget('next', true, log, {
      resolveNpmDistTag: resolve,
    })).toEqual({ status: 'allowed', version: '10.1.0-rc.1' });
  });

  it('rejects a dist-tag resolving to a prerelease on a stable-only node', async () => {
    const resolve = resolverReturning({ version: '10.1.0-rc.1' });
    const result = await resolveExplicitNpmUpdateTarget('latest', false, log, {
      resolveNpmDistTag: resolve,
    });
    expect(result.status).toBe('rejected');
  });

  it('reports registry resolution errors separately and fails closed', async () => {
    const resolve = resolverReturning({ version: null, error: true });
    const result = await resolveExplicitNpmUpdateTarget('latest', false, log, {
      resolveNpmDistTag: resolve,
    });
    expect(result.status).toBe('registry-error');
  });

  it.each(['nonexistent-tag', '=10.1.0-rc.1', '^10.0.0', 'npm:other-package@10.0.0'])(
    'rejects unresolved or non-exact npm target %s',
    async (target) => {
      const resolve = resolverReturning({ version: null });
      const result = await resolveExplicitNpmUpdateTarget(target, false, log, {
        resolveNpmDistTag: resolve,
      });
      expect(result.status).toBe('rejected');
    },
  );
});

describe('resolveNpmDistTag registry boundary', () => {
  it('resolves only the requested tag through the injected registry gateway', async () => {
    const fetchNpmDistTags = vi.fn(async () => ({
      tags: { latest: '10.0.1', next: '10.1.0-rc.1' },
    }));

    await expect(resolveNpmDistTag('next', () => undefined, {
      fetchNpmDistTags,
    })).resolves.toEqual({ version: '10.1.0-rc.1' });
    expect(fetchNpmDistTags).toHaveBeenCalledOnce();
  });

  it.each(['constructor', '__proto__'])(
    'rejects inherited Object property %s as an unknown tag',
    async (tag) => {
      const fetchNpmDistTags = vi.fn(async () => ({
        tags: { latest: '10.0.1' },
      }));

      await expect(resolveNpmDistTag(tag, () => undefined, {
        fetchNpmDistTags,
      })).resolves.toEqual({ version: null, error: false });
    },
  );

  it('rejects a non-string own dist-tag value', async () => {
    const fetchNpmDistTags = vi.fn(async () => ({
      tags: { latest: 10_000_001 } as unknown as Record<string, string>,
    }));

    await expect(resolveNpmDistTag('latest', () => undefined, {
      fetchNpmDistTags,
    })).resolves.toEqual({ version: null, error: false });
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
    const resolveTag = vi.fn(async (): Promise<NpmVersionResult> => ({
      version: resolvedTag,
      error: false,
    }));
    const deps: MaintenanceUpdateWorkflowDeps = {
      loadConfig: vi.fn(async () => config),
      loadNetworkConfig: vi.fn(async () => null),
      loadResolvedNetworkConfig: vi.fn(async () => ({ name: 'testnet', network: null })),
      loadProjectConfig,
      resolveAutoUpdateConfig,
      resolveAutoUpdateSource,
      resolveStandaloneInstall: vi.fn(() => true),
      resolveExplicitNpmUpdateTarget: (target, allowPrerelease, log) =>
        resolveExplicitNpmUpdateTarget(target, allowPrerelease, log, {
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

  it('returns the preflight exit code and blocks installer dispatch', async () => {
    const runPreflight = vi.fn(async (): Promise<MaintenanceUpdatePreflightResult> => ({
      status: 'blocked',
      findings: [{ check: 'install-layout', message: 'layout mismatch' }],
    }));
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
