import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertStoreMigrationInactive } from '../src/daemon/store-maintenance-gate.js';
import { claimStoreMigrationMarker, readStoreMigrationMarker, releaseStoreMigrationMarker,
  requireStoreMigrationRecoveryMarker, retainStoreMigrationRecoveryMarker, storeHardenLockPath,
  withStoreMigrationRecoveryLease } from '../src/daemon/store-migration-marker.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dkg-migration-marker-')); });
afterEach(() => rmSync(home, { recursive: true, force: true }));
const recovery = () => ({ version: 1 as const, recoveryRequired: true as const, pid: process.pid,
  containerName: 'dkg-store', namespace: 'owner', migrationDir: home, hostPort: 9999, exportBytes: 1024 });

describe('shared migration marker protocol at real filesystem boundaries', () => {
  it('retains exclusive active ownership and its historical serialized form until release', async () => {
    const path = storeHardenLockPath(home), owner = await claimStoreMigrationMarker(path, 'dkg-store');
    expect(readFileSync(path, 'utf8')).toBe(owner.rawText);
    expect(owner.rawText.endsWith('\n')).toBe(true);
    expect(Object.keys(JSON.parse(owner.rawText))).toEqual(['pid', 'containerName', 'startedAt']);
    expect(readStoreMigrationMarker(path)).toMatchObject({ kind: 'active', value: { pid: process.pid, containerName: 'dkg-store' } });
    await expect(claimStoreMigrationMarker(path, 'other')).rejects.toThrow(/EEXIST/);
    await expect(assertStoreMigrationInactive(home)).rejects.toThrow(/Store hardening marker/);
    await releaseStoreMigrationMarker(owner);
    expect(readStoreMigrationMarker(path)).toEqual({ kind: 'missing', path });
    await expect(assertStoreMigrationInactive(home)).resolves.toBeUndefined();
  });
  it('preserves old PID-only markers and separates known age from startup permission', async () => {
    const path = storeHardenLockPath(home); writeFileSync(path, '{"pid":123}\n');
    const time = (Date.now() - 7 * 60 * 60 * 1000) / 1000; utimesSync(path, time, time);
    expect(readStoreMigrationMarker(path)).toMatchObject({ kind: 'active', value: { pid: 123 }, ageMs: expect.any(Number) });
    await expect(assertStoreMigrationInactive(home)).rejects.toThrow(/Store hardening marker/);
  });
  it('retains recovery bytes/options and never clears an unknown export-size certificate', async () => {
    const path = storeHardenLockPath(home), owner = await claimStoreMigrationMarker(path, 'dkg-store');
    await retainStoreMigrationRecoveryMarker(owner, { ...recovery(), exportBytes: undefined });
    expect(readStoreMigrationMarker(path)).toMatchObject({ kind: 'recovery-required' });
    expect(JSON.parse(readFileSync(path, 'utf8'))).not.toHaveProperty('exportBytes');
    expect(() => requireStoreMigrationRecoveryMarker(path, recovery())).toThrow(/does not certify/);
    await expect(assertStoreMigrationInactive(home)).rejects.toThrow(/Store hardening marker/);
  });
  it.each(['containerName', 'namespace', 'migrationDir', 'hostPort'] as const)('rejects recovery options not owned by the original marker (%s)', async key => {
    const path = storeHardenLockPath(home), owner = await claimStoreMigrationMarker(path, 'dkg-store');
    await retainStoreMigrationRecoveryMarker(owner, recovery());
    const bytes = readFileSync(path, 'utf8'), options = { ...recovery(), [key]: key === 'hostPort' ? 9998 : 'different' };
    expect(() => requireStoreMigrationRecoveryMarker(path, options)).toThrow(/does not certify/);
    expect(readFileSync(path, 'utf8')).toBe(bytes);
  });
  it('fences a changed owner through transition, recovery and normal cleanup', async () => {
    const path = storeHardenLockPath(home), owner = await claimStoreMigrationMarker(path, 'dkg-store');
    const foreign = '{"pid":987,"containerName":"other"}'; writeFileSync(path, foreign);
    await expect(retainStoreMigrationRecoveryMarker(owner, recovery())).rejects.toThrow(/marker changed/);
    await expect(releaseStoreMigrationMarker(owner)).rejects.toThrow(/marker changed/);
    await expect(withStoreMigrationRecoveryLease(owner, async () => { throw new Error('must not start'); })).rejects.toThrow(/marker changed/);
    expect(readFileSync(path, 'utf8')).toBe(foreign);
    expect(existsSync(`${path}.recovery`)).toBe(false);
  });
  it('drains recovery work under a single lease and retains the certificate on failure', async () => {
    const path = storeHardenLockPath(home), owner = await claimStoreMigrationMarker(path, 'dkg-store');
    await retainStoreMigrationRecoveryMarker(owner, recovery());
    const evidence = requireStoreMigrationRecoveryMarker(path, recovery());
    await expect(withStoreMigrationRecoveryLease(evidence, async () => {
      expect(readFileSync(`${path}.recovery`, 'utf8')).toBe(String(process.pid));
      await expect(withStoreMigrationRecoveryLease(evidence, async () => {})).rejects.toThrow(/EEXIST/);
      await expect(assertStoreMigrationInactive(home)).rejects.toThrow(/Store hardening marker/);
      throw new Error('verification failed');
    })).rejects.toThrow('verification failed');
    expect(readFileSync(path, 'utf8')).toBe(evidence.rawText);
    expect(existsSync(`${path}.recovery`)).toBe(false);
    await withStoreMigrationRecoveryLease(evidence, () => releaseStoreMigrationMarker(evidence));
    await expect(assertStoreMigrationInactive(home)).resolves.toBeUndefined();
  });
  it.each(['{bad', '{}', 'null', '[]', '{"pid":123,"version":99}'])('keeps malformed readable evidence blocked at startup while retaining observed age (%s)', async text => {
    const path = storeHardenLockPath(home); writeFileSync(path, text);
    expect(readStoreMigrationMarker(path)).toMatchObject({ kind: 'unreadable', rawText: text, ageMs: expect.any(Number) });
    expect(() => requireStoreMigrationRecoveryMarker(path, recovery())).toThrow(/Invalid migration recovery marker/);
    await expect(assertStoreMigrationInactive(home)).rejects.toThrow(/Store hardening marker/);
  });
  it('does not treat an invalid parent path as a missing migration marker', async () => {
    const parent = join(home, 'not-a-directory'); writeFileSync(parent, 'unchanged');
    const path = storeHardenLockPath(parent);
    expect(readStoreMigrationMarker(path)).toEqual({ kind: 'unreadable', path, ageMs: null });
    await expect(assertStoreMigrationInactive(parent)).rejects.toThrow(/Store hardening marker/);
    expect(readFileSync(parent, 'utf8')).toBe('unchanged');
  });
  it('keeps filesystem uncertainty distinct from absent or ageable protocol evidence', async () => {
    const path = storeHardenLockPath(home); mkdirSync(path);
    expect(readStoreMigrationMarker(path)).toEqual({ kind: 'unreadable', path, ageMs: null });
    await expect(assertStoreMigrationInactive(home)).rejects.toThrow(/Store hardening marker/);
  });
});
