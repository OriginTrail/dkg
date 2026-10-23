import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openInventoryV1 } from '@origintrail-official/dkg-agent/dist/rfc64/inventory-v1/index.js';

const wiring = vi.hoisted(() => ({
  root: '',
  role: 'core' as 'core' | 'edge',
  install: 'updated' as string,
  stops: true,
  calls: [] as string[],
}));

function leaseState(): string {
  const lease = new DatabaseSync(join(wiring.root, 'rfc64-sync', 'inventory-v1.lease.sqlite3'));
  try {
    lease.exec('PRAGMA busy_timeout = 0');
    lease.exec('BEGIN EXCLUSIVE');
    lease.exec('ROLLBACK');
    return 'lease free';
  } catch {
    return 'lease held';
  } finally {
    lease.close();
  }
}

vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...actual,
    loadConfig: async () => ({ nodeRole: wiring.role }),
    activeSlot: async () => 'a',
    releasesDir: () => `${wiring.root}/releases`,
    dkgDir: () => wiring.root,
    slotEntryPoint: (slotDir: string) => `${slotDir}/dist/cli.js`,
    swapSlot: async (target: 'a' | 'b') => { wiring.calls.push(`swap:${target}`, leaseState()); },
  };
});

vi.mock('../src/cli-helpers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/cli-helpers.js')>();
  return {
    ...actual,
    stopDaemonIfRunning: async () => { wiring.calls.push('stop'); return wiring.stops; },
  };
});

vi.mock('../src/rollback-node-ui.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/rollback-node-ui.js')>();
  return { ...actual, ensureRollbackNodeUiBundle: () => true };
});

vi.mock('../src/daemon.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/daemon.js')>();
  return {
    ...actual,
    getCurrentCliVersion: () => '10.0.26',
    performNpmUpdateEdge: async (target: string) => {
      wiring.calls.push(`install:${target}`, leaseState());
      return wiring.install;
    },
  };
});

import { registerMaintenanceCommands } from '../src/commands/maintenance.js';
import { checkRollbackStores, readSlotVersion } from '../src/update/rollback-stores.js';

class ProcessExit extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

const output = { log: [] as string[], error: [] as string[] };

function inventoryPath(): string {
  return join(wiring.root, 'rfc64-sync', 'inventory-v1.sqlite3');
}

function inventoryUserVersion(): number {
  return readFileSync(inventoryPath()).readUInt32BE(60);
}

/** A node home whose inventory 10.0.26 created or migrated: schema v6. */
async function writeInventoryV6(): Promise<void> {
  (await openInventoryV1(wiring.root)).close();
}

function changeInventory(sql: string): void {
  const database = new DatabaseSync(inventoryPath());
  database.exec(sql);
  database.close();
}

async function writeTargetSlot(version: string): Promise<void> {
  await mkdir(join(wiring.root, 'releases', 'b', 'packages', 'cli'), { recursive: true });
  await writeFile(join(wiring.root, 'releases', 'b', 'packages', 'cli', 'package.json'), JSON.stringify({ version }));
}

async function rollback(...args: string[]): Promise<number | undefined> {
  const program = new Command();
  registerMaintenanceCommands(program);
  try {
    await program.parseAsync(['node', 'dkg', 'rollback', ...args]);
    return undefined;
  } catch (error) {
    if (error instanceof ProcessExit) return error.code;
    throw error;
  }
}

beforeEach(async () => {
  wiring.root = await mkdtemp(join(tmpdir(), 'dkg-rollback-stores-'));
  wiring.role = 'core';
  wiring.install = 'updated';
  wiring.stops = true;
  wiring.calls.length = 0;
  output.log.length = 0;
  output.error.length = 0;
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ProcessExit(code);
  }) as never);
  vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { output.log.push(parts.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => { output.error.push(parts.join(' ')); });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(wiring.root, { recursive: true, force: true });
});

describe('dkg rollback readies the local stores for the target version', () => {
  it('lowers the inventory for a Core slot of 10.0.25 and holds it until the slot is switched', async () => {
    await writeInventoryV6();
    await writeTargetSlot('10.0.25');

    expect(await rollback()).toBeUndefined();

    expect(wiring.calls).toEqual(['stop', 'swap:b', 'lease held']);
    expect(leaseState()).toBe('lease free');
    expect(inventoryUserVersion()).toBe(5);
    expect(output.log).toContain(
      'Lowered the RFC-64 inventory database from schema v6 to v5 for 10.0.25, keeping every row 10.0.25 reads.',
    );
    expect(readFileSync(join(wiring.root, '.current-version'), 'utf-8')).toBe('10.0.25');
  });

  it('leaves the inventory alone when the target slot opens its schema', async () => {
    await writeInventoryV6();
    await writeTargetSlot('10.0.26');

    expect(await rollback()).toBeUndefined();

    expect(wiring.calls).toEqual(['stop', 'swap:b', 'lease held']);
    expect(inventoryUserVersion()).toBe(6);
    expect(output.log.join('\n')).not.toContain('RFC-64 inventory');
  });

  it('refuses before stopping the node when no down-migration or copy fits the target', async () => {
    await mkdir(join(wiring.root, 'rfc64-sync'), { recursive: true, mode: 0o700 });
    const database = new DatabaseSync(inventoryPath());
    database.exec(`CREATE TABLE future_schema (value TEXT); PRAGMA application_id = ${0x444b3634}; PRAGMA user_version = 7`);
    database.close();
    await writeTargetSlot('10.0.25');

    expect(await rollback()).toBe(1);

    expect(wiring.calls).toEqual([]);
    expect(output.error).toEqual([
      `Rollback refused: RFC-64 inventory database ${inventoryPath()} has schema v7; no exact down-migration `
        + 'and no pre-migration copy brings it to schema v5 or older.',
      `10.0.25 opens inventory schema v5 at most. To roll back anyway, move ${inventoryPath()} aside first: `
        + '10.0.25 then starts with an empty inventory and syncs its catalog state again, and work recorded '
        + 'only in that database, such as pending private placement repairs, is lost.',
      'Nothing was changed.',
    ]);
  });

  it('keeps the current slot when the exact schema check fails after the node stopped', async () => {
    await writeInventoryV6();
    changeInventory('CREATE INDEX rollback_test_extra ON rfc64_private_placement_failures_v1 (state_json)');
    await writeTargetSlot('10.0.25');

    expect(await rollback()).toBe(1);

    expect(wiring.calls).toEqual(['stop']);
    expect(inventoryUserVersion()).toBe(6);
    expect(output.error.at(-1)).toBe(
      'Nothing was changed. The daemon is stopped: run "dkg start" to start 10.0.26 again.',
    );
    expect(leaseState()).toBe('lease free');
  });

  it('lowers the inventory before an Edge reinstall of 10.0.25 and holds it through the install', async () => {
    wiring.role = 'edge';
    await writeInventoryV6();
    await writeFile(join(wiring.root, 'previous-version'), '10.0.25\n');

    expect(await rollback()).toBeUndefined();

    expect(wiring.calls).toEqual(['stop', 'install:10.0.25', 'lease held']);
    expect(leaseState()).toBe('lease free');
    expect(inventoryUserVersion()).toBe(5);
    expect(output.log.at(-1)).toBe('Rolled back to 10.0.25. Run "dkg start" to start with the rolled-back version.');
  });

  it('says how to start the current version again when the Edge reinstall fails', async () => {
    wiring.role = 'edge';
    wiring.install = 'failed';
    await writeInventoryV6();
    await writeFile(join(wiring.root, 'previous-version'), '10.0.25\n');

    expect(await rollback()).toBe(1);

    expect(leaseState()).toBe('lease free');
    expect(output.error.at(-1)).toBe(
      'Rollback failed. Check logs and retry. The daemon is stopped: run "dkg start" to start 10.0.26 again.',
    );
  });

  it('does not touch the stores when the Edge daemon does not stop in time', async () => {
    wiring.role = 'edge';
    wiring.stops = false;
    await writeInventoryV6();
    await writeFile(join(wiring.root, 'previous-version'), '10.0.25\n');

    expect(await rollback()).toBe(1);

    expect(wiring.calls).toEqual(['stop']);
    expect(inventoryUserVersion()).toBe(6);
    expect(output.error).toEqual([
      'Rollback aborted because the daemon did not stop before its configured shutdown deadline.',
    ]);
  });

  it('restores the pre-migration copy when the database is not exactly schema v6, and says where the replaced one is', async () => {
    await writeInventoryV6();
    changeInventory('DROP TABLE rfc64_private_placement_failures_v1; PRAGMA user_version = 5');
    (await openInventoryV1(wiring.root)).close();
    changeInventory('CREATE INDEX rollback_test_extra ON rfc64_private_placement_failures_v1 (state_json)');

    expect(await rollback('--stores-for', '10.0.25')).toBeUndefined();

    expect(inventoryUserVersion()).toBe(5);
    expect(output.log).toContain(
      'Restored the RFC-64 inventory database from its schema v5 pre-migration copy for 10.0.25; the replaced '
        + `schema v6 database is kept at ${join(wiring.root, 'rfc64-sync', 'inventory-v1.schema-v6.before-rollback.sqlite3')}.`,
    );
  });

  it('asks for the interrupted rebuild to finish first', async () => {
    await writeInventoryV6();
    await writeFile(`${inventoryPath()}.rebuild-required`, '{}');

    expect(await rollback('--stores-for', '10.0.25')).toBe(1);

    expect(inventoryUserVersion()).toBe(6);
    expect(output.error.slice(1)).toEqual([
      'Start 10.0.26 once so it finishes rebuilding the database, stop it, then run "dkg rollback" again.',
      'Nothing was changed.',
    ]);
  });

  it('readies the stores of a stopped node for a named version without switching versions', async () => {
    await writeInventoryV6();

    expect(await rollback('--stores-for', '10.0.25')).toBeUndefined();

    expect(wiring.calls).toEqual([]);
    expect(inventoryUserVersion()).toBe(5);
    expect(output.log.at(-1)).toBe('Local stores are ready for 10.0.25.');
  });

  it('refuses to ready the stores while the node runs', async () => {
    await writeInventoryV6();
    const running = await openInventoryV1(wiring.root);
    try {
      expect(await rollback('--stores-for', '10.0.25')).toBe(1);
    } finally {
      running.close();
    }

    expect(inventoryUserVersion()).toBe(6);
    expect(output.error).toEqual([
      `Rollback refused: RFC-64 inventory database ${inventoryPath()} is in use by another process.`,
      'Stop the node first. If a service manager restarts it, stop the service, then run "dkg rollback" again.',
      'Nothing was changed.',
    ]);
  });
});

describe('rollback store helpers', () => {
  it('reads the slot version from the git or the npm layout', async () => {
    const gitSlot = join(wiring.root, 'git-slot');
    const npmSlot = join(wiring.root, 'npm-slot');
    await mkdir(join(gitSlot, 'packages', 'cli'), { recursive: true });
    await writeFile(join(gitSlot, 'packages', 'cli', 'package.json'), JSON.stringify({ version: '10.0.25' }));
    await mkdir(join(npmSlot, 'node_modules', '@origintrail-official', 'dkg'), { recursive: true });
    await writeFile(
      join(npmSlot, 'node_modules', '@origintrail-official', 'dkg', 'package.json'),
      JSON.stringify({ version: '10.0.24' }),
    );

    expect(readSlotVersion(gitSlot)).toBe('10.0.25');
    expect(readSlotVersion(npmSlot)).toBe('10.0.24');
    expect(readSlotVersion(join(wiring.root, 'empty-slot'))).toBeNull();
  });

  it('plans for the oldest schema it can write when the target version is unknown', async () => {
    await writeInventoryV6();
    changeInventory('PRAGMA user_version = 7');
    const io = { log: vi.fn(), error: vi.fn() };

    expect(checkRollbackStores(wiring.root, null, '10.0.26', io)).toBe(false);

    expect(io.error).toHaveBeenCalledWith(expect.stringContaining(
      'the rollback target opens inventory schema v5 at most',
    ));
  });
});
