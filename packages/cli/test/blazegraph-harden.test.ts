/** Hardening plans, port validation and state inspection. */
import { describe, it, expect } from 'vitest';
import { inspectHardenState, planHardenMigration, HARDEN_EXPORT_FILENAME } from '../src/daemon/blazegraph-harden.js';
import { BLAZEGRAPH_DATA_DIR, BLAZEGRAPH_IMAGE, BLAZEGRAPH_JOURNAL_FILE, type DockerRunner } from '../src/daemon/blazegraph-docker.js';
import { parseHardenPortOption } from '../src/commands/store.js';
import { NAME, BACKUP, VOLUME, NAMESPACE, inspectJson, notFound, ok } from './_helpers/blazegraph-harden-fixtures.js';

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
    expect(byId['run-hardened'].dockerArgs?.join(' ')).toContain(`source=${VOLUME},target=${BLAZEGRAPH_DATA_DIR}`);
  });

  it('plans the stopped backup as the authoritative export source', () => {
    const byId = Object.fromEntries(planHardenMigration({ ...input, state: 'backup-only' }).map(step => [step.id, step]));
    expect(byId['stop'].dockerArgs).toEqual(['stop', '-t', '120', BACKUP]);
    expect(byId['export-journal'].dockerArgs).toEqual(['cp', `${BACKUP}:${BLAZEGRAPH_JOURNAL_FILE}`, '/tmp/harden/bigdata.jnl']);
    expect(byId['disk-preflight']).toBeUndefined();
    expect(byId['run-hardened'].dockerArgs).toContain(NAME);
  });

  it('resumes from backup-only by re-exporting the current stopped backup', () => {
    const steps = planHardenMigration({ ...input, state: 'backup-only' });
    expect(steps.map((s) => s.id)).toEqual([
      'stop', 'export-journal', 'export-integrity',
      'volume-create', 'seed-volume', 'disable-backup-restart', 'run-hardened', 'verify',
    ]);
  });

  it('verifies only for an already-hardened container and is empty for absent', () => {
    expect(planHardenMigration({ ...input, state: 'hardened' }).map((s) => s.id)).toEqual(['verify']);
    expect(planHardenMigration({ ...input, state: 'absent' })).toEqual([]);
  });

  it('seed script ALWAYS overwrites the volume journal — no size-match or if-present skip', () => {
    const steps = planHardenMigration(input);
    const script = steps.find((s) => s.id === 'seed-volume')!.dockerArgs!.at(-1)!;
    // No conditional skip of ANY kind. Equal byte size does not imply equal
    // content: RWStore rewrites pages in place, so a verify-failure rollback
    // leaves a stale volume copy that can share its exact size with the next
    // run's fresh export — a size-match skip would put the STALE copy live
    // and verification (identity tag + size >= export) cannot tell them
    // apart. The script must therefore start with the copy itself.
    expect(script.startsWith(`cp /seed/${HARDEN_EXPORT_FILENAME} `)).toBe(true);
    expect(script).not.toContain('if ');
    expect(script).not.toContain('!=');
    // Still atomic (copy-to-tmp && mv) and still chowns to the tomcat uid:gid.
    expect(script).toContain(`.seed.tmp && mv ${BLAZEGRAPH_DATA_DIR}/.seed.tmp ${BLAZEGRAPH_JOURNAL_FILE}`);
    expect(script).toContain('chown 100:1000');
    // The whole chain is &&-linked: a failed cp/mv/chown must fail the step's
    // exit code, never fall through to echoing a (possibly stale) journal
    // size that the executor would then validate as a successful seed.
    expect(script).toContain(
      `chown 100:1000 ${BLAZEGRAPH_JOURNAL_FILE} && stat -c %s ${BLAZEGRAPH_JOURNAL_FILE}`,
    );
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
