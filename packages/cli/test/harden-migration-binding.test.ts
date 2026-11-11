import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHardenMigration } from '../src/daemon/harden/steps.js';
import { HARDEN_VOLUME_ATTEMPT_LABEL } from '../src/daemon/harden/volume.js';
import { NAME, NAMESPACE, VOLUME, JOURNAL_BYTES, scriptedDocker, verifierFetch, ok } from './_helpers/blazegraph-harden-fixtures.js';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dkg-bound-migration-')); roots.push(root);
  const input = { containerName: NAME, namespace: NAMESPACE, hostPort: 9999, heapMb: 3072,
    migrationDir: root, dkgHome: join(root, 'home'), state: 'legacy' as const, running: true,
    volumeAttemptId: 'a70316d1-5c89-441f-b232-86a1f867ba56' };
  return { root, input };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('captured migration specification', () => {
  it('binds every executed command and check despite caller/input/displayed-argv changes', async () => {
    const { root, input } = fixture();
    const migration = buildHardenMigration(input);
    const { runner, calls } = scriptedDocker({ initial: 'legacy', migrationDir: root });
    const verifier = verifierFetch();
    const foreignPath = join(root, 'foreign.jnl');
    // Runtime extras can arrive from untyped callers; they are not part of execution dependencies.
    const runtimeExtras = { containerName: 'foreign', namespace: 'foreign', exportPath: foreignPath,
      volumeAttemptId: 'foreign', specification: { exportPath: foreignPath } };
    const execution = migration.bind({ ...runtimeExtras, docker: runner, fetchImpl: verifier.fn, log: () => {},
      freeDiskBytes: async () => 1_000_000,
    });
    expect(execution.context.specification).toBe(migration.specification);
    expect(Object.isFrozen(migration.specification)).toBe(true);
    input.containerName = 'foreign'; input.namespace = 'foreign'; input.hostPort = 7777;
    input.migrationDir = join(root, 'foreign'); input.volumeAttemptId = 'foreign';
    for (const displayed of [...migration.steps, ...execution.phases]) {
      displayed.dockerArgs?.splice(0, displayed.dockerArgs.length, 'rm', '-f', 'foreign');
    }
    for (const phase of execution.phases) await (phase.execute as (...ignored: unknown[]) => Promise<void>)({
      ...execution.context, specification: { ...migration.specification, exportPath: foreignPath,
        volumeAttemptId: 'foreign', sparqlUrl: 'http://127.0.0.1:7777/foreign' },
    });
    expect(execution.exported).toEqual({ path: join(root, 'bigdata.jnl'), bytes: JOURNAL_BYTES });
    expect(calls).toContainEqual(['cp', `${NAME}:/data/bigdata.jnl`, join(root, 'bigdata.jnl')]);
    expect(calls.some(args => args.includes('foreign') || args.includes(foreignPath))).toBe(false);
    expect(calls.some(args => args[0] === 'volume' && args[1] === 'create'
      && args.includes(`${HARDEN_VOLUME_ATTEMPT_LABEL}=a70316d1-5c89-441f-b232-86a1f867ba56`))).toBe(true);
    expect(verifier.calls.every(call => call.url.startsWith('http://127.0.0.1:9999/'))).toBe(true);
  });

  it('keeps rendering available without permitting execution without a captured config home', () => {
    const { input } = fixture();
    const { dkgHome: _home, ...planOnly } = input;
    const migration = buildHardenMigration(planOnly);
    let runs = 0;
    expect(migration.steps.length).toBeGreaterThan(0);
    expect(() => migration.bind({ docker: { async run() { runs += 1; return ok(); } },
      fetchImpl: globalThis.fetch, log: () => {},
    })).toThrow('Migration execution requires a config home');
    expect(runs).toBe(0);
  });

  it('refuses a foreign attempt label even if untyped execution input tries to certify it', async () => {
    const { input } = fixture();
    const migration = buildHardenMigration(input);
    const captured: string[][] = [];
    const runtimeExtras = { volumeAttemptId: 'foreign' };
    const execution = migration.bind({ docker: { async run(args) {
      captured.push([...args]);
      return ok(JSON.stringify([{ Name: VOLUME, Labels: { [HARDEN_VOLUME_ATTEMPT_LABEL]: 'foreign' } }]));
    } }, fetchImpl: globalThis.fetch, log: () => {}, ...runtimeExtras });
    const phase = execution.phases.find(phase => phase.id === 'volume-ownership')!;
    await expect((phase.execute as (...ignored: unknown[]) => Promise<void>)({
      ...execution.context, specification: { ...migration.specification, volumeAttemptId: 'foreign' },
    }))
      .rejects.toThrow(/does not belong to this fresh migration attempt/);
    expect(captured).toEqual([['volume', 'inspect', VOLUME]]);
  });
});
