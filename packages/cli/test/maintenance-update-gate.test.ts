import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { registerMaintenanceCommands } from '../src/commands/maintenance.js';
import { resolveExplicitNpmUpdateTarget } from '../src/daemon/auto-update.js';

describe('resolveExplicitNpmUpdateTarget', () => {
  const log = () => {};
  const resolverReturning = (ret: { version: string | null; error?: boolean }) =>
    vi.fn(async () => ret);

  it('allows an exact prerelease only when allowPrerelease=true', async () => {
    const resolve = resolverReturning({ version: null });
    expect(await resolveExplicitNpmUpdateTarget('10.1.0-rc.1', true, log, {
      resolveLatestNpmVersion: resolve,
    })).toEqual({ status: 'allowed', version: '10.1.0-rc.1' });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('allows an exact stable version without a registry lookup', async () => {
    const resolve = resolverReturning({ version: null });
    expect(await resolveExplicitNpmUpdateTarget('10.1.0', false, log, {
      resolveLatestNpmVersion: resolve,
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
      resolveLatestNpmVersion: resolve,
    })).toEqual({ status: 'allowed', version: '10.0.0' });
    expect(resolve).toHaveBeenCalledWith(log, true, 'latest');
  });

  it('pins a prerelease dist-tag when prereleases are explicitly allowed', async () => {
    const resolve = resolverReturning({ version: '10.1.0-rc.1' });
    expect(await resolveExplicitNpmUpdateTarget('next', true, log, {
      resolveLatestNpmVersion: resolve,
    })).toEqual({ status: 'allowed', version: '10.1.0-rc.1' });
  });

  it('rejects a dist-tag resolving to a prerelease on a stable-only node', async () => {
    const resolve = resolverReturning({ version: '10.1.0-rc.1' });
    const result = await resolveExplicitNpmUpdateTarget('latest', false, log, {
      resolveLatestNpmVersion: resolve,
    });
    expect(result.status).toBe('rejected');
  });

  it('reports registry resolution errors separately and fails closed', async () => {
    const resolve = resolverReturning({ version: null, error: true });
    const result = await resolveExplicitNpmUpdateTarget('latest', false, log, {
      resolveLatestNpmVersion: resolve,
    });
    expect(result.status).toBe('registry-error');
  });

  it.each(['nonexistent-tag', '=10.1.0-rc.1', '^10.0.0', 'npm:other-package@10.0.0'])(
    'rejects unresolved or non-exact npm target %s',
    async (target) => {
      const resolve = resolverReturning({ version: null });
      const result = await resolveExplicitNpmUpdateTarget(target, false, log, {
        resolveLatestNpmVersion: resolve,
      });
      expect(result.status).toBe('rejected');
    },
  );
});

describe('dkg update command stable-only wiring', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function commandHarness(resolvedTag: string | null = null) {
    const performNpmUpdate = vi.fn(async () => 'updated' as const);
    const performNpmUpdateEdge = vi.fn(async () => 'updated' as const);
    const resolveTag = vi.fn(async () => ({ version: resolvedTag, error: false as const }));
    const program = new Command();
    program.exitOverride();
    registerMaintenanceCommands(program, {
      loadConfig: vi.fn(async () => ({
        nodeRole: 'edge',
        apiPort: 9200,
        autoUpdate: { enabled: true, source: 'npm', allowPrerelease: false },
      })) as any,
      loadNetworkConfig: vi.fn() as any,
      loadResolvedNetworkConfig: vi.fn(async () => ({ network: undefined })) as any,
      resolveStandaloneInstall: vi.fn(() => true) as any,
      resolveExplicitNpmUpdateTarget: (target, allowPrerelease, log) =>
        resolveExplicitNpmUpdateTarget(target, allowPrerelease, log, {
          resolveLatestNpmVersion: resolveTag,
        }),
      checkForNpmVersionUpdate: vi.fn() as any,
      performNpmUpdate,
      performNpmUpdateEdge,
      getCurrentCliVersion: () => '10.0.0',
      stopDaemonIfRunning: vi.fn(async () => true),
      runPreflight: vi.fn(async () => undefined),
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
    return { program, performNpmUpdate, performNpmUpdateEdge };
  }

  it('refuses an explicit prerelease before dispatching either installer', async () => {
    const harness = commandHarness();
    await expect(harness.program.parseAsync([
      'node', 'dkg', 'update', '10.1.0-rc.1',
    ])).rejects.toThrow('process.exit:1');
    expect(harness.performNpmUpdate).not.toHaveBeenCalled();
    expect(harness.performNpmUpdateEdge).not.toHaveBeenCalled();
  });

  it('refuses a dist-tag resolving to a prerelease before installer dispatch', async () => {
    const harness = commandHarness('10.1.0-rc.1');
    await expect(harness.program.parseAsync([
      'node', 'dkg', 'update', 'latest',
    ])).rejects.toThrow('process.exit:1');
    expect(harness.performNpmUpdate).not.toHaveBeenCalled();
    expect(harness.performNpmUpdateEdge).not.toHaveBeenCalled();
  });

  it('installs the concrete stable version resolved from a mutable dist-tag', async () => {
    const harness = commandHarness('10.0.1');
    await harness.program.parseAsync(['node', 'dkg', 'update', 'latest']);
    expect(harness.performNpmUpdate).not.toHaveBeenCalled();
    expect(harness.performNpmUpdateEdge).toHaveBeenCalledWith(
      '10.0.1',
      '10.0.0',
      expect.any(Function),
    );
  });
});
