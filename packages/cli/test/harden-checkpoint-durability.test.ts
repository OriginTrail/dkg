import * as fs from 'node:fs/promises';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeHardenMigration, HARDEN_DISK_PREFLIGHT_FACTOR, planHardenMigration } from '../src/daemon/blazegraph-harden.js';
import { HARDEN_DISK_PREFLIGHT_FACTOR as actionFactor } from '../src/daemon/harden/actions.js';
import { assertStoreMigrationInactive, storeHardenLockPath } from '../src/daemon/store-maintenance-gate.js';
import { scriptedDocker, NAME, NAMESPACE, JOURNAL_BYTES, verifierFetch } from './_helpers/blazegraph-harden-fixtures.js';
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, open: vi.fn(actual.open) };
});
const originalOpen = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open;
let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'harden-checkpoint-')); });
afterEach(() => { vi.mocked(fs.open).mockImplementation(originalOpen); vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }); });
function observeSync(fail?: (path: string, index: number) => string | undefined) {
  const events: string[] = [];
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const file = await originalOpen(...args), path = String(args[0]), sync = file.sync.bind(file);
    file.sync = async () => {
      events.push(path);
      const code = fail?.(path, events.filter(p => p === path).length);
      if (code) throw Object.assign(new Error(`injected ${code} persistence refusal`), { code });
      await sync();
    };
    return file;
  });
  return events;
}
const options = () => ({ containerName: NAME, namespace: NAMESPACE, migrationDir: home, dkgHome: home,
  fetch: verifierFetch().fn, log() {}, freeDiskBytes: async () => 1e12, readyTimeoutMs: 100, readyIntervalMs: 1 });
describe('pre-swap owned migration export persistence', () => {
  it('flushes export and checkpoint with both parents before swapping, then releases refreshed ownership', async () => {
    const events = observeSync(), marker = storeHardenLockPath(home), exported = join(home, 'bigdata.jnl');
    let checked = false;
    const f = scriptedDocker({ initial: 'legacy', migrationDir: home, failOn: args => {
      if (args[0] === 'rename') {
        checked = true;
        expect(JSON.parse(readFileSync(marker, 'utf8')).recovery).toMatchObject({ exportBytes: JOURNAL_BYTES, namespace: NAMESPACE });
        const exportSync = events.indexOf(exported), checkpoint = events.findIndex(path => path.startsWith(`${marker}.tmp.`));
        expect(exportSync).toBeGreaterThanOrEqual(0); expect(checkpoint).toBeGreaterThan(exportSync);
        expect(events[exportSync + 1]).toBe(dirname(exported)); expect(events[checkpoint + 1]).toBe(dirname(marker));
      }
      return null;
    } });
    await expect(executeHardenMigration({ ...options(), docker: f.runner })).resolves.toMatchObject({ outcome: 'hardened' });
    expect(checked).toBe(true);
    await expect(assertStoreMigrationInactive(home)).resolves.toBeUndefined();
  });
  it.each(['export-file', 'export-directory', 'checkpoint-file', 'checkpoint-directory'] as const)('retains the startup fence and never swaps if %s cannot sync', async boundary => {
    const marker = storeHardenLockPath(home), exported = join(home, 'bigdata.jnl');
    const code = boundary.endsWith('directory') ? 'ENOTSUP' : 'EIO';
    observeSync((path, index) => (boundary === 'export-file' && path === exported
      || boundary === 'export-directory' && path === home && index === 2
      || boundary === 'checkpoint-file' && path.startsWith(`${marker}.tmp.`)
      || boundary === 'checkpoint-directory' && path === home && index === 3) ? code : undefined);
    const f = scriptedDocker({ initial: 'legacy', migrationDir: home });
    await expect(executeHardenMigration({ ...options(), docker: f.runner })).rejects.toThrow(code);
    expect(f.calls.some(args => args[0] === 'rename' || args[0] === 'update' || args[0] === 'run' && args[1] === '-d')).toBe(false);
    await expect(assertStoreMigrationInactive(home)).rejects.toThrow(/Store hardening marker/);
    expect(readFileSync(exported).length).toBe(JOURNAL_BYTES);
  });
  it('retains the historical exported disk factor, plan description and actual preflight', async () => {
    expect(HARDEN_DISK_PREFLIGHT_FACTOR).toBe(2.2); expect(actionFactor).toBe(HARDEN_DISK_PREFLIGHT_FACTOR);
    const f = scriptedDocker({ initial: 'legacy', migrationDir: home });
    const plan = planHardenMigration({ containerName: NAME, namespace: NAMESPACE, hostPort: 9999, heapMb: 2048, migrationDir: home, state: 'legacy' });
    expect(plan.find(step => step.id === 'disk-preflight')?.description).toContain('>= 2.2x journal size');
    await expect(executeHardenMigration({ ...options(), docker: f.runner, freeDiskBytes: async () => Math.ceil(JOURNAL_BYTES * actionFactor) - 1 }))
      .rejects.toThrow(/Not enough free disk/);
    expect(f.calls.some(args => args[0] === 'stop')).toBe(false);
  });
});
