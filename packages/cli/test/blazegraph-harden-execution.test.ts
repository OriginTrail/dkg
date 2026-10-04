/**
 * `dkg store harden` migration — unit tests with scripted docker + fetch.
 *
 * Store-survivability build (2026-07-18 mainnet wedge incident). Locks in:
 *   - Pure plan generation per state (the dry-run seam).
 *   - State classification from canned `docker inspect` JSON (fleet
 *     shapes: legacy = `Mounts: []`, hardened = named volume at /data).
 *   - The executor's step order, its abort-before-rename predicates
 *     (export size, seed size), the automatic rollback after a failed
 *     post-swap verification, and resumability from 'backup-only'.
 *   - Safety invariants: NO code path ever `docker rm`'s the backup
 *     container, and the exported journal is never deleted.
 *
 * No real Docker, no real fetch — journal files are tiny stand-ins in a
 * tmp dir.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planHardenMigration, executeHardenMigration, HARDEN_DISK_PREFLIGHT_FACTOR, HARDEN_EXPORT_FILENAME, type HardenStep } from '../src/daemon/blazegraph-harden.js';
import { BLAZEGRAPH_DATA_DIR, BLAZEGRAPH_JOURNAL_FILE, type DockerRunner } from '../src/daemon/blazegraph-docker.js';
import { storeHardenLockPath } from '../src/daemon/store-runtime-monitor.js';
import { NAME, BACKUP, VOLUME, NAMESPACE, JOURNAL_BYTES, inspectJson, notFound, ok, scriptedDocker, verifierFetch, assertSafetyInvariants } from './_helpers/blazegraph-harden-fixtures.js';

describe('executeHardenMigration', () => {
  let migrationDir: string;
  let dkgHome: string;

  beforeEach(() => {
    migrationDir = mkdtempSync(join(tmpdir(), 'dkg-harden-test-'));
    dkgHome = join(migrationDir, 'dkg-home');
  });
  afterEach(() => {
    rmSync(migrationDir, { recursive: true, force: true });
  });

  const baseOpts = (docker: DockerRunner, fetch: typeof globalThis.fetch) => ({
    containerName: NAME,
    namespace: NAMESPACE,
    migrationDir,
    dkgHome,
    docker,
    fetch,
    log: () => {},
    totalMemoryBytes: () => 7.5 * 2 ** 30,
    env: {} as NodeJS.ProcessEnv,
    freeDiskBytes: async () => 10 ** 12,
    readyIntervalMs: 1,
    readyTimeoutMs: 200,
  });

  it('refuses a daemon that claimed its PID before migration lock acquisition without exposing a replacement', async () => {
    mkdirSync(dkgHome, { recursive: true });
    writeFileSync(join(dkgHome, 'daemon.pid'), String(process.pid));
    const { runner, calls } = scriptedDocker({ initial: 'legacy', migrationDir });
    const { fn, calls: queries } = verifierFetch();
    await expect(executeHardenMigration(baseOpts(runner, fn))).rejects.toThrow(/Stop it with `dkg stop`/);
    expect(calls.every(args => args[0] === 'inspect')).toBe(true);
    expect(queries).toEqual([]);
    expect(existsSync(storeHardenLockPath(dkgHome))).toBe(false);
  });

  it('releases the startup barrier when initial migration logging fails before any container mutation', async () => {
    const { runner, calls } = scriptedDocker({ initial: 'legacy', migrationDir });
    const { fn } = verifierFetch();
    await expect(executeHardenMigration({ ...baseOpts(runner, fn), log: () => { throw new Error('logging failed'); } })).rejects.toThrow('logging failed');
    expect(calls.every(args => args[0] === 'inspect')).toBe(true);
    expect(existsSync(storeHardenLockPath(dkgHome))).toBe(false);
  });

  it('refuses an existing migration lock before any container mutation', async () => {
    const { runner, calls } = scriptedDocker({ initial: 'legacy', migrationDir });
    const { fn } = verifierFetch();
    const opts = baseOpts(runner, fn);
    const lock = storeHardenLockPath(opts.dkgHome);
    const { mkdirSync } = await import('node:fs');
    mkdirSync(opts.dkgHome, { recursive: true });
    writeFileSync(lock, 'other migration');
    await expect(executeHardenMigration(opts)).rejects.toThrow(/EEXIST/);
    expect(calls.every(c => c[0] === 'inspect')).toBe(true);
    expect(existsSync(lock)).toBe(true);
  });

  it('migrates a pre-existing journal volume into a separate copy and keeps the old volume for rollback', async () => {
    const { runner, calls } = scriptedDocker({ initial: 'legacy', migrationDir });
    const original = runner.run.bind(runner);
    runner.run = async (args, options) => {
      const result = await original(args, options);
      if (args[0] === 'inspect' && args[1] === NAME && result.exitCode === 0) {
        const info = JSON.parse(result.stdout);
        if (info[0].Mounts.length === 0) {
          info[0].Mounts = [{ Name: `${NAME}-data`, Destination: BLAZEGRAPH_DATA_DIR }];
          return { ...result, stdout: JSON.stringify(info) };
        }
      }
      return result;
    };
    const { fn } = verifierFetch();
    await expect(executeHardenMigration(baseOpts(runner, fn))).resolves.toMatchObject({ outcome: 'hardened' });
    expect(calls).toContainEqual(['volume', 'create', VOLUME]);
    const seed = calls.find(c => c[0] === 'run' && c.includes('--rm'))!;
    expect(seed).toContain(`${VOLUME}:${BLAZEGRAPH_DATA_DIR}`);
    expect(seed).not.toContain(`${NAME}-data:${BLAZEGRAPH_DATA_DIR}`);
    const replacement = calls.find(c => c[0] === 'run' && c[1] === '-d')!;
    expect(replacement).toContain(`type=volume,source=${VOLUME},target=${BLAZEGRAPH_DATA_DIR}`);
    assertSafetyInvariants(calls, migrationDir, true);
  });

  it('happy path: executes stop → cp → volume → seed → rename → restart=no → run → verify', async () => {
    const { runner, calls } = scriptedDocker({ initial: 'legacy', migrationDir });
    const { fn } = verifierFetch();
    const result = await executeHardenMigration(baseOpts(runner, fn));

    expect(result.outcome).toBe('hardened');
    expect(result.backupContainerName).toBe(BACKUP);
    expect(result.journalBytes).toBe(JOURNAL_BYTES);
    expect(result.hostPort).toBe(9999);

    const seq = calls.map((c) => (c[0] === 'run' ? `run${c[1]}` : c[0]));
    const idx = (op: string) => seq.indexOf(op);
    expect(idx('stop')).toBeGreaterThan(-1);
    expect(idx('cp')).toBeGreaterThan(idx('stop'));
    expect(idx('volume')).toBeGreaterThan(idx('cp'));
    expect(idx('run--rm')).toBeGreaterThan(idx('volume'));
    expect(idx('rename')).toBeGreaterThan(idx('run--rm'));
    expect(idx('update')).toBeGreaterThan(idx('rename'));
    expect(idx('run-d')).toBeGreaterThan(idx('update'));
    // Verify re-reads the in-container journal size after the swap.
    expect(seq.lastIndexOf('exec')).toBeGreaterThan(idx('run-d'));
    // The stop is graceful (RWStore flush window).
    expect(calls.find((c) => c[0] === 'stop')).toEqual(['stop', '-t', '120', NAME]);
    assertSafetyInvariants(calls, migrationDir, true);
  });

  it('refuses an uncertain primary inspection before using an older retained backup', async () => {
    const { runner, calls } = scriptedDocker({ initial: 'backup-only', migrationDir });
    const original = runner.run.bind(runner);
    runner.run = async (args, options) => {
      if (args[0] === 'inspect' && args[1] === NAME) {
        calls.push([...args]);
        return { stdout: '', stderr: 'Cannot connect to the Docker daemon', exitCode: 1 };
      }
      return original(args, options);
    };
    const { fn, calls: queries } = verifierFetch();
    await expect(executeHardenMigration(baseOpts(runner, fn)))
      .rejects.toThrow(/Cannot determine whether primary container/);
    expect(calls).toEqual([['inspect', NAME]]);
    expect(queries).toEqual([]);
    expect(existsSync(join(migrationDir, HARDEN_EXPORT_FILENAME))).toBe(false);
    expect(existsSync(storeHardenLockPath(dkgHome))).toBe(false);
  });

  it('refuses an unlimited-log replacement without overwriting its authoritative journal', async () => {
    const { runner, calls } = scriptedDocker({ initial: 'hardened', migrationDir });
    const original = runner.run.bind(runner);
    runner.run = async (args, options) => {
      const result = await original(args, options);
      if (args[0] !== 'inspect' || args[1] !== NAME) return result;
      const info = JSON.parse(result.stdout);
      info[0].HostConfig.LogConfig = { Type: 'json-file', Config: {} };
      return { ...result, stdout: JSON.stringify(info) };
    };
    const { fn, calls: queries } = verifierFetch();
    await expect(executeHardenMigration(baseOpts(runner, fn)))
      .rejects.toThrow(/already uses the replacement journal volume/);
    expect(calls).toEqual([['inspect', NAME]]);
    expect(queries).toEqual([]);
  });

  it('is a no-op (verify only) for an already-hardened container', async () => {
    const { runner, calls } = scriptedDocker({ initial: 'hardened', migrationDir });
    const { fn } = verifierFetch();
    const result = await executeHardenMigration(baseOpts(runner, fn));
    expect(result.outcome).toBe('already-hardened');
    for (const forbidden of ['stop', 'cp', 'rename', 'rm', 'update']) {
      expect(calls.some((c) => c[0] === forbidden)).toBe(false);
    }
  });

  it.each(['identity', 'journal'] as const)(
    'repeats %s verification after failed rollback leaves a hardened-shaped replacement', async (failure) => {
      let created = false;
      let journalInvalid = failure === 'journal';
      const { runner, calls } = scriptedDocker({ initial: 'legacy', migrationDir,
        failOn: args => {
          if (args[0] === 'run' && args[1] === '-d') created = true;
          if (args[0] === 'rm') return { stdout: '', stderr: 'replacement busy', exitCode: 1 };
          if (created && journalInvalid && args[0] === 'exec') return ok(String(JOURNAL_BYTES - 1));
          return null;
        },
      });
      const failing = verifierFetch({ identityPresent: failure !== 'identity' });
      await expect(executeHardenMigration(baseOpts(runner, failing.fn)))
        .rejects.toThrow(/rollback is INCOMPLETE/);
      const retryStart = calls.length;
      await expect(executeHardenMigration(baseOpts(runner, failing.fn)))
        .rejects.toThrow(failure === 'identity' ? /identity-tag/ : /migrated journal/);
      expect(calls.slice(retryStart).every(args => args[0] === 'inspect' || args[0] === 'exec')).toBe(true);
      expect(readFileSync(join(migrationDir, HARDEN_EXPORT_FILENAME))).toHaveLength(JOURNAL_BYTES);
      // Success requires the formerly failed proof to pass, rather than ASK alone.
      journalInvalid = false;
      const recovered = verifierFetch();
      await expect(executeHardenMigration(baseOpts(runner, recovered.fn))).resolves.toMatchObject({
        outcome: 'already-hardened', journalBytes: JOURNAL_BYTES, backupContainerName: BACKUP,
      });
    },
  );

  it('refuses a migration-shaped retry without its retained export', async () => {
    const { runner } = scriptedDocker({ initial: 'legacy', migrationDir,
      failOn: args => args[0] === 'rm' ? { stdout: '', stderr: 'busy', exitCode: 1 } : null,
    });
    const failing = verifierFetch({ identityPresent: false });
    await expect(executeHardenMigration(baseOpts(runner, failing.fn))).rejects.toThrow(/rollback is INCOMPLETE/);
    rmSync(join(migrationDir, HARDEN_EXPORT_FILENAME));
    await expect(executeHardenMigration(baseOpts(runner, verifierFetch().fn)))
      .rejects.toThrow(/no valid retained export/);
  });


  it('refuses ASK-only success when backup inspection fails and the export is absent', async () => {
    const { runner } = scriptedDocker({ initial: 'hardened', migrationDir,
      failOn: args => args[0] === 'inspect' && args[1] === BACKUP
        ? { stdout: '', stderr: 'Cannot connect to the Docker daemon', exitCode: 1 } : null,
    });
    const fetch = verifierFetch();
    await expect(executeHardenMigration(baseOpts(runner, fetch.fn)))
      .rejects.toThrow(/Cannot determine whether migration backup/);
    expect(fetch.calls).toEqual([]);
  });


  it('dry-run only inspects and returns the plan', async () => {
    const { runner, calls } = scriptedDocker({ initial: 'legacy', migrationDir });
    const { fn } = verifierFetch();
    const result = await executeHardenMigration({ ...baseOpts(runner, fn), dryRun: true });
    expect(result.outcome).toBe('dry-run');
    expect(result.steps?.map((s) => s.id)).toContain('export-journal');
    expect(calls.every((c) => c[0] === 'inspect')).toBe(true);
  });

  it('aborts BEFORE any rename when the export comes up short', async () => {
    const { runner, calls } = scriptedDocker({
      initial: 'legacy', migrationDir, cpBytes: 500, // < preSize 1000
    });
    const { fn } = verifierFetch();
    await expect(executeHardenMigration(baseOpts(runner, fn)))
      .rejects.toThrow(/export validation failed.*untouched/is);
    expect(calls.some((c) => c[0] === 'rename')).toBe(false);
    expect(calls.some((c) => c[0] === 'run' && c[1] === '-d')).toBe(false);
    assertSafetyInvariants(calls, migrationDir, true);
  });

  it('post-stop abort messages say the legacy store is STOPPED and name the restore command (MINOR-10)', async () => {
    const { runner } = scriptedDocker({
      initial: 'legacy', migrationDir, cpBytes: 500,
    });
    const { fn } = verifierFetch();
    const err = await executeHardenMigration(baseOpts(runner, fn)).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/currently STOPPED/);
    expect((err as Error).message).toContain(`docker start ${NAME}`);
  });

  it('aborts BEFORE any rename when the container ran during the export (BLOCKER-1b)', async () => {
    const { runner, calls } = scriptedDocker({
      initial: 'legacy', migrationDir, interfereAfterCp: 'restart',
    });
    const { fn } = verifierFetch();
    const err = await executeHardenMigration(baseOpts(runner, fn)).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/ran during the export/i);
    // Names the likely interference and the restore command.
    expect((err as Error).message).toMatch(/store monitor|systemd/i);
    expect((err as Error).message).toContain(`docker start ${NAME}`);
    expect(calls.some((c) => c[0] === 'rename')).toBe(false);
    expect(calls.some((c) => c[0] === 'run' && c[1] === '-d')).toBe(false);
    assertSafetyInvariants(calls, migrationDir, true);
  });

  it('aborts BEFORE any rename when the container is STILL running after the export', async () => {
    const { runner, calls } = scriptedDocker({
      initial: 'legacy', migrationDir, interfereAfterCp: 'running',
    });
    const { fn } = verifierFetch();
    await expect(executeHardenMigration(baseOpts(runner, fn)))
      .rejects.toThrow(/ran during the export.*RUNNING again/is);
    expect(calls.some((c) => c[0] === 'rename')).toBe(false);
    assertSafetyInvariants(calls, migrationDir, true);
  });

  it('aborts BEFORE any rename when the writable layer changed size during the export (BLOCKER-1c)', async () => {
    const { runner, calls } = scriptedDocker({
      initial: 'legacy', migrationDir, sizeRwDelta: 4096,
    });
    const { fn } = verifierFetch();
    const err = await executeHardenMigration(baseOpts(runner, fn)).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/writable layer changed/i);
    expect((err as Error).message).toContain(`docker start ${NAME}`);
    expect(calls.some((c) => c[0] === 'rename')).toBe(false);
    assertSafetyInvariants(calls, migrationDir, true);
  });

  it('writes the harden lock before mutating docker and always removes it (BLOCKER-1a)', async () => {
    const lockPath = storeHardenLockPath(dkgHome);
    let lockSeenAtStop = false;
    let lockSeenAtCp = false;
    const { runner } = scriptedDocker({
      initial: 'legacy',
      migrationDir,
      failOn: (args) => {
        if (args[0] === 'stop') lockSeenAtStop = existsSync(lockPath);
        if (args[0] === 'cp') lockSeenAtCp = existsSync(lockPath);
        // Fail the volume create so the failure path's `finally` is exercised.
        if (args[0] === 'volume') return { stdout: '', stderr: 'boom', exitCode: 1 };
        return null;
      },
    });
    const { fn } = verifierFetch();
    await expect(executeHardenMigration(baseOpts(runner, fn)))
      .rejects.toThrow(/creating the journal volume failed/);
    expect(lockSeenAtStop).toBe(true);
    expect(lockSeenAtCp).toBe(true);
    expect(existsSync(lockPath)).toBe(false); // removed in the finally

    // Success path removes it too.
    const second = scriptedDocker({ initial: 'legacy', migrationDir });
    const result = await executeHardenMigration(baseOpts(second.runner, verifierFetch().fn));
    expect(result.outcome).toBe('hardened');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('aborts up-front with --port guidance when no host port is determinable (MAJOR-6)', async () => {
    const calls: string[][] = [];
    const runner: DockerRunner = {
      async run(args) {
        calls.push([...args]);
        if (args[0] === 'inspect' && args[1] === NAME) {
          return ok(inspectJson({ running: false, noPorts: true }));
        }
        return notFound;
      },
    };
    const { fn } = verifierFetch();
    await expect(executeHardenMigration(baseOpts(runner, fn)))
      .rejects.toThrow(/Refusing to guess.*--port/is);
    // Nothing was stopped/exported — the abort happens before any mutation.
    expect(calls.some((c) => c[0] === 'stop' || c[0] === 'cp')).toBe(false);
  });

  it('an explicit --port override bypasses the port abort', async () => {
    const { runner } = scriptedDocker({ initial: 'legacy-stopped', migrationDir });
    const { fn } = verifierFetch();
    // legacy-stopped: docker exec is impossible → preSize unknown; the
    // export is a fresh cp validated as > 0.
    const result = await executeHardenMigration({
      ...baseOpts(runner, fn),
      hostPort: 12345,
    });
    expect(result.hostPort).toBe(12345);
  });

  it('aborts BEFORE any rename when the seeded volume size mismatches', async () => {
    const { runner, calls } = scriptedDocker({
      initial: 'legacy', migrationDir, seedStdout: '999',
    });
    const { fn } = verifierFetch();
    await expect(executeHardenMigration(baseOpts(runner, fn)))
      .rejects.toThrow(/seed validation failed/i);
    expect(calls.some((c) => c[0] === 'rename')).toBe(false);
    assertSafetyInvariants(calls, migrationDir, true);
  });

  it('aborts up-front when free disk is below 2.2x the journal size (export + volume seed copy)', async () => {
    expect(HARDEN_DISK_PREFLIGHT_FACTOR).toBe(2.2);
    const { runner, calls } = scriptedDocker({ initial: 'legacy', migrationDir });
    const { fn } = verifierFetch();
    const err = await executeHardenMigration({
      ...baseOpts(runner, fn),
      freeDiskBytes: async () => 2_150, // needs ceil(1000 * 2.2) = 2200
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Not enough free disk/);
    // Says WHY 2.2x: both copies usually share the root filesystem.
    expect((err as Error).message).toMatch(/2\.2x journal.*seed copy/is);
    expect(calls.some((c) => c[0] === 'stop')).toBe(false);
    expect(calls.some((c) => c[0] === 'cp')).toBe(false);
  });

  it('rolls back when the readiness probe HANGS instead of settling (bounded verification, no strand)', async () => {
    // The reviewer scenario: the hardened container accepts TCP/HTTP but a
    // status fetch never completes — and, like any injected/wedged
    // implementation, IGNORES its abort signal. Before the fix the
    // elapsed-time check only ran BETWEEN probes, so the migration awaited
    // forever post-rename with the store renamed away and the rollback
    // unreachable. Every probe now carries its own deadline.
    const { runner, calls } = scriptedDocker({ initial: 'legacy', migrationDir });
    const { fn } = verifierFetch();
    const hangingStatus: typeof globalThis.fetch = (async (input: any, init?: any) => {
      if (String(input).endsWith('/bigdata/status')) {
        return new Promise<never>(() => {}); // never settles, ignores the signal
      }
      return fn(input, init);
    }) as typeof globalThis.fetch;

    await expect(executeHardenMigration({
      ...baseOpts(runner, hangingStatus),
      readyTimeoutMs: 100,
      probeTimeoutMs: 10,
    })).rejects.toThrow(/verification failed.*restored/is);

    expect(calls).toContainEqual(['rename', BACKUP, NAME]);
    expect(calls).toContainEqual(['start', NAME]);
    assertSafetyInvariants(calls, migrationDir, true);
  });

  it('rolls back when the SPARQL ASK probe HANGS instead of settling', async () => {
    // Readiness succeeds; the ASK response never completes. The per-probe
    // deadline must convert the hang into an ordinary verification failure
    // so the existing rollback path runs.
    const { runner, calls } = scriptedDocker({ initial: 'legacy', migrationDir });
    const { fn } = verifierFetch();
    const hangingSparql: typeof globalThis.fetch = (async (input: any, init?: any) => {
      if (String(input).endsWith('/bigdata/status')) return fn(input, init);
      return new Promise<never>(() => {}); // ASK + identity probes hang
    }) as typeof globalThis.fetch;

    await expect(executeHardenMigration({
      ...baseOpts(runner, hangingSparql),
      probeTimeoutMs: 10,
    })).rejects.toThrow(/verification failed.*restored/is);

    expect(calls).toContainEqual(['rename', BACKUP, NAME]);
    expect(calls).toContainEqual(['start', NAME]);
    assertSafetyInvariants(calls, migrationDir, true);
  });

  it('rolls back to the backup when post-swap verification fails (ASK dead)', async () => {
    const { runner, calls } = scriptedDocker({ initial: 'legacy', migrationDir });
    const { fn } = verifierFetch({ askOk: false });
    await expect(executeHardenMigration(baseOpts(runner, fn)))
      .rejects.toThrow(/verification failed.*restored/is);

    // Rollback sequence: rm -f NEW container (volume-gated), rename the
    // backup back, restore the restart policy, start it.
    expect(calls).toContainEqual(['rm', '-f', NAME]);
    expect(calls).toContainEqual(['rename', BACKUP, NAME]);
    expect(calls).toContainEqual(['update', '--restart=unless-stopped', NAME]);
    expect(calls).toContainEqual(['start', NAME]);
    // The rm must be gated on an inspect proving the volume mount.
    const rmIdx = calls.findIndex((c) => c[0] === 'rm');
    const gateInspect = calls.slice(0, rmIdx).filter((c) => c[0] === 'inspect' && c[1] === NAME);
    expect(gateInspect.length).toBeGreaterThan(1);
    assertSafetyInvariants(calls, migrationDir, true);
  });

  it('refuses rollback deletion when the replacement does not own the journal volume', async () => {
    let created = false;
    const { runner, calls } = scriptedDocker({ initial: 'legacy', migrationDir,
      failOn: args => {
        if (args[0] === 'run' && args[1] === '-d') created = true;
        if (created && args[0] === 'inspect' && args[1] === NAME) {
          return ok(JSON.stringify([{ State: { Running: true }, Mounts: [] }]));
        }
        return null;
      },
    });
    const { fn } = verifierFetch({ askOk: false });
    await expect(executeHardenMigration(baseOpts(runner, fn))).rejects.toThrow(/volume-gate/);
    expect(calls.some(args => args[0] === 'rm')).toBe(false);
    expect(calls).not.toContainEqual(['rename', BACKUP, NAME]);
    expect(calls).not.toContainEqual(['start', NAME]);
  });

  it('rolls back to the backup when `docker run` fails AFTER the rename (post-swap setup, not just verify)', async () => {
    // The reviewer scenario: another process binds the host port between the
    // rename and the hardened `docker run`. Before the fix only verification
    // failures rolled back — this one stranded the daemon with no store while
    // the intact backup sat one rename away.
    const { runner, calls } = scriptedDocker({
      initial: 'legacy',
      migrationDir,
      failOn: (args) => (args[0] === 'run' && args[1] === '-d'
        ? { stdout: '', stderr: 'driver failed programming external connectivity: port is already allocated', exitCode: 125 }
        : null),
    });
    const { fn } = verifierFetch();
    await expect(executeHardenMigration(baseOpts(runner, fn)))
      .rejects.toThrow(/post-swap setup failed.*restored/is);
    // The rename DID happen, and the full rollback ran after the failure.
    expect(calls).toContainEqual(['rename', NAME, BACKUP]);
    expect(calls).toContainEqual(['rename', BACKUP, NAME]);
    expect(calls).toContainEqual(['update', '--restart=unless-stopped', NAME]);
    expect(calls).toContainEqual(['start', NAME]);
    assertSafetyInvariants(calls, migrationDir, true);
  });

  it('rolls back to the backup when disabling the backup restart policy fails after the rename', async () => {
    const { runner, calls } = scriptedDocker({
      initial: 'legacy',
      migrationDir,
      failOn: (args) => (args[0] === 'update' && args[1] === '--restart=no'
        ? { stdout: '', stderr: 'Error response from daemon: engine unavailable', exitCode: 1 }
        : null),
    });
    const { fn } = verifierFetch();
    await expect(executeHardenMigration(baseOpts(runner, fn)))
      .rejects.toThrow(/post-swap setup failed.*restored/is);
    // Nothing was created yet, so the rollback must NOT rm anything — just
    // rename the backup back, restore its policy, and start it.
    expect(calls.some((c) => c[0] === 'rm')).toBe(false);
    expect(calls).toContainEqual(['rename', BACKUP, NAME]);
    expect(calls).toContainEqual(['update', '--restart=unless-stopped', NAME]);
    expect(calls).toContainEqual(['start', NAME]);
    assertSafetyInvariants(calls, migrationDir, true);
  });

  it('rolls back when the identity tag did not follow the data', async () => {
    const { runner, calls } = scriptedDocker({ initial: 'legacy', migrationDir });
    const { fn } = verifierFetch({ identityPresent: false });
    await expect(executeHardenMigration(baseOpts(runner, fn)))
      .rejects.toThrow(/identity-tag probe/i);
    expect(calls).toContainEqual(['rename', BACKUP, NAME]);
    assertSafetyInvariants(calls, migrationDir, true);
  });

  it('rollback STOPS at a failed rm — never rename/start after it — and reports INCOMPLETE (MAJOR-4)', async () => {
    const logs: string[] = [];
    const { runner, calls } = scriptedDocker({
      initial: 'legacy',
      migrationDir,
      failOn: (args) => (args[0] === 'rm'
        ? { stdout: '', stderr: 'cannot remove: device busy', exitCode: 1 }
        : null),
    });
    const { fn } = verifierFetch({ askOk: false }); // verify fails → rollback
    const err = await executeHardenMigration({
      ...baseOpts(runner, fn),
      log: (m) => logs.push(m),
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    // Never claims the legacy container was restored.
    expect((err as Error).message).toMatch(/rollback is INCOMPLETE/i);
    expect((err as Error).message).not.toMatch(/was restored/);
    // No later step ran — `docker start dkg-blazegraph-dkg` here would have
    // started the FAILED-VERIFICATION container.
    expect(calls.some((c) => c[0] === 'rename' && c[1] === BACKUP)).toBe(false);
    expect(calls.some((c) => c[0] === 'update' && c[1] === '--restart=unless-stopped')).toBe(false);
    expect(calls.some((c) => c[0] === 'start')).toBe(false);
    // The exact remaining manual docker commands are printed.
    const manual = logs.join('\n');
    expect(manual).toContain('ROLLBACK INCOMPLETE');
    expect(manual).toContain(`docker rm -f ${NAME}`);
    expect(manual).toContain(`docker rename ${BACKUP} ${NAME}`);
    expect(manual).toContain(`docker update --restart=unless-stopped ${NAME}`);
    expect(manual).toContain(`docker start ${NAME}`);
    assertSafetyInvariants(calls, migrationDir, true);
  });

  it('rollback STOPS at a failed rename-back and lists only the remaining manual steps', async () => {
    const logs: string[] = [];
    const { runner, calls } = scriptedDocker({
      initial: 'legacy',
      migrationDir,
      failOn: (args) => (args[0] === 'rename' && args[1] === BACKUP
        ? { stdout: '', stderr: 'rename refused', exitCode: 1 }
        : null),
    });
    const { fn } = verifierFetch({ askOk: false });
    await expect(executeHardenMigration({
      ...baseOpts(runner, fn),
      log: (m) => logs.push(m),
    })).rejects.toThrow(/rollback is INCOMPLETE.*rename-backup/is);
    // rm ran (gated), but nothing after the failed rename.
    expect(calls).toContainEqual(['rm', '-f', NAME]);
    expect(calls.some((c) => c[0] === 'update' && c[1] === '--restart=unless-stopped')).toBe(false);
    expect(calls.some((c) => c[0] === 'start')).toBe(false);
    const manual = logs.join('\n');
    expect(manual).toContain(`docker rename ${BACKUP} ${NAME}`);
    expect(manual).toContain(`docker start ${NAME}`);
    // The already-done rm must NOT be in the remaining-steps list.
    expect(manual).not.toContain(`docker rm -f ${NAME}`);
    assertSafetyInvariants(calls, migrationDir, true);
  });

  it('resumes from backup-only by replacing the export without renaming the backup', async () => {
    // Simulated crash after the rename: export exists, volume not yet run.
    writeFileSync(join(migrationDir, HARDEN_EXPORT_FILENAME), Buffer.alloc(JOURNAL_BYTES, 1));
    const { runner, calls } = scriptedDocker({ initial: 'backup-only', migrationDir });
    const { fn } = verifierFetch();
    const result = await executeHardenMigration(baseOpts(runner, fn));
    expect(result.outcome).toBe('hardened');
    // Re-export the authoritative backup, preserving its name and data.
    expect(calls).toContainEqual(['stop', '-t', '120', BACKUP]);
    expect(calls).toContainEqual(['cp', `${BACKUP}:${BLAZEGRAPH_JOURNAL_FILE}`, join(migrationDir, HARDEN_EXPORT_FILENAME)]);
    expect(calls.some((c) => c[0] === 'rename')).toBe(false);
    // The tail still runs: volume create → seed → hardened run.
    expect(calls.some((c) => c[0] === 'volume')).toBe(true);
    expect(calls.some((c) => c[0] === 'run' && c[1] === '--rm')).toBe(true);
    expect(calls.some((c) => c[0] === 'run' && c[1] === '-d')).toBe(true);
    assertSafetyInvariants(calls, migrationDir, true);
  });

  /**
   * Plan/executor conformance: every docker-backed step of the dry-run plan
   * must be executed with EXACTLY the planned argv, in plan order. The
   * executor sources its argv from the same ordered phases the plan renders,
   * so this fails whenever someone hand-writes a docker command in the
   * executor again (or reorders/skips a planned step) — the drift the plan
   * would then silently misreport to the operator.
   */
  function assertExecutionFollowsPlan(plan: HardenStep[], calls: string[][]) {
    const planned = plan.filter((s) => s.dockerArgs !== undefined);
    expect(planned.length).toBeGreaterThan(0);
    let cursor = -1;
    for (const step of planned) {
      const idx = calls.findIndex(
        (c, i) => i > cursor && JSON.stringify(c) === JSON.stringify(step.dockerArgs),
      );
      expect(
        idx,
        `planned step "${step.id}" (docker ${step.dockerArgs!.join(' ')}) was not executed after its predecessor`,
      ).toBeGreaterThan(cursor);
      cursor = idx;
    }
  }

  it('executes every planned docker command with the planned argv, in plan order (legacy path)', async () => {
    const { runner, calls } = scriptedDocker({ initial: 'legacy', migrationDir });
    const { fn } = verifierFetch();
    await executeHardenMigration(baseOpts(runner, fn));
    const plan = planHardenMigration({
      containerName: NAME, namespace: NAMESPACE, hostPort: 9999,
      heapMb: 3072, migrationDir, state: 'legacy',
    });
    expect(plan.filter((s) => s.dockerArgs).length).toBe(10);
    assertExecutionFollowsPlan(plan, calls);
  });

  it('executes every planned docker command with the planned argv, in plan order (backup-only resume)', async () => {
    writeFileSync(join(migrationDir, HARDEN_EXPORT_FILENAME), Buffer.alloc(JOURNAL_BYTES, 1));
    const { runner, calls } = scriptedDocker({ initial: 'backup-only', migrationDir });
    const { fn } = verifierFetch();
    await executeHardenMigration(baseOpts(runner, fn));
    const plan = planHardenMigration({
      containerName: NAME, namespace: NAMESPACE, hostPort: 9999,
      heapMb: 3072, migrationDir, state: 'backup-only',
    });
    assertExecutionFollowsPlan(plan, calls);
  });

  it('re-running after success is a verify-only no-op', async () => {
    const { runner, calls } = scriptedDocker({ initial: 'legacy', migrationDir });
    const { fn } = verifierFetch();
    await executeHardenMigration(baseOpts(runner, fn));
    const before = calls.length;
    const second = await executeHardenMigration(baseOpts(runner, fn));
    expect(second.outcome).toBe('already-hardened');
    const secondCalls = calls.slice(before);
    expect(secondCalls.every((c) => c[0] === 'inspect' || c[0] === 'exec')).toBe(true);
    expect(secondCalls).toContainEqual(['exec', NAME, 'stat', '-c', '%s', BLAZEGRAPH_JOURNAL_FILE]);
    expect(second.journalBytes).toBe(JOURNAL_BYTES);
  });

  it.each([true, false])('exports current backup bytes even if a stale same-size export exists: %s', async (savedExport) => {
    const path = join(migrationDir, HARDEN_EXPORT_FILENAME);
    if (savedExport) writeFileSync(path, Buffer.alloc(JOURNAL_BYTES, 1));
    let seeded!: Buffer;
    const { runner, calls } = scriptedDocker({ initial: 'backup-only', migrationDir, cpFill: 2,
      failOn: args => { if (args[0] === 'run' && args[1] === '--rm') seeded = readFileSync(path); return null; },
    });
    const { fn } = verifierFetch();
    await expect(executeHardenMigration(baseOpts(runner, fn))).resolves.toMatchObject({ outcome: 'hardened' });
    expect(seeded).toEqual(Buffer.alloc(JOURNAL_BYTES, 2));
    expect(calls.filter(args => args[0] === 'inspect' && args[1] === '--size'))
      .toEqual([['inspect', '--size', BACKUP], ['inspect', '--size', BACKUP]]);
    expect(calls.some(args => args[0] === 'rename')).toBe(false);
    assertSafetyInvariants(calls, migrationDir, true);
  });

  it('refuses to seed a replacement volume that already contains the authoritative journal', async () => {
    const { runner, calls } = scriptedDocker({ initial: 'legacy', migrationDir,
      failOn: args => {
        if (args[0] !== 'inspect' || args[1] !== NAME) return null;
        const info = JSON.parse(inspectJson({ hardened: true }));
        info[0].Config = {};
        return ok(JSON.stringify(info));
      },
    });
    const { fn } = verifierFetch();
    await expect(executeHardenMigration(baseOpts(runner, fn))).rejects.toThrow(/Refusing to overwrite/);
    expect(calls.every(c => c[0] === 'inspect')).toBe(true);
  });

  it('errors actionably when the container does not exist at all', async () => {
    const { runner } = scriptedDocker({ initial: 'absent', migrationDir });
    const { fn } = verifierFetch();
    await expect(executeHardenMigration(baseOpts(runner, fn)))
      .rejects.toThrow(/not found.*nothing to harden/is);
  });
});
