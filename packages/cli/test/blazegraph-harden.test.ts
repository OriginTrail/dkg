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
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  inspectHardenState,
  planHardenMigration,
  executeHardenMigration,
  HARDEN_BACKUP_SUFFIX,
  HARDEN_DISK_PREFLIGHT_FACTOR,
  HARDEN_EXPORT_FILENAME,
} from '../src/daemon/blazegraph-harden.js';
import {
  BLAZEGRAPH_DATA_DIR,
  BLAZEGRAPH_IMAGE,
  BLAZEGRAPH_JOURNAL_FILE,
  blazegraphVolumeName,
  type DockerRunner,
  type DockerCommandResult,
} from '../src/daemon/blazegraph-docker.js';
import { storeHardenLockPath } from '../src/daemon/store-health-check.js';
import { parseHardenPortOption } from '../src/commands/store.js';

const NAME = 'dkg-blazegraph-dkg';
const BACKUP = `${NAME}${HARDEN_BACKUP_SUFFIX}`;
const VOLUME = blazegraphVolumeName(NAME);
const NAMESPACE = 'dkg';
const JOURNAL_BYTES = 1000;
const STARTED_AT = '2026-07-18T00:00:00.000000000Z';
const FINISHED_AT = '2026-07-18T00:10:00.000000000Z';

function inspectJson(shape: {
  running?: boolean;
  hardened?: boolean;
  hostPort?: string;
  startedAt?: string;
  finishedAt?: string;
  sizeRw?: number;
  /** Stopped-container realism: NetworkSettings.Ports is EMPTY once stopped. */
  networkPortsEmpty?: boolean;
  /** No port configuration anywhere (neither durable nor runtime). */
  noPorts?: boolean;
}): string {
  const bindings = { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: shape.hostPort ?? '9999' }] };
  return JSON.stringify([{
    State: {
      Running: shape.running ?? true,
      StartedAt: shape.startedAt ?? STARTED_AT,
      FinishedAt: shape.finishedAt ?? FINISHED_AT,
    },
    // Fleet-verified legacy shape: Mounts [] (journal in the writable layer).
    Mounts: shape.hardened
      ? [{ Destination: BLAZEGRAPH_DATA_DIR, Name: VOLUME }]
      : [],
    HostConfig: { PortBindings: shape.noPorts ? {} : bindings },
    NetworkSettings: {
      Ports: shape.noPorts || shape.networkPortsEmpty ? {} : bindings,
    },
    ...(shape.sizeRw !== undefined ? { SizeRw: shape.sizeRw } : {}),
  }]);
}

const notFound: DockerCommandResult = {
  stdout: '', stderr: `Error: No such object: ${NAME}`, exitCode: 1,
};
const ok = (stdout = ''): DockerCommandResult => ({ stdout, stderr: '', exitCode: 0 });

/**
 * Stateful scripted docker: models the world across the migration
 * (stop flips Running, rename flips inspect results, `run -d` creates
 * the hardened container) so the executor's re-derivation of state
 * stays honest. `docker inspect --size` additionally reports SizeRw
 * (writable-layer bytes), mirroring the real CLI.
 */
function scriptedDocker(opts: {
  initial: 'legacy' | 'legacy-stopped' | 'backup-only' | 'hardened' | 'absent';
  migrationDir: string;
  /** Bytes `docker cp` writes to the export file. Default JOURNAL_BYTES. */
  cpBytes?: number;
  /** Seed helper stdout. Default String(JOURNAL_BYTES). */
  seedStdout?: string;
  /** In-container journal size reported by `docker exec stat`. */
  statStdout?: string;
  /**
   * Injected step failure/observer: called with every docker argv before
   * the scripted behaviour; return a result to force it, null to pass
   * through. Lets tests fail exactly one rollback step or observe
   * on-disk state mid-migration.
   */
  failOn?: (args: string[]) => DockerCommandResult | null;
  /**
   * Simulate BLOCKER-1 interference: after `docker cp` the container
   * inspect reports a changed StartedAt ('restart' = ran and re-stopped,
   * 'running' = still running).
   */
  interfereAfterCp?: 'restart' | 'running';
  /** Writable-layer byte delta reported after the cp (BLOCKER-1c). */
  sizeRwDelta?: number;
}) {
  const calls: string[][] = [];
  let renamed = opts.initial === 'backup-only';
  let hardenedCreated = opts.initial === 'hardened';
  let stopped = opts.initial === 'legacy-stopped';
  let cpDone = false;
  const runner: DockerRunner = {
    async run(args) {
      calls.push([...args]);
      const forced = opts.failOn?.([...args]);
      if (forced) return forced;
      const [cmd] = args;
      if (cmd === 'inspect') {
        const withSize = args[1] === '--size';
        const target = withSize ? args[2] : args[1];
        if (target === NAME) {
          if (hardenedCreated) return ok(inspectJson({ hardened: true }));
          if (opts.initial === 'absent' || renamed) return notFound;
          const interfered = cpDone && opts.interfereAfterCp !== undefined;
          return ok(inspectJson({
            running: interfered
              ? opts.interfereAfterCp === 'running'
              : opts.initial === 'legacy' && !stopped,
            startedAt: interfered ? '2026-07-18T13:37:00.000000000Z' : STARTED_AT,
            finishedAt: interfered ? '2026-07-18T13:38:00.000000000Z' : FINISHED_AT,
            // Stopped containers have empty runtime Ports — the durable
            // HostConfig.PortBindings is what must carry the port.
            networkPortsEmpty: stopped,
            ...(withSize
              ? { sizeRw: JOURNAL_BYTES + (cpDone ? opts.sizeRwDelta ?? 0 : 0) }
              : {}),
          }));
        }
        if (target === BACKUP) {
          // The backup is always stopped: runtime Ports empty (realistic).
          return renamed
            ? ok(inspectJson({ running: false, networkPortsEmpty: true }))
            : notFound;
        }
        return notFound;
      }
      if (cmd === 'exec') return ok(`${opts.statStdout ?? String(JOURNAL_BYTES)}\n`);
      if (cmd === 'stop') { stopped = true; return ok(); }
      if (cmd === 'cp') {
        writeFileSync(
          join(opts.migrationDir, HARDEN_EXPORT_FILENAME),
          Buffer.alloc(opts.cpBytes ?? JOURNAL_BYTES, 1),
        );
        cpDone = true;
        return ok();
      }
      if (cmd === 'volume') return ok(VOLUME);
      if (cmd === 'run' && args[1] === '--rm') return ok(`${opts.seedStdout ?? String(JOURNAL_BYTES)}\n`);
      if (cmd === 'run' && args[1] === '-d') {
        hardenedCreated = true;
        return ok('container-id');
      }
      if (cmd === 'rename') {
        if (args[1] === NAME) renamed = true;
        if (args[1] === BACKUP) { renamed = false; hardenedCreated = false; }
        return ok();
      }
      if (cmd === 'rm') {
        hardenedCreated = false;
        return ok();
      }
      return ok();
    },
  };
  return { runner, calls };
}

function verifierFetch(opts: {
  statusOk?: boolean;
  askOk?: boolean;
  identityPresent?: boolean;
} = {}) {
  const calls: Array<{ url: string; body: string }> = [];
  const fn: typeof globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    const body = String(init?.body ?? '');
    calls.push({ url, body });
    if (url.endsWith('/bigdata/status')) {
      return new Response('ok', { status: (opts.statusOk ?? true) ? 200 : 500 });
    }
    if (body.includes(encodeURIComponent('ASK {}'))) {
      return (opts.askOk ?? true)
        ? new Response(JSON.stringify({ boolean: true }), { status: 200 })
        : new Response('dead', { status: 500 });
    }
    if (body.includes('SELECT')) {
      const bindings = (opts.identityPresent ?? true)
        ? [{ name: { type: 'literal', value: 'saturn_station' } }]
        : [];
      return new Response(
        JSON.stringify({ head: { vars: ['name'] }, results: { bindings } }),
        { status: 200 },
      );
    }
    return new Response(null, { status: 200 });
  }) as typeof globalThis.fetch;
  return { fn, calls };
}

/** Invariants that must hold after EVERY executor run, pass or fail. */
function assertSafetyInvariants(calls: string[][], migrationDir: string, exportExpected: boolean) {
  // The backup container is never removed by any code path.
  expect(calls.some((c) => c[0] === 'rm' && c.includes(BACKUP))).toBe(false);
  // The exported journal is never unlinked.
  if (exportExpected) {
    expect(existsSync(join(migrationDir, HARDEN_EXPORT_FILENAME))).toBe(true);
  }
}

describe('planHardenMigration', () => {
  const input = {
    containerName: NAME,
    namespace: NAMESPACE,
    hostPort: 9999,
    heapMb: 3072,
    migrationDir: '/tmp/harden',
    state: 'legacy' as const,
  };

  it('produces the golden step sequence for a legacy container', () => {
    const steps = planHardenMigration(input);
    expect(steps.map((s) => s.id)).toEqual([
      'journal-size',
      'disk-preflight',
      'stop',
      'export-journal',
      'export-integrity',
      'volume-create',
      'seed-volume',
      'rename-backup',
      'disable-backup-restart',
      'run-hardened',
      'verify',
    ]);
    const byId = Object.fromEntries(steps.map((s) => [s.id, s]));
    expect(byId['stop'].dockerArgs).toEqual(['stop', '-t', '120', NAME]);
    expect(byId['export-journal'].dockerArgs).toEqual([
      'cp', `${NAME}:${BLAZEGRAPH_JOURNAL_FILE}`, '/tmp/harden/bigdata.jnl',
    ]);
    expect(byId['volume-create'].dockerArgs).toEqual(['volume', 'create', VOLUME]);
    expect(byId['rename-backup'].dockerArgs).toEqual(['rename', NAME, BACKUP]);
    expect(byId['disable-backup-restart'].dockerArgs).toEqual(['update', '--restart=no', BACKUP]);
    // Seed uses the SAME pinned image (nothing new pulled) + temp-file+mv.
    expect(byId['seed-volume'].dockerArgs).toContain(BLAZEGRAPH_IMAGE);
    expect(byId['seed-volume'].dockerArgs?.join(' ')).toContain('.seed.tmp');
    expect(byId['seed-volume'].dockerArgs?.join(' ')).toContain('chown 100:1000');
    // Export-integrity re-inspect uses --size (SizeRw is only computed then).
    expect(byId['export-integrity'].dockerArgs).toEqual(['inspect', '--size', NAME]);
    // The hardened run carries the survivability flags.
    expect(byId['run-hardened'].dockerArgs).toContain('--health-cmd');
    expect(byId['run-hardened'].dockerArgs?.join(' ')).toContain('-XX:+ExitOnOutOfMemoryError');
    expect(byId['run-hardened'].dockerArgs?.join(' ')).toContain(`${VOLUME}:${BLAZEGRAPH_DATA_DIR}`);
  });

  it('resumes from backup-only with only the non-destructive tail', () => {
    const steps = planHardenMigration({ ...input, state: 'backup-only' });
    expect(steps.map((s) => s.id)).toEqual([
      'volume-create', 'seed-volume', 'run-hardened', 'verify',
    ]);
  });

  it('verifies only for an already-hardened container and is empty for absent', () => {
    expect(planHardenMigration({ ...input, state: 'hardened' }).map((s) => s.id)).toEqual(['verify']);
    expect(planHardenMigration({ ...input, state: 'absent' })).toEqual([]);
  });

  it('seed script OVERWRITES the volume journal when its size differs from the current export (MAJOR-3)', () => {
    const steps = planHardenMigration(input);
    const script = steps.find((s) => s.id === 'seed-volume')!.dockerArgs!.at(-1)!;
    // Copy when the journal is missing OR its size mismatches the export —
    // a rollback-stale volume copy must never dead-end the re-run.
    expect(script).toContain(`if [ ! -f ${BLAZEGRAPH_JOURNAL_FILE} ] || `);
    expect(script).toContain(
      `[ "$(stat -c %s ${BLAZEGRAPH_JOURNAL_FILE})" != "$(stat -c %s /seed/${HARDEN_EXPORT_FILENAME})" ]`,
    );
    // Still atomic (copy-to-tmp && mv) and still chowns to the tomcat uid:gid.
    expect(script).toContain(`.seed.tmp && mv ${BLAZEGRAPH_DATA_DIR}/.seed.tmp ${BLAZEGRAPH_JOURNAL_FILE}`);
    expect(script).toContain('chown 100:1000');
    // Final size echo is unconditional so the executor validates against
    // the CURRENT export.
    expect(script.trimEnd().endsWith(`stat -c %s ${BLAZEGRAPH_JOURNAL_FILE}`)).toBe(true);
  });
});

describe('parseHardenPortOption (MINOR-12: validated BEFORE any migration step)', () => {
  it('accepts plain decimal ports in range', () => {
    expect(parseHardenPortOption('9999')).toBe(9999);
    expect(parseHardenPortOption(' 80 ')).toBe(80);
    expect(parseHardenPortOption('65535')).toBe(65535);
    expect(parseHardenPortOption('1')).toBe(1);
  });

  it('rejects everything else with a commander parse error (fails the command upfront)', () => {
    for (const bad of ['0', '65536', '-1', '9999abc', 'abc', '', '0x10', '1e3', '3.5', '9999 9']) {
      expect(() => parseHardenPortOption(bad), `input ${JSON.stringify(bad)}`)
        .toThrow(/--port must be/);
    }
  });
});

describe('inspectHardenState', () => {
  it('classifies the fleet legacy shape (Mounts []) as legacy with its host port', async () => {
    const runner: DockerRunner = {
      async run(args) {
        return args[1] === NAME
          ? ok(inspectJson({ running: true, hostPort: '9999' }))
          : notFound;
      },
    };
    await expect(inspectHardenState(runner, NAME)).resolves.toEqual({
      state: 'legacy', hostPort: 9999, running: true,
    });
  });

  it('classifies a named-volume /data mount as hardened', async () => {
    const runner: DockerRunner = {
      async run() { return ok(inspectJson({ hardened: true })); },
    };
    await expect(inspectHardenState(runner, NAME)).resolves.toMatchObject({ state: 'hardened' });
  });

  it('classifies missing container + existing backup as backup-only', async () => {
    const runner: DockerRunner = {
      async run(args) {
        return args[1] === BACKUP ? ok(inspectJson({ running: false })) : notFound;
      },
    };
    await expect(inspectHardenState(runner, NAME)).resolves.toMatchObject({ state: 'backup-only' });
  });

  it('classifies neither container as absent', async () => {
    const runner: DockerRunner = { async run() { return notFound; } };
    await expect(inspectHardenState(runner, NAME)).resolves.toEqual({ state: 'absent' });
  });

  it('does not mistake a foreign volume mount for hardened', async () => {
    const runner: DockerRunner = {
      async run() {
        return ok(JSON.stringify([{
          State: { Running: true },
          Mounts: [{ Destination: BLAZEGRAPH_DATA_DIR, Name: 'some-other-volume' }],
          NetworkSettings: { Ports: {} },
        }]));
      },
    };
    await expect(inspectHardenState(runner, NAME)).resolves.toMatchObject({ state: 'legacy' });
  });

  it('reads the host port from durable HostConfig.PortBindings when the container is stopped (MAJOR-6)', async () => {
    // Stopped containers report EMPTY NetworkSettings.Ports — the old code
    // silently fell back to 9999 here.
    const runner: DockerRunner = {
      async run(args) {
        return args[1] === NAME
          ? ok(inspectJson({ running: false, networkPortsEmpty: true, hostPort: '10123' }))
          : notFound;
      },
    };
    await expect(inspectHardenState(runner, NAME)).resolves.toEqual({
      state: 'legacy', hostPort: 10123, running: false,
    });
  });

  it('reports hostPort undefined (never a guessed 9999) when no source yields one', async () => {
    const runner: DockerRunner = {
      async run(args) {
        return args[1] === NAME
          ? ok(inspectJson({ running: false, noPorts: true }))
          : notFound;
      },
    };
    const info = await inspectHardenState(runner, NAME);
    expect(info.state).toBe('legacy');
    expect(info.hostPort).toBeUndefined();
  });
});

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

  it('is a no-op (verify only) for an already-hardened container', async () => {
    const { runner, calls } = scriptedDocker({ initial: 'hardened', migrationDir });
    const { fn } = verifierFetch();
    const result = await executeHardenMigration(baseOpts(runner, fn));
    expect(result.outcome).toBe('already-hardened');
    for (const forbidden of ['stop', 'cp', 'rename', 'rm', 'update']) {
      expect(calls.some((c) => c[0] === forbidden)).toBe(false);
    }
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

  it('resumes from backup-only without repeating destructive steps', async () => {
    // Simulated crash after the rename: export exists, volume not yet run.
    writeFileSync(join(migrationDir, HARDEN_EXPORT_FILENAME), Buffer.alloc(JOURNAL_BYTES, 1));
    const { runner, calls } = scriptedDocker({ initial: 'backup-only', migrationDir });
    const { fn } = verifierFetch();
    const result = await executeHardenMigration(baseOpts(runner, fn));
    expect(result.outcome).toBe('hardened');
    // Nothing destructive re-runs: no stop, no cp, no rename of the backup.
    expect(calls.some((c) => c[0] === 'stop')).toBe(false);
    expect(calls.some((c) => c[0] === 'cp')).toBe(false);
    expect(calls.some((c) => c[0] === 'rename')).toBe(false);
    // The tail still runs: volume create → seed → hardened run.
    expect(calls.some((c) => c[0] === 'volume')).toBe(true);
    expect(calls.some((c) => c[0] === 'run' && c[1] === '--rm')).toBe(true);
    expect(calls.some((c) => c[0] === 'run' && c[1] === '-d')).toBe(true);
    assertSafetyInvariants(calls, migrationDir, true);
  });

  it('re-running after success is a verify-only no-op', async () => {
    const { runner, calls } = scriptedDocker({ initial: 'legacy', migrationDir });
    const { fn } = verifierFetch();
    await executeHardenMigration(baseOpts(runner, fn));
    const before = calls.length;
    const second = await executeHardenMigration(baseOpts(runner, fn));
    expect(second.outcome).toBe('already-hardened');
    const secondCalls = calls.slice(before);
    expect(secondCalls.every((c) => c[0] === 'inspect')).toBe(true);
  });

  it('refuses to guess when resuming backup-only without an export on disk', async () => {
    const { runner, calls } = scriptedDocker({ initial: 'backup-only', migrationDir });
    const { fn } = verifierFetch();
    await expect(executeHardenMigration(baseOpts(runner, fn)))
      .rejects.toThrow(/no journal export.*restore it manually/is);
    // Only inspects ran; the backup is untouched.
    expect(calls.every((c) => c[0] === 'inspect')).toBe(true);
  });

  it('errors actionably when the container does not exist at all', async () => {
    const { runner } = scriptedDocker({ initial: 'absent', migrationDir });
    const { fn } = verifierFetch();
    await expect(executeHardenMigration(baseOpts(runner, fn)))
      .rejects.toThrow(/not found.*nothing to harden/is);
  });
});
