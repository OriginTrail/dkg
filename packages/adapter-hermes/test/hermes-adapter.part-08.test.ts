import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
vi.mock('@origintrail-official/dkg-core', async () => {
  const actual = await vi.importActual<typeof import('@origintrail-official/dkg-core')>(
    '@origintrail-official/dkg-core',
  );
  return {
    ...actual,
    resolveDkgConfigHome: vi.fn((opts) => actual.resolveDkgConfigHome(opts)),
    resolveDkgHome: vi.fn((opts) => actual.resolveDkgHome(opts)),
  };
});
import { resolveDkgHome } from '@origintrail-official/dkg-core';
import { HermesAdapterPlugin } from '../src/HermesAdapterPlugin.js';
import { registerHermesRoutes } from '../src/hermes-routes.js';
import { HermesDkgClient, redact } from '../src/dkg-client.js';
import {
  disconnectHermesProfile,
  planHermesSetup,
  runDoctor,
  runDisconnect,
  runReconnect,
  resolveHermesProfile,
  runSetup,
  runUninstall,
  runVerify,
  setupHermesProfile,
  uninstallHermesProfile,
  verifyHermesProfile,
} from '../src/setup.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
import { createTrackingApi, trackingRes, type TrackingApi } from './hermes-adapter.shared';

describe('Hermes profile setup helpers', () => {



  // H-AC-31: re-run after a replacement does NOT take a second backup.
  // First-wins on capture (priorMemoryProvider unchanged across re-runs).
  it('H-AC-31: re-run after replacement does not take a second backup (first-wins capture)', async () => {
    const { setupHermesProfile } = await import('../src/setup.js');
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-rerun-'));
    const configPath = join(hermesHome, 'config.yaml');
    writeFileSync(configPath, 'memory:\n  provider: redis\n');

    setupHermesProfile({ hermesHome });

    const firstRunBackups = readdirSync(hermesHome).filter((e) => /\.bak\./.test(e));
    expect(firstRunBackups.length).toBe(1);
    const firstStateRaw = readFileSync(join(hermesHome, '.dkg-adapter-hermes', 'setup-state.json'), 'utf-8');
    const firstState = JSON.parse(firstStateRaw);
    expect(firstState.priorMemoryProvider.provider).toBe('redis');

    // Second run on the now-DKG-selected profile.
    setupHermesProfile({ hermesHome });

    const secondRunBackups = readdirSync(hermesHome).filter((e) => /\.bak\./.test(e));
    expect(secondRunBackups).toEqual(firstRunBackups);
    const secondStateRaw = readFileSync(join(hermesHome, '.dkg-adapter-hermes', 'setup-state.json'), 'utf-8');
    const secondState = JSON.parse(secondStateRaw);
    // First-wins: same provider, same backup path, same capturedAt.
    expect(secondState.priorMemoryProvider).toEqual(firstState.priorMemoryProvider);
  }, 15_000);

  // H-AC-32: replacement is byte-equivalent across re-runs (idempotency
  // on top of replace-by-default). First run replaces; second run on
  // the now-DKG-selected profile must produce byte-identical config.yaml.
  it('H-AC-32: replacement is byte-equivalent across re-runs', async () => {
    const { setupHermesProfile } = await import('../src/setup.js');
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-byteq-'));
    const configPath = join(hermesHome, 'config.yaml');
    writeFileSync(configPath, 'memory:\n  provider: redis\n');

    setupHermesProfile({ hermesHome });
    const after1 = readFileSync(configPath);

    setupHermesProfile({ hermesHome });
    const after2 = readFileSync(configPath);

    expect(after2.equals(after1)).toBe(true);
  });

  // H-AC-33: replacement on a YAML config that already has DKG marked-
  // non-managed: setup adopts the existing line into the managed block
  // without writing a new provider value AND without taking a backup
  // (no actual provider switch occurred — already-DKG users are
  // upgraded in-place by `markExistingDkgProvider`, not "replaced").
  it('H-AC-33: already-DKG (non-managed) is adopted into the managed block without backup', async () => {
    const { setupHermesProfile } = await import('../src/setup.js');
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-already-dkg-'));
    const configPath = join(hermesHome, 'config.yaml');
    writeFileSync(configPath, 'memory:\n  provider: dkg\n');

    setupHermesProfile({ hermesHome });

    const after = readFileSync(configPath, 'utf-8');
    expect(after).toContain('# BEGIN DKG ADAPTER HERMES MANAGED');
    expect(after).toContain('# END DKG ADAPTER HERMES MANAGED');
    expect(after).toContain('provider: dkg');
    // No backup taken — the adoption path doesn't trigger replacement
    // semantics (no prior non-DKG provider was overwritten).
    const backups = readdirSync(hermesHome).filter((e) => /\.bak\./.test(e));
    expect(backups).toEqual([]);
    // No priorMemoryProvider captured either (nothing was actually
    // swapped — same provider before and after).
    const stateRaw = readFileSync(
      join(hermesHome, '.dkg-adapter-hermes', 'setup-state.json'),
      'utf-8',
    );
    expect(JSON.parse(stateRaw).priorMemoryProvider).toBeUndefined();
  });

  // H-AC-38: disconnect on a profile with no captured priorMemoryProvider
  // — restore is a noop, disconnect succeeds normally.
  it('H-AC-38: disconnect on profile with no priorMemoryProvider — restore is noop', async () => {
    const { setupHermesProfile, disconnectHermesProfile, restoreHermesProfile } = await import('../src/setup.js');
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-disconnect-noop-'));
    // No pre-existing config.yaml; fresh install means no prior provider captured.
    setupHermesProfile({ hermesHome });

    const disconnectPlan = disconnectHermesProfile({ hermesHome });
    expect(disconnectPlan.state.status).toBe('disconnected');

    const restoreResult = restoreHermesProfile({ hermesHome });
    expect(restoreResult.ok).toBe(true);
    expect(restoreResult.path).toBe('noop');
  });

  // H-AC-39: `dkg hermes uninstall` after a replacement restores prior
  // provider AND removes adapter-owned files. Verifies the post-uninstall
  // config.yaml has the captured provider AND the adapter-owned artifacts
  // (dkg.json, plugin dir, setup-state.json) are gone.
  it('H-AC-39: uninstall after replacement restores prior provider and removes adapter files', async () => {
    const { setupHermesProfile, restoreHermesProfile, uninstallHermesProfile } = await import('../src/setup.js');
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-uninstall-'));
    const configPath = join(hermesHome, 'config.yaml');
    writeFileSync(configPath, 'memory:\n  provider: openai-memory\n');

    setupHermesProfile({ hermesHome });

    // Mirror the CLI `runUninstall` order: restore BEFORE uninstall
    // so the captured backup is consumed while it still exists. After
    // uninstall, the adapter state dir is removed AND the prior
    // provider line is back in config.yaml.
    const restoreResult = restoreHermesProfile({ hermesHome });
    expect(restoreResult.ok).toBe(true);
    expect(['surgical', 'backup-file']).toContain(restoreResult.path);

    uninstallHermesProfile({ hermesHome });

    // Adapter artifacts gone.
    expect(existsSync(join(hermesHome, 'dkg.json'))).toBe(false);
    expect(existsSync(join(hermesHome, 'plugins', 'dkg'))).toBe(false);
    expect(existsSync(join(hermesHome, '.dkg-adapter-hermes'))).toBe(false);
    // Prior provider restored in config.yaml.
    const post = readFileSync(configPath, 'utf-8');
    expect(post).toContain('provider: openai-memory');
    expect(post).not.toContain('# BEGIN DKG ADAPTER HERMES MANAGED');
  });

  // ---------------------------------------------------------------------------
  // S4 step 3 — restoreHermesProfile primitive
  // (issue #386, contract §6 + QA addendum §10C #1 + H-AC-34..36).
  // ---------------------------------------------------------------------------

  // H-AC-34: restore after replacement puts back the prior provider via
  // the surgical line-rewrite path. Verifies the path discriminator is
  // 'surgical' and the post-restore config has the captured provider.
  it('H-AC-34: restoreHermesProfile via surgical path after replacement', async () => {
    const { setupHermesProfile, restoreHermesProfile } = await import('../src/setup.js');
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-restore-surgical-'));
    const configPath = join(hermesHome, 'config.yaml');
    writeFileSync(configPath, 'memory:\n  provider: redis\n  url: redis://x\n');

    setupHermesProfile({ hermesHome });
    const result = restoreHermesProfile({ hermesHome });

    expect(result.ok).toBe(true);
    expect(result.path).toBe('surgical');
    expect(result.restoredProvider).toBe('redis');
    const post = readFileSync(configPath, 'utf-8');
    expect(post).toContain('provider: redis');
    expect(post).not.toContain('# BEGIN DKG ADAPTER HERMES MANAGED');
  });

  // H-AC-35: restore falls back to backup-file when the surgical path
  // cannot find an active provider line (e.g. user manually deleted
  // the memory: block from config.yaml between setup and restore).
  it('H-AC-35: restoreHermesProfile falls back to backup-file when surgical path fails', async () => {
    const { setupHermesProfile, restoreHermesProfile } = await import('../src/setup.js');
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-restore-backup-'));
    const configPath = join(hermesHome, 'config.yaml');
    const original = 'memory:\n  provider: openai-memory\n  api_key: sk-fake\n';
    writeFileSync(configPath, original);

    setupHermesProfile({ hermesHome });
    // Simulate user deleting the entire memory: block after setup.
    // The managed block remains (since DKG was selected), but no
    // surgical-rewriteable provider line will exist after we strip it.
    writeFileSync(configPath, '# BEGIN DKG ADAPTER HERMES MANAGED\nmemory:\n  provider: dkg\n# END DKG ADAPTER HERMES MANAGED\n');

    const result = restoreHermesProfile({ hermesHome });

    expect(result.ok).toBe(true);
    expect(result.path).toBe('backup-file');
    expect(result.restoredFrom).toMatch(/config\.yaml\.bak\.\d+$/);
    // Whole-file restore: post-restore config matches the original bytes.
    const post = readFileSync(configPath, 'utf-8');
    expect(post).toBe(original);
  });

  // H-AC-36: restore reports `path: 'failed'` when both surgical AND
  // backup-file paths fail (e.g. operator deleted the backup file
  // AND the active config doesn't have an active provider line).
  it('H-AC-36: restoreHermesProfile returns failed when both paths fail', async () => {
    const { setupHermesProfile, restoreHermesProfile } = await import('../src/setup.js');
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-restore-failed-'));
    const configPath = join(hermesHome, 'config.yaml');
    writeFileSync(configPath, 'memory:\n  provider: claude-memory\n');

    setupHermesProfile({ hermesHome });
    // Delete the backup file (operator cleanup) AND strip the memory
    // block from config.yaml (so surgical also fails).
    const backups = readdirSync(hermesHome).filter((e) => /\.bak\./.test(e));
    expect(backups.length).toBe(1);
    rmSync(join(hermesHome, backups[0]));
    writeFileSync(configPath, '# unrelated config\nlogger:\n  level: info\n');

    const result = restoreHermesProfile({ hermesHome });

    expect(result.ok).toBe(false);
    expect(result.path).toBe('failed');
    expect(result.restoreError).toContain('surgical');
    expect(result.restoreError).toContain('backup-file');
  });

  // restoreHermesProfile noop: nothing to restore when no
  // priorMemoryProvider was captured (fresh install).
  it('restoreHermesProfile noop on fresh install', async () => {
    const { setupHermesProfile, restoreHermesProfile } = await import('../src/setup.js');
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-restore-noop-'));
    // No pre-existing config.yaml; setup writes a fresh DKG-only one.
    setupHermesProfile({ hermesHome });

    const result = restoreHermesProfile({ hermesHome });

    expect(result.ok).toBe(true);
    expect(result.path).toBe('noop');
    expect(result.restoredProvider).toBeUndefined();
    expect(result.restoredFrom).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // S4 close — adversarial-flagged regressions (issue #386,
  // adversarial-findings.md vectors 1, 5, 6).
  // ---------------------------------------------------------------------------

  // H-AC-26: --dry-run with a pre-seeded non-DKG memory.provider does
  // NOT write a `config.yaml.bak.*` (matrix calls this out as the
  // "critical brief callout"). Adversarial reviewer's vector 1 prevention
  // proof — this seals the seam against a future refactor that drops
  // the dry-run short-circuit before the destructive rewrite.
  it('H-AC-26: --dry-run with pre-seeded non-DKG provider writes no backup', async () => {
    const { runHermesSetup } = await import('../src/setup.js');
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-dryrun-replace-'));
    const configPath = join(hermesHome, 'config.yaml');
    const original = 'memory:\n  provider: redis\n';
    writeFileSync(configPath, original);

    const result = await runHermesSetup({ hermesHome, dryRun: true });

    // Dry-run completed without throwing.
    expect(result.daemonStarted).toBe(false);
    // No backup written.
    const backups = readdirSync(hermesHome).filter((e) => /^config\.yaml\.bak\./.test(e));
    expect(backups).toEqual([]);
    // config.yaml unchanged.
    expect(readFileSync(configPath, 'utf-8')).toBe(original);
  });

  // H-AC-48: backup file lands inside the resolved profile directory
  // when `--profile <name>` was passed, NOT under the default
  // `~/.hermes/`. Adversarial reviewer's vector 5 prevention proof —
  // this seals the seam against a future refactor of `resolveHermesProfile`
  // that introduces a `~/.hermes` shortcut bypassing profile resolution.
  it('H-AC-48: --profile <name> + replacement → backup lands inside profile dir', async () => {
    const { runHermesSetup } = await import('../src/setup.js');
    const profileHome = mkdtempSync(join(tmpdir(), 'hermes-profile-research-'));
    const configPath = join(profileHome, 'config.yaml');
    writeFileSync(configPath, 'memory:\n  provider: openai-memory\n');

    // Pass `hermesHome` directly to override `--profile`'s default
    // `~/.hermes/profiles/research` — same effective semantics for
    // path-routing purposes (the H-AC-48 invariant is "backup goes
    // under the resolved hermesHome, never under the default home").
    await runHermesSetup({
      hermesHome: profileHome,
      profile: 'research',
      start: false,
      fund: false,
      verify: false,
    });

    // Backup must be inside the explicit profileHome — NOT under
    // `~/.hermes` or any other default.
    const backups = readdirSync(profileHome).filter((e) => /^config\.yaml\.bak\.\d+$/.test(e));
    expect(backups.length).toBe(1);
    // Defense-in-depth: the captured configBackupPath in setup-state
    // must also point inside profileHome.
    const stateRaw = readFileSync(
      join(profileHome, '.dkg-adapter-hermes', 'setup-state.json'),
      'utf-8',
    );
    const state = JSON.parse(stateRaw);
    expect(state.priorMemoryProvider.configBackupPath.startsWith(profileHome)).toBe(true);
  });

  // Vector 6 regression: SIGINT-safe ordering. Simulate the
  // partial-state interrupt (dkg.json + managed config.yaml + orphan
  // .bak.<ts> WITHOUT setup-state.json) and assert that re-running
  // setupHermesProfile recovers cleanly: the orphan backup is
  // preserved, AND priorMemoryProvider is restored from the orphan
  // (or — under the adversarial-findings.md option-2 fix — the
  // intent-write recovery path takes over).
  //
  // With the option-2 fix in place, the new contract is: re-running
  // setupHermesProfile after a SIGINT-induced partial state finds
  // the orphan backup at `<configPath>.bak.*`. Because `existingState`
  // is null AFTER the interrupt (setup-state.json never landed), the
  // re-run treats the situation as a fresh install where the active
  // config is already DKG-managed. The orphan backup is preserved on
  // disk so the operator can manually invoke `restoreHermesProfile`
  // pointing at it, OR the adversarial-reviewer's option-1 backup-scan
  // can be added later. This test pins the current option-2 behavior:
  // re-run does NOT delete or churn the orphan backup, and writes
  // setup-state.json with `priorMemoryProvider` derived from
  // `peekProviderSwapIntent` (which returns null when the active
  // config is already DKG-managed → no new capture).
  it('vector-6 regression: SIGINT mid-execute leaves orphan backup; re-run preserves it', async () => {
    const { setupHermesProfile } = await import('../src/setup.js');
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-sigint-'));
    const configPath = join(hermesHome, 'config.yaml');

    // Simulate the partial-interrupt state: dkg.json + managed
    // config.yaml + orphan .bak.<ts>. setup-state.json deliberately
    // absent, mirroring an interrupt between the destructive rewrite
    // and the state-write under the PRE-fix code path.
    mkdirSync(join(hermesHome, '.dkg-adapter-hermes'), { recursive: true });
    // dkg.json — owner-marked so re-run doesn't refuse-to-overwrite.
    writeFileSync(
      join(hermesHome, 'dkg.json'),
      JSON.stringify({
        managedBy: '@origintrail-official/dkg-adapter-hermes',
        daemon_url: 'http://127.0.0.1:9200',
      }) + '\n',
    );
    // Plugin dir — ownership-marked so the re-run doesn't refuse.
    mkdirSync(join(hermesHome, 'plugins', 'dkg'), { recursive: true });
    writeFileSync(
      join(hermesHome, 'plugins', 'dkg', '.dkg-adapter-hermes-owner.json'),
      JSON.stringify({
        managedBy: '@origintrail-official/dkg-adapter-hermes',
      }) + '\n',
    );
    // Active config: already-DKG with the managed block (post-rewrite).
    writeFileSync(
      configPath,
      'memory:\n  # BEGIN DKG ADAPTER HERMES MANAGED\n  provider: dkg\n  # END DKG ADAPTER HERMES MANAGED\n',
    );
    // Orphan backup: redis config that the interrupted setup captured.
    const orphanBackupPath = `${configPath}.bak.1700000000000`;
    writeFileSync(orphanBackupPath, 'memory:\n  provider: redis\n  url: redis://x\n');

    // Re-run setup (no `setup-state.json` exists yet — the SIGINT-induced
    // partial state).
    setupHermesProfile({ hermesHome });

    // Orphan backup MUST still be on disk — re-run did not delete it.
    expect(existsSync(orphanBackupPath)).toBe(true);
    expect(readFileSync(orphanBackupPath, 'utf-8')).toBe(
      'memory:\n  provider: redis\n  url: redis://x\n',
    );
    // setup-state.json now exists.
    const stateRaw = readFileSync(
      join(hermesHome, '.dkg-adapter-hermes', 'setup-state.json'),
      'utf-8',
    );
    const state = JSON.parse(stateRaw);
    expect(state.managedBy).toBe('@origintrail-official/dkg-adapter-hermes');
    // Under the option-2 fix, `peekProviderSwapIntent` reads the
    // already-DKG active config and returns null — no new capture.
    // The operator can manually invoke restoreHermesProfile pointing
    // at the orphan, or a future option-1 backup-scan helper can
    // promote the orphan into priorMemoryProvider. Either way, the
    // orphan is preserved on disk (above) — no silent loss.
    expect(state.priorMemoryProvider).toBeUndefined();
  });

  // Vector 6 regression — happy path: SIGINT BEFORE the destructive
  // rewrite (i.e., AFTER the pre-write of setup-state.json with
  // intended priorMemoryProvider) leaves recoverable state. The
  // option-2 fix's whole point: a re-run sees existingState
  // .priorMemoryProvider already populated and first-wins keeps it.
  it('vector-6 regression: pre-write intent survives interrupt; re-run preserves first-wins capture', async () => {
    const { setupHermesProfile, restoreHermesProfile } = await import('../src/setup.js');
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-sigint-prewrite-'));
    const configPath = join(hermesHome, 'config.yaml');
    const originalRedis = 'memory:\n  provider: redis\n';
    writeFileSync(configPath, originalRedis);

    // First setup completes normally, but we capture the
    // priorMemoryProvider snapshot for the assertion below.
    setupHermesProfile({ hermesHome });
    const firstStateRaw = readFileSync(
      join(hermesHome, '.dkg-adapter-hermes', 'setup-state.json'),
      'utf-8',
    );
    const firstState = JSON.parse(firstStateRaw);
    expect(firstState.priorMemoryProvider.provider).toBe('redis');
    const firstBackup = firstState.priorMemoryProvider.configBackupPath;
    expect(existsSync(firstBackup)).toBe(true);

    // Re-run after a hypothetical interrupt: setup-state.json exists
    // (pre-write happened), config.yaml is managed-DKG. First-wins
    // semantics keep the original priorMemoryProvider, NOT a new
    // capture from the post-rewrite state.
    setupHermesProfile({ hermesHome });
    const secondStateRaw = readFileSync(
      join(hermesHome, '.dkg-adapter-hermes', 'setup-state.json'),
      'utf-8',
    );
    const secondState = JSON.parse(secondStateRaw);
    expect(secondState.priorMemoryProvider).toEqual(firstState.priorMemoryProvider);

    // Restore via the original captured backup still works.
    const restored = restoreHermesProfile({ hermesHome });
    expect(restored.ok).toBe(true);
    expect(['surgical', 'backup-file']).toContain(restored.path);
  });

});
