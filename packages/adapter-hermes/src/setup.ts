import { cpSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync, mkdirSync, statSync, rmdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import {
  fundWalletsBestEffort,
  resolveDkgConfigHome,
  resolveDkgHome,
  startDaemon,
  type FundWalletsNetworkConfig,
} from '@origintrail-official/dkg-core';
import {
  type HermesMemoryMode,
  type HermesProfileMetadata,
  type HermesPublishGuardPolicy,
  type HermesRestoreRequest,
  type HermesRestoreResult,
  type HermesRuntimeStatus,
  type HermesSetupRequest,
  type HermesSetupResult,
  type HermesSetupState,
} from './types.js';
import { HermesDkgClient, redact } from './dkg-client.js';

const MANAGED_BY = '@origintrail-official/dkg-adapter-hermes' as const;
const STATE_VERSION = 1;
const CONFIG_BEGIN = '# BEGIN DKG ADAPTER HERMES MANAGED';
const CONFIG_END = '# END DKG ADAPTER HERMES MANAGED';
const PLUGIN_OWNER_FILE = '.dkg-adapter-hermes-owner.json';
const DEFAULT_HERMES_API_SERVER_URL = 'http://127.0.0.1:8642';
const TOP_LEVEL_MEMORY_BLOCK_RE = /^memory\s*:\s*(?:#.*)?$/;
const TOP_LEVEL_MEMORY_PROVIDER_RE = /^memory\.provider\s*:\s*["']?([^"'\s#]+)["']?/;
const INDENTED_PROVIDER_RE = /^(\s+)provider\s*:\s*["']?([^"'\s#]+)["']?/;
const INDENTED_PROVIDER_LINE_RE = /^(\s+)provider\s*:\s*(?:(["'])(.*?)\2|([^#\s]+))?\s*(?:#.*)?$/;
const __dirname = dirname(fileURLToPath(import.meta.url));

export interface HermesSetupOptions {
  profileName?: string;
  hermesHome?: string;
  daemonUrl?: string;
  bridgeUrl?: string;
  gatewayUrl?: string;
  bridgeHealthUrl?: string;
  contextGraph?: string;
  agentName?: string;
  memoryMode?: HermesMemoryMode;
  dryRun?: boolean;
  /**
   * Refuse to replace an existing non-DKG `memory.provider` in the
   * Hermes profile config. Defaults to `false` (replace-by-default per
   * setup-entrypoint-contract.md §2). `true` restores the pre-#386
   * throw-on-conflict behavior. Threaded from `HermesCliOptions.preserveProvider`
   * via `toSetupOptions`.
   */
  preserveProvider?: boolean;
  publishGuard?: Partial<HermesPublishGuardPolicy>;
  nodeSkillContent?: string;
}

export interface HermesCliOptions {
  profile?: string;
  hermesHome?: string;
  daemonUrl?: string;
  bridgeUrl?: string;
  gatewayUrl?: string;
  bridgeHealthUrl?: string;
  port?: string | number;
  memoryMode?: HermesMemoryMode | 'primary';
  dryRun?: boolean;
  verify?: boolean;
  start?: boolean;
  /**
   * Fund the first node wallets via the testnet faucet on first setup.
   * Defaults to `true`; `--no-fund` flips to `false`. Mirrors OpenClaw
   * `OpenClawSetupCliOptions.fund` (issue #386 acceptance).
   */
  fund?: boolean;
  /**
   * Refuse to replace an existing non-DKG `memory.provider` in the Hermes
   * profile. Defaults to `false` (replace-by-default per
   * setup-entrypoint-contract.md §2). `--preserve-provider` flips to true.
   * S4 implements the actual replace-by-default + restore logic; S2 wires
   * the flag through so the orchestrator sees it.
   */
  preserveProvider?: boolean;
  /**
   * Restore the prior `memory.provider` after a disconnect (CLI only).
   * Defaults to `false` — `dkg hermes disconnect` is disconnect-only by
   * default, matching today's behavior. `--restore-provider` flips to
   * `true` and invokes `restoreHermesProfile` after
   * `disconnectHermesProfile`. UI Disconnect always restores via the
   * daemon route (per setup-entrypoint-contract.md §6) and ignores
   * this field. `dkg hermes uninstall` always restores, also ignoring
   * this field (per H-AC-39).
   */
  restoreProvider?: boolean;
  /** UI-driven cancel; CLI handlers ignore. Mirrors `runOpenClawUiSetup`. */
  signal?: AbortSignal;
  /** Optional log/telemetry hint; non-functional. */
  invokedBy?: 'cli' | 'ui';
  nodeSkillContent?: string;
}

export interface HermesSetupPlan {
  dryRun: boolean;
  profile: HermesProfileMetadata;
  actions: Array<{ type: 'create' | 'update' | 'remove' | 'skip'; path: string; reason: string }>;
  warnings: string[];
  state: HermesSetupState;
}

export interface HermesVerifyResult {
  ok: boolean;
  status: HermesRuntimeStatus;
  profile: HermesProfileMetadata;
  warnings: string[];
  errors: string[];
  state?: HermesSetupState;
}

export function resolveHermesProfile(options: Pick<HermesSetupOptions, 'profileName' | 'hermesHome' | 'memoryMode'> = {}): HermesProfileMetadata {
  const profileName = trimmed(options.profileName);
  if (profileName && /[\\/]/.test(profileName)) {
    throw new Error('Hermes profile name must not contain path separators');
  }
  const defaultHome = profileName
    ? join(homedir(), '.hermes', 'profiles', profileName)
    : join(homedir(), '.hermes');
  const hermesHome = resolve(expandHome(options.hermesHome ?? process.env.HERMES_HOME ?? defaultHome));
  const stateDir = join(hermesHome, '.dkg-adapter-hermes');
  return {
    profileName,
    hermesHome,
    configPath: join(hermesHome, 'config.yaml'),
    stateDir,
    memoryMode: options.memoryMode ?? 'provider',
  };
}

export function planHermesSetup(options: HermesSetupOptions = {}): HermesSetupPlan {
  const profile = resolveHermesProfile(options);
  // S4 step 2 (issue #386): provider conflict is now handled inside
  // `ensureManagedProviderBlock` per `preserveProvider`. Default
  // behavior replaces with backup; `preserveProvider: true` throws the
  // canonical "Refusing to replace existing Hermes memory.provider"
  // message from `ensureManagedProviderBlock`. The plan-level throw at
  // `setupHermesProfile:185` is bypassed (we no longer pre-emit warnings
  // for non-DKG providers — that decision lives downstream now).
  const warnings: string[] = [];
  const daemonUrl = stripTrailingSlashes(options.daemonUrl ?? 'http://127.0.0.1:9200');
  const dkgHome = resolveDkgHome({ daemonUrl });
  const bridge = normalizeBridgeConfig(options);
  const publishGuard = normalizePublishGuard(options.publishGuard);
  const managedFiles = [
    join(profile.hermesHome, 'dkg.json'),
    join(profile.hermesHome, 'plugins', 'dkg'),
    join(profile.stateDir, 'setup-state.json'),
  ];
  const hasExistingManagedProvider = existsSync(profile.configPath)
    && hasManagedDkgProvider(readFileSync(profile.configPath, 'utf-8'));
  if (profile.memoryMode === 'provider' || hasExistingManagedProvider) {
    managedFiles.push(profile.configPath);
  }
  if (options.nodeSkillContent) {
    managedFiles.push(join(profile.hermesHome, 'skills', 'dkg-node', 'SKILL.md'));
  }

  const now = new Date().toISOString();
  const state: HermesSetupState = {
    managedBy: MANAGED_BY,
    version: STATE_VERSION,
    status: warnings.length ? 'degraded' : 'configured',
    profile,
    daemonUrl,
    dkgHome,
    contextGraph: options.contextGraph ?? 'agent-context',
    memoryAssertion: 'memory',
    agentName: options.agentName,
    ...(bridge ? { bridge } : {}),
    publishGuard,
    installedAt: now,
    updatedAt: now,
    managedFiles,
  };

  return {
    dryRun: options.dryRun === true,
    profile,
    warnings,
    state,
    actions: managedFiles.map((path) => ({
      type: existsSync(path) ? 'update' : 'create',
      path,
      reason: 'adapter-managed Hermes profile artifact',
    })),
  };
}

export function setupHermesProfile(options: HermesSetupOptions = {}): HermesSetupPlan {
  const plan = planHermesSetup(options);
  if (plan.dryRun) return plan;
  if (plan.profile.memoryMode === 'provider' && plan.warnings.length) {
    throw new Error(plan.warnings.join('\n'));
  }

  mkdirSync(plan.profile.hermesHome, { recursive: true });
  mkdirSync(plan.profile.stateDir, { recursive: true });

  const dkgConfigPath = join(plan.profile.hermesHome, 'dkg.json');
  if (existsSync(dkgConfigPath) && !isOwnedJson(dkgConfigPath)) {
    throw new Error(`Refusing to overwrite non-managed Hermes DKG config: ${dkgConfigPath}`);
  }
  writeOwnedJson(dkgConfigPath, {
    managedBy: MANAGED_BY,
    daemon_url: plan.state.daemonUrl,
    dkg_home: plan.state.dkgHome,
    ...(plan.state.bridge ? { bridge: plan.state.bridge } : {}),
    context_graph: plan.state.contextGraph,
    memory_assertion: plan.state.memoryAssertion,
    agent_name: plan.state.agentName ?? '',
    profile_name: plan.profile.profileName ?? '',
    memory_mode: plan.profile.memoryMode,
    publish_guard: plan.state.publishGuard,
    publish_tool: plan.state.publishGuard.defaultToolExposure,
    allow_direct_publish: plan.state.publishGuard.allowDirectPublish === true,
    require_explicit_approval: plan.state.publishGuard.requireExplicitApproval !== false,
    require_wallet_check: plan.state.publishGuard.requireWalletCheck !== false,
    allow_context_graph_admin_tools: true,
  });

  installHermesProviderPlugin(plan.profile);

  // S4 vector-6 fix (adversarial-findings.md §6): peek the
  // provider-swap intent BEFORE the destructive `config.yaml` rewrite,
  // and persist `setup-state.json` with `priorMemoryProvider` set to
  // the intent FIRST. A SIGINT between this state-write and the
  // rewrite leaves recoverable state on disk: a re-run sees
  // `existingState.priorMemoryProvider` populated, takes the
  // first-wins branch below, and `restoreHermesProfile` finds the
  // orphan backup at the recorded `configBackupPath`.
  const intendedSwap = plan.profile.memoryMode === 'provider'
    ? peekProviderSwapIntent(plan.profile.configPath, {
        preserveProvider: options.preserveProvider === true,
      }).swap
    : null;

  const existingState = readSetupState(plan.profile);
  // First-wins on `priorMemoryProvider`: if a prior install already
  // captured a snapshot (or a previous interrupted install captured
  // an intent), the current install's intent is ignored. Matches
  // the OpenClaw `previousMemorySlotOwner` first-wins semantics
  // (parity-matrix.md Layer 4 row "Idempotency on re-run").
  const priorMemoryProvider = existingState?.priorMemoryProvider
    ?? (intendedSwap ? intendedSwap : undefined);

  const stateBeforeRewrite = {
    ...plan.state,
    installedAt: existingState?.installedAt ?? plan.state.installedAt,
    updatedAt: new Date().toISOString(),
    ...(priorMemoryProvider ? { priorMemoryProvider } : {}),
  };
  writeOwnedJson(join(plan.profile.stateDir, 'setup-state.json'), stateBeforeRewrite);

  let providerSwap: EnsureManagedProviderBlockResult['swap'] = null;
  if (plan.profile.memoryMode === 'provider') {
    // Pass the pre-computed `intendedSwap` so the backup file lands
    // at the path already recorded in setup-state.json. Honors
    // first-wins: if a prior interrupted install already captured a
    // snapshot, we still pre-write the intent then `ensureManagedProviderBlock`
    // writes the backup file at the new `intendedSwap.configBackupPath`
    // (the first-wins state record above keeps pointing at the
    // original captured backup, not this re-run's).
    const result = ensureManagedProviderBlock(plan.profile.configPath, {
      preserveProvider: options.preserveProvider === true,
      ...(intendedSwap ? { intendedSwap } : {}),
    });
    providerSwap = result.swap;
  } else {
    removeManagedProviderBlock(plan.profile.configPath);
  }

  if (options.nodeSkillContent) {
    const skillPath = join(plan.profile.hermesHome, 'skills', 'dkg-node', 'SKILL.md');
    writeOwnedText(skillPath, options.nodeSkillContent);
  }

  // Re-write setup-state.json post-rewrite with the freshest
  // `updatedAt`. The `priorMemoryProvider` slot is still first-wins
  // and unchanged from the pre-rewrite write — we only refresh the
  // timestamp. If `peekProviderSwapIntent` somehow disagreed with
  // `ensureManagedProviderBlock` (defensive: shouldn't happen, both
  // call `findConfiguredMemoryProvider` on the same input), the
  // pre-write snapshot is what restore consumes; the post-write is
  // cosmetic.
  const state = {
    ...stateBeforeRewrite,
    updatedAt: new Date().toISOString(),
  };
  writeOwnedJson(join(plan.profile.stateDir, 'setup-state.json'), state);
  plan.state = state;
  // `providerSwap` is currently logged for parity with the pre-fix
  // return shape; downstream consumers read `state.priorMemoryProvider`.
  void providerSwap;
  return plan;
}

export function verifyHermesProfile(options: HermesSetupOptions = {}): HermesVerifyResult {
  const profile = resolveHermesProfile(options);
  const errors: string[] = [];
  const state = readSetupState(profile);
  const effectiveMemoryMode = options.memoryMode ?? state?.profile.memoryMode ?? profile.memoryMode;
  const effectiveProfile = { ...profile, memoryMode: effectiveMemoryMode };
  const warnings: string[] = [];
  const disconnected = state?.status === 'disconnected';
  const providerConflicts = disconnected
    ? []
    : detectProviderConflict(effectiveProfile, effectiveMemoryMode);
  errors.push(...providerConflicts);

  if (!existsSync(profile.hermesHome)) {
    errors.push(`Hermes profile directory does not exist: ${profile.hermesHome}`);
  }
  if (!state) {
    errors.push(`DKG Hermes setup state not found at ${join(profile.stateDir, 'setup-state.json')}`);
  } else if (state.managedBy !== MANAGED_BY) {
    errors.push('DKG Hermes setup state is not owned by this adapter');
  }
  const dkgConfigPath = join(profile.hermesHome, 'dkg.json');
  if (!existsSync(dkgConfigPath)) {
    errors.push(`DKG Hermes config not found at ${dkgConfigPath}`);
  } else if (!isOwnedJson(dkgConfigPath)) {
    errors.push(`DKG Hermes config is not ownership-marked: ${dkgConfigPath}`);
  }
  if (effectiveMemoryMode === 'provider' && !disconnected) {
    if (!existsSync(profile.configPath)) {
      errors.push(`Hermes provider mode requires config.yaml with managed memory.provider: dkg at ${profile.configPath}`);
    } else {
      const rawConfig = readFileSync(profile.configPath, 'utf-8');
      if (!hasManagedDkgProvider(rawConfig)) {
        errors.push(`Hermes provider mode requires an adapter-managed memory.provider: dkg block in ${profile.configPath}`);
      } else if (findConfiguredMemoryProvider(rawConfig) !== 'dkg') {
        errors.push(`Hermes provider mode requires effective memory.provider: dkg in ${profile.configPath}`);
      }
    }
  } else if (effectiveMemoryMode === 'provider' && disconnected) {
    warnings.push('Hermes profile is disconnected; managed memory.provider: dkg is not expected until reconnect.');
  }
  const pluginDir = join(profile.hermesHome, 'plugins', 'dkg');
  if (state && !isOwnedPluginDir(pluginDir)) {
    errors.push(`DKG Hermes provider plugin is missing or not ownership-marked: ${pluginDir}`);
  }

  return {
    ok: errors.length === 0,
    status: errors.length ? 'error' : disconnected ? 'disconnected' : warnings.length ? 'degraded' : 'configured',
    profile: effectiveProfile,
    warnings,
    errors,
    state: state ?? undefined,
  };
}

export function disconnectHermesProfile(options: HermesSetupOptions = {}): HermesSetupPlan {
  const profile = resolveHermesProfile(options);
  const existingState = readSetupState(profile);
  const plan = planHermesSetup({ ...options, dryRun: options.dryRun });
  if (!existingState) {
    plan.actions = [
      {
        type: 'skip',
        path: join(profile.stateDir, 'setup-state.json'),
        reason: 'Hermes adapter is not configured for this profile',
      },
    ];
    plan.warnings.push(`Hermes adapter setup state was not found at ${join(profile.stateDir, 'setup-state.json')}`);
    return plan;
  }
  plan.actions = [
    { type: 'update', path: profile.configPath, reason: 'remove adapter-managed provider election block' },
    { type: 'update', path: join(profile.stateDir, 'setup-state.json'), reason: 'mark adapter disconnected' },
  ];
  if (plan.dryRun) return plan;

  removeManagedProviderBlock(profile.configPath);
  const now = new Date().toISOString();
  const nextState: HermesSetupState = {
    ...existingState,
    status: 'disconnected',
    updatedAt: now,
  };
  writeOwnedJson(join(profile.stateDir, 'setup-state.json'), nextState);
  plan.state = nextState;
  return plan;
}

export function uninstallHermesProfile(options: HermesSetupOptions = {}): HermesSetupPlan {
  const profile = resolveHermesProfile(options);
  const plan = disconnectHermesProfile({ ...options, dryRun: true });
  plan.dryRun = options.dryRun === true;
  const managedFiles = readSetupState(profile)?.managedFiles ?? plan.state.managedFiles;
  plan.actions = managedFiles.map((path) => ({
    type: 'remove',
    path,
    reason: 'remove ownership-marked adapter artifact',
  }));
  plan.actions.push({ type: 'remove', path: profile.stateDir, reason: 'remove empty adapter state directory' });
  if (options.dryRun) return plan;

  removeManagedProviderBlock(profile.configPath);
  for (const path of managedFiles) {
    removeOwnedArtifact(path);
  }
  removeEmptyDir(profile.stateDir);
  return plan;
}

/**
 * `restoreHermesProfile` — S4 step 3 of execution-plan.md §3.S4
 * (issue #386). Reads `state.priorMemoryProvider` (captured by S4.2's
 * replace-by-default branch) and attempts to put
 * `<hermesHome>/config.yaml` back to its pre-replacement state.
 *
 * Behavior per setup-entrypoint-contract.md §6 + QA addendum §10C #1:
 *
 *   1. Absent `priorMemoryProvider` → `path: 'noop'`, `ok: true`.
 *      Nothing to restore (fresh install or already-DKG before setup).
 *   2. Surgical first: remove the managed block, then rewrite the
 *      remaining active `provider:` line (or the `memory.provider:`
 *      inline form) to the captured provider name. Preserves any user
 *      edits made to `config.yaml` after setup. Verify post-restore
 *      via `findConfiguredMemoryProvider(post) === captured.provider`
 *      before reporting success — mismatch falls through to backup-file.
 *   3. Backup-file fallback: atomic rename of `state.priorMemoryProvider.configBackupPath`
 *      over `config.yaml`. Loses any post-setup user edits but is the
 *      whole-file safety net. Same post-restore verification.
 *   4. If both surgical AND backup-file fail (or both produce a
 *      verification mismatch), `path: 'failed'`, `ok: false`,
 *      populated `restoreError`.
 *
 * Restore is independent of `disconnectHermesProfile`: the daemon's
 * `reverseHermesSetupForUi` (S3) calls disconnect first, then restore;
 * a restore failure does NOT roll back the disconnect (per contract §6
 * — the integration stays disconnected and the restore failure
 * surfaces as a `runtime.lastError` warning, not an error status).
 *
 * Idempotent: safe to call when there's nothing to restore (returns
 * `path: 'noop'`).
 */
export function restoreHermesProfile(req: HermesRestoreRequest = {}): HermesRestoreResult {
  if (req.signal?.aborted) {
    return { ok: false, path: 'failed', restoreError: 'restore cancelled before start' };
  }
  const profile = resolveHermesProfile({
    profileName: req.profile,
    hermesHome: req.hermesHome,
  });
  const state = readSetupState(profile);
  const captured = state?.priorMemoryProvider;
  if (!captured) {
    return { ok: true, path: 'noop' };
  }

  // Path 1: surgical line-rewrite. Remove the managed block first so
  // we don't accidentally rewrite the DKG provider line; then look
  // for a remaining active provider line and rewrite it to the
  // captured value. If no remaining line is found (e.g. user manually
  // deleted the memory: block since setup), surgical fails and we
  // fall through to backup-file.
  let surgicalError: string | undefined;
  if (existsSync(profile.configPath)) {
    try {
      const original = readFileSync(profile.configPath, 'utf-8');
      const cleaned = removeManagedBlock(original);
      const rewritten = rewriteActiveProviderLine(cleaned, captured.provider);
      if (rewritten === null) {
        surgicalError = 'no active memory.provider line found after removing managed block';
      } else {
        writeFileSync(profile.configPath, rewritten);
        const post = findConfiguredMemoryProvider(rewritten);
        if (post === captured.provider) {
          return {
            ok: true,
            path: 'surgical',
            restoredProvider: captured.provider,
          };
        }
        surgicalError = `surgical post-restore verification mismatch (got ${post ?? 'null'}, expected ${captured.provider})`;
      }
    } catch (err: any) {
      surgicalError = `surgical write failed: ${err?.message ?? String(err)}`;
    }
  } else {
    surgicalError = 'config.yaml does not exist; cannot rewrite in place';
  }

  // Path 2: backup-file fallback. Atomic rename of the captured
  // backup over config.yaml. Fails when the backup file is missing
  // (deleted by user) or unreadable.
  let backupError: string | undefined;
  if (existsSync(captured.configBackupPath)) {
    try {
      renameSync(captured.configBackupPath, profile.configPath);
      const post = findConfiguredMemoryProvider(
        readFileSync(profile.configPath, 'utf-8'),
      );
      if (post === captured.provider) {
        return {
          ok: true,
          path: 'backup-file',
          restoredFrom: captured.configBackupPath,
        };
      }
      backupError = `backup-file post-restore verification mismatch (got ${post ?? 'null'}, expected ${captured.provider})`;
    } catch (err: any) {
      backupError = `backup-file rename failed: ${err?.message ?? String(err)}`;
    }
  } else {
    backupError = `backup file missing at ${captured.configBackupPath}`;
  }

  return {
    ok: false,
    path: 'failed',
    restoreError: `restore failed via both paths. surgical: ${surgicalError ?? 'n/a'}. backup-file: ${backupError ?? 'n/a'}.`,
  };
}

/**
 * Internal helper for `restoreHermesProfile` surgical path. Walks the
 * config.yaml lines (already cleaned of the managed block) and either:
 *
 *   1. Rewrites the first active provider line found (top-level
 *      `memory:` block + indented `provider: <x>` line, OR inline
 *      `memory.provider: <x>`), OR
 *   2. If a top-level `memory:` block exists but has no `provider:`
 *      line inside it (typical post-replacement state, since
 *      `insertManagedProviderIntoMemoryBlock` consumed the original
 *      provider line), INSERTS a `provider: <captured>` line as the
 *      first child of the `memory:` block.
 *
 * Returns the rewritten string, or `null` when no `memory:` block
 * exists at all (caller falls through to the backup-file path).
 */
function rewriteActiveProviderLine(raw: string, newProvider: string): string | null {
  const lines = raw.split(/\r?\n/);
  let inMemory = false;
  let memoryHeaderIndex = -1;
  let memoryHeaderIndent = '';
  let rewroteAny = false;
  const next: string[] = [];
  for (const line of lines) {
    if (TOP_LEVEL_MEMORY_BLOCK_RE.test(line)) {
      inMemory = true;
      memoryHeaderIndex = next.length;
      memoryHeaderIndent = line.match(/^(\s*)/)?.[1] ?? '';
      next.push(line);
      continue;
    }
    if (inMemory && /^\S/.test(line)) {
      inMemory = false;
    }
    if (!rewroteAny) {
      const inline = line.match(TOP_LEVEL_MEMORY_PROVIDER_RE);
      if (inline) {
        next.push(`memory.provider: ${newProvider}`);
        rewroteAny = true;
        continue;
      }
      if (inMemory) {
        const indented = readIndentedProviderLine(line);
        if (indented) {
          next.push(`${indented.indent}provider: ${newProvider}`);
          rewroteAny = true;
          continue;
        }
      }
    }
    next.push(line);
  }
  if (rewroteAny) return next.join('\n');
  // Insertion fallback: a `memory:` block existed but had no
  // `provider:` child (typical post-replace state). Insert a
  // `provider: <captured>` line as the first child of the block.
  if (memoryHeaderIndex >= 0) {
    next.splice(memoryHeaderIndex + 1, 0, `${memoryHeaderIndent}  provider: ${newProvider}`);
    return next.join('\n');
  }
  return null;
}

/**
 * `runHermesSetup` — the canonical entrypoint for Hermes setup that
 * both `dkg hermes setup` (CLI) and the daemon-side UI Connect handler
 * (S3) call. Returns a `HermesSetupResult` rather than throwing on
 * non-fatal conditions; the daemon route maps `result.status` into
 * `LocalAgentIntegrationRecord.runtime.status` per
 * `setup-entrypoint-contract.md` §3.
 *
 * Behavior, in order:
 *   1. Resolve profile via `resolveHermesProfile` (mirrors `toSetupOptions`).
 *   2. Bootstrap `~/.dkg/config.json` via `ensureDkgNodeConfig` (S1.4)
 *      when the file is missing AND we're not in dry-run. (S2 step 3
 *      MVP: ensure the node config exists. Currently the bootstrap
 *      reads `network/<env>.json` via the small `loadNetworkConfig`
 *      probe below; full network discovery parity with OpenClaw lands
 *      alongside the rest of the issue #386 fresh-user flow.)
 *   3. Start the DKG daemon via `startDaemon` (S1.2) when
 *      `start !== false` AND `dryRun !== true`.
 *   4. Best-effort fund wallets via `fundWalletsBestEffort` (S1.3) when
 *      `fund !== false` AND `dryRun !== true`. Faucet failures are
 *      non-fatal — they surface as warnings, not errors.
 *   5. Run the existing `setupHermesProfile` body (preserves the
 *      dryRun short-circuit). For dryRun, this returns the plan
 *      without touching the filesystem (S2 step 4 / contract §5
 *      hardens the no-write guarantee).
 *   6. Best-effort daemon registration via `connectDaemonBestEffort`
 *      when not dry-run AND `start !== false`. Daemon registration
 *      probe is gated on `start !== false` to keep it decoupled from
 *      the new daemon-start step (issue #386 acceptance: `--no-start`
 *      truly skips both daemon start AND registration probe).
 *   7. Verify via `verifyHermesProfile` when `verify !== false`.
 *   8. Compute `HermesSetupResult` with full `transport` always
 *      populated (per contract §3).
 *
 * `providerSwap` is intentionally not populated here — that's S4's
 * replace-by-default work. The `HermesSetupResult.providerSwap` field
 * is defined in the result shape so the daemon route consumer
 * (`setup-entrypoint-contract.md` §9 sketch) doesn't change between
 * S2 → S3 → S4.
 */
export async function runHermesSetup(req: HermesSetupRequest): Promise<HermesSetupResult> {
  const cliOptions = setupRequestToCliOptions(req);
  const setupOptions = toSetupOptions(cliOptions);
  const profile = resolveHermesProfile(setupOptions);
  const dryRun = req.dryRun === true;
  const shouldStart = req.start !== false && !dryRun;
  const shouldFund = req.fund !== false && !dryRun;
  const shouldVerify = req.verify !== false;
  const warnings: string[] = [];
  const errors: string[] = [];
  let daemonStarted = false;
  let fundedWallets: string[] = [];
  let plan: HermesSetupPlan | undefined;

  // Step 1 (port-conflict warn): lifted out of `runHermesSetup` body
  // for clarity. Fires when both `--port` and `--daemon-url` are passed
  // and disagree on host:port. First-wins on `daemonUrl`. Per
  // setup-entrypoint-contract.md §2 Open Question 1 + H-AC-58.
  warnPortConflict(req, warnings);

  // Step 2: bootstrap `~/.dkg/config.json` when missing.
  if (!dryRun && !existsSync(join(resolveDkgConfigHome({ startDir: __dirname }), 'config.json'))) {
    try {
      await bootstrapDkgNodeConfig(profile, setupOptions, warnings);
    } catch (err: any) {
      // Non-fatal — operator can run `dkg init` and re-run setup. We
      // surface a warning so the result.status flips to 'degraded'.
      warnings.push(`Could not bootstrap ~/.dkg/config.json: ${err?.message ?? String(err)}`);
    }
  } else if (dryRun) {
    console.log('[hermes-setup] [dry-run] Would bootstrap ~/.dkg/config.json if missing');
  }

  // Step 3: start daemon.
  if (shouldStart) {
    try {
      const apiPort = setupOptions.daemonUrl
        ? new URL(setupOptions.daemonUrl).port
          ? Number(new URL(setupOptions.daemonUrl).port)
          : 9200
        : 9200;
      await startDaemon(apiPort);
      daemonStarted = true;
    } catch (err: any) {
      errors.push(`Failed to start DKG daemon: ${err?.message ?? String(err)}`);
    }
  } else if (dryRun) {
    console.log('[hermes-setup] [dry-run] Would start DKG daemon');
  } else {
    console.log('[hermes-setup] Skipping daemon start (--no-start)');
  }

  // Step 4: fund wallets best-effort. Only meaningful when we have a
  // network config to read `faucet.url` / `faucet.mode` from. Mirrors
  // OpenClaw's "skip when no faucet configured" path.
  if (shouldFund) {
    const network = loadHermesNetworkConfig(warnings);
    if (network) {
      try {
        await fundWalletsBestEffort({
          network,
          callerId: setupOptions.agentName ?? profile.profileName ?? 'hermes-setup',
          didStartDaemon: shouldStart,
        });
        // fundWalletsBestEffort never throws and never returns funded list;
        // we report `[]` (parity with OpenClaw — funded addresses are
        // logged but not surfaced through the orchestrator return value).
        fundedWallets = [];
      } catch (err: any) {
        // Defensive — fundWalletsBestEffort is documented as non-throwing,
        // but log any future regression as a warning rather than an error.
        warnings.push(`Faucet orchestrator threw unexpectedly: ${err?.message ?? String(err)}`);
      }
    }
  } else if (dryRun) {
    console.log('[hermes-setup] [dry-run] Would read wallets and fund via faucet');
  } else if (req.fund === false) {
    console.log('[hermes-setup] Skipping wallet funding (--no-fund)');
  }

  // Step 5: existing Hermes profile setup (writes dkg.json, plugin dir,
  // managed provider block, skill, setup-state.json). Honors dryRun.
  try {
    plan = setupHermesProfile(setupOptions);
    printPlan('Hermes setup', plan);
  } catch (err: any) {
    errors.push(err?.message ?? String(err));
  }

  // Step 6: daemon registration probe. Decoupled from `--no-start` per
  // issue #386 brief ("decouple registration from shouldStart" — applies
  // symmetrically with the same fix that landed for mcp-setup). Even
  // with `--no-start` the operator presumably has a daemon already
  // running and wants Hermes registered against it; the probe is
  // best-effort and fail-quiet via `connectDaemonBestEffort`.
  if (!dryRun && plan) {
    await connectDaemonBestEffort(plan, setupOptions.daemonUrl);
  }
  let verifyState: HermesSetupState | undefined = plan?.state;
  if (!dryRun && shouldVerify) {
    const verifyResult = verifyHermesProfile(setupOptions);
    printVerify('Hermes verify', verifyResult);
    verifyState = verifyResult.state ?? verifyState;
    if (!verifyResult.ok) {
      errors.push(...verifyResult.errors);
    }
    warnings.push(...verifyResult.warnings);
  }

  // Step 8: compute result shape. `transport` always populated (contract §3).
  const transport = computeTransportFromState(verifyState ?? plan?.state, profile);
  const status: HermesSetupResult['status'] = errors.length
    ? 'error'
    : warnings.length
      ? 'degraded'
      : 'configured';

  return {
    ok: errors.length === 0,
    status,
    profile,
    daemonStarted,
    fundedWallets,
    transport,
    warnings,
    errors,
    state: verifyState ?? plan?.state,
  };
}

/**
 * Backwards-compat wrapper preserving the pre-S2 throw-on-error
 * contract. Existing callers (CLI `dkg hermes setup` action handler,
 * setup-entry.mjs lazy export) keep their `await runSetup(opts)` shape
 * unchanged; on `result.ok === false` we throw so existing tests that
 * `await expect(runSetup(...)).rejects.toThrow(...)` still pass.
 */
export async function runSetup(options: HermesCliOptions = {}): Promise<void> {
  const result = await runHermesSetup(cliOptionsToSetupRequest(options));
  if (!result.ok) {
    throw new Error(result.errors.join('\n'));
  }
}

async function executeSetup(
  options: HermesCliOptions,
  setupOptions: HermesSetupOptions,
): Promise<void> {
  const plan = setupHermesProfile(setupOptions);
  printPlan('Hermes setup', plan);
  if (plan.dryRun) return;

  if (options.start !== false) {
    await connectDaemonBestEffort(plan, setupOptions.daemonUrl);
  }

  if (options.verify !== false) {
    const result = verifyHermesProfile(setupOptions);
    printVerify('Hermes verify', result);
    if (!result.ok) {
      throw new Error(result.errors.join('\n'));
    }
  }
}

export async function runVerify(options: HermesCliOptions = {}): Promise<void> {
  const result = verifyHermesProfile(toSetupOptions(options));
  printVerify('Hermes verify', result);
  if (!result.ok) {
    throw new Error(result.errors.join('\n'));
  }
}

export async function runStatus(options: HermesCliOptions = {}): Promise<void> {
  const result = verifyHermesProfile(toSetupOptions(options));
  printVerify('Hermes status', result);
}

export async function runDoctor(options: HermesCliOptions = {}): Promise<void> {
  const result = verifyHermesProfile(toSetupOptions(options));
  printVerify('Hermes doctor', result);
  if (!result.ok) {
    throw new Error(result.errors.join('\n'));
  }
}

export async function runDisconnect(options: HermesCliOptions = {}): Promise<void> {
  const setupOptions = toSetupOptions(options);
  const plan = disconnectHermesProfile(setupOptions);
  printPlan('Hermes disconnect', plan);
  if (!plan.dryRun && plan.actions.some((action) => action.type !== 'skip')) {
    await disconnectDaemonBestEffort(setupOptions.daemonUrl, plan.state);
  }
  if (options.restoreProvider) {
    if (plan.dryRun) {
      console.log('[dry-run] Would restore prior memory.provider via restoreHermesProfile');
      return;
    }
    const result = restoreHermesProfile({
      profile: setupOptions.profileName,
      hermesHome: setupOptions.hermesHome,
    });
    printRestore('Hermes restore', result);
    if (!result.ok) {
      console.warn(`[hermes disconnect] restore-provider failed: ${result.restoreError ?? 'unknown error'}`);
    }
  }
}

export async function runReconnect(options: HermesCliOptions = {}): Promise<void> {
  await executeSetup(options, toReconnectSetupOptions(options));
}

export async function runUninstall(options: HermesCliOptions = {}): Promise<void> {
  const setupOptions = toSetupOptions(options);
  const uninstallState = readSetupState(resolveHermesProfile(setupOptions));
  // Restore prior memory.provider BEFORE uninstall removes setup-state.json
  // (which holds the priorMemoryProvider snapshot). Per H-AC-39: uninstall
  // always restores. Dry-run prints what would happen and skips the actual
  // restore.
  if (uninstallState?.priorMemoryProvider) {
    if (options.dryRun) {
      console.log('[dry-run] Would restore prior memory.provider via restoreHermesProfile');
    } else {
      const result = restoreHermesProfile({
        profile: setupOptions.profileName,
        hermesHome: setupOptions.hermesHome,
      });
      printRestore('Hermes uninstall: restore', result);
      if (!result.ok) {
        console.warn(`[hermes uninstall] restore-provider failed: ${result.restoreError ?? 'unknown error'}`);
      }
    }
  }
  const plan = uninstallHermesProfile(setupOptions);
  printPlan('Hermes uninstall', plan);
  if (!plan.dryRun && uninstallState) {
    await disconnectDaemonBestEffort(setupOptions.daemonUrl, uninstallState);
  }
}

export const setup = runSetup;
export const verify = runVerify;
export const status = runStatus;
export const doctor = runDoctor;
export const disconnect = runDisconnect;
export const reconnect = runReconnect;
export const uninstall = runUninstall;

function normalizePublishGuard(input: Partial<HermesPublishGuardPolicy> | undefined): HermesPublishGuardPolicy {
  return {
    defaultToolExposure: input?.defaultToolExposure ?? 'direct',
    allowDirectPublish: input?.allowDirectPublish ?? true,
    requireExplicitApproval: input?.requireExplicitApproval ?? false,
    requireWalletCheck: input?.requireWalletCheck ?? false,
  };
}

function toSetupOptions(options: HermesCliOptions): HermesSetupOptions {
  const profileName = trimmed(options.profile);
  const hermesHome = trimmed(options.hermesHome);
  const existingState = readSetupState(resolveHermesProfile({ profileName, hermesHome }));
  const memoryMode = normalizeCliMemoryMode(options.memoryMode) ?? existingState?.profile.memoryMode;
  const port = normalizePort(options.port);
  const daemonUrl = trimmed(options.daemonUrl) ?? (port ? `http://127.0.0.1:${port}` : undefined);
  return {
    profileName: profileName ?? existingState?.profile.profileName,
    hermesHome: hermesHome ?? existingState?.profile.hermesHome,
    daemonUrl: stripTrailingSlashes(daemonUrl ?? existingState?.daemonUrl ?? 'http://127.0.0.1:9200'),
    bridgeUrl: stripTrailingSlashes(trimmed(options.bridgeUrl) ?? existingState?.bridge?.url ?? ''),
    gatewayUrl: stripTrailingSlashes(trimmed(options.gatewayUrl) ?? existingState?.bridge?.gatewayUrl ?? ''),
    bridgeHealthUrl: stripTrailingSlashes(trimmed(options.bridgeHealthUrl) ?? existingState?.bridge?.healthUrl ?? ''),
    contextGraph: existingState?.contextGraph,
    agentName: existingState?.agentName,
    publishGuard: existingState?.publishGuard,
    nodeSkillContent: options.nodeSkillContent,
    memoryMode,
    preserveProvider: options.preserveProvider === true,
    dryRun: options.dryRun === true,
  };
}

function toReconnectSetupOptions(options: HermesCliOptions): HermesSetupOptions {
  const setupOptions = toSetupOptions(options);
  if (setupOptions.memoryMode) return setupOptions;

  const state = readSetupState(resolveHermesProfile(setupOptions));
  if (!state?.profile.memoryMode) return setupOptions;
  return {
    ...setupOptions,
    memoryMode: state.profile.memoryMode,
  };
}

function normalizeCliMemoryMode(value: unknown): HermesMemoryMode | undefined {
  const memoryMode = trimmed(value);
  if (!memoryMode) return undefined;
  if (memoryMode === 'tools-only') return 'tools-only';
  if (memoryMode === 'provider' || memoryMode === 'primary') return 'provider';
  if (memoryMode === 'ask') {
    throw new Error('Hermes memory mode "ask" is not supported in non-interactive setup; use primary or tools-only.');
  }
  throw new Error(`Invalid Hermes memory mode: ${memoryMode}`);
}

function normalizePort(value: string | number | undefined): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const port = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid Hermes daemon port: ${String(value)}`);
  }
  return port;
}

async function connectDaemonBestEffort(plan: HermesSetupPlan, daemonUrl: string | undefined): Promise<void> {
  const apiToken = loadDkgAuthToken(daemonUrl);
  const transport: { kind: 'hermes-channel' | 'hermes-openai'; bridgeUrl?: string; gatewayUrl?: string; healthUrl?: string } = {
    kind: plan.state.bridge?.protocol === 'hermes-openai' ? 'hermes-openai' : 'hermes-channel',
  };
  if (plan.state.bridge?.url) {
    transport.bridgeUrl = plan.state.bridge.url;
  }
  if (plan.state.bridge?.gatewayUrl) {
    transport.gatewayUrl = plan.state.bridge.gatewayUrl;
  }
  if (plan.state.bridge?.healthUrl) {
    transport.healthUrl = plan.state.bridge.healthUrl;
  }
  const client = new HermesDkgClient({
    baseUrl: daemonUrl,
    apiToken,
    timeoutMs: 3_000,
  });
  try {
    await client.connectHermesIntegration({
      metadata: {
        profileName: plan.profile.profileName,
        hermesHome: plan.profile.hermesHome,
        memoryMode: plan.profile.memoryMode,
        setupState: plan.state.status,
      },
      capabilities: {
        dkgPrimaryMemory: plan.profile.memoryMode === 'provider',
        wmImportPipeline: plan.profile.memoryMode === 'provider',
      },
      transport,
      runtime: {
        status: plan.state.status === 'degraded' ? 'degraded' : 'configured',
        ready: false,
        lastError: null,
      },
    });
  } catch (err: any) {
    console.warn(`Hermes local-agent registration skipped: ${redact(err?.message ?? String(err), apiToken)}`);
  }
}

async function disconnectDaemonBestEffort(
  daemonUrl: string | undefined,
  setupState: HermesSetupState,
): Promise<void> {
  const apiToken = loadDkgAuthToken(daemonUrl);
  const client = new HermesDkgClient({
    baseUrl: daemonUrl,
    apiToken,
    timeoutMs: 3_000,
  });
  try {
    const current = await client.getHermesIntegration();
    if (!daemonHermesIntegrationMatchesProfile(current.integration, setupState)) {
      console.warn('Hermes local-agent registry disconnect skipped: daemon Hermes integration belongs to a different profile');
      return;
    }
    await client.disconnectHermesIntegration();
  } catch (err: any) {
    console.warn(`Hermes local-agent registry disconnect skipped: ${redact(err?.message ?? String(err), apiToken)}`);
  }
}

function daemonHermesIntegrationMatchesProfile(integration: unknown, setupState: HermesSetupState): boolean {
  if (!isPlainRecord(integration)) return false;
  const metadata = isPlainRecord(integration.metadata) ? integration.metadata : undefined;
  const hermesHome = trimmed(metadata?.hermesHome);
  if (!hermesHome) return false;
  return (trimmed(metadata?.profileName) ?? undefined) === (setupState.profile.profileName ?? undefined)
    && normalizePathForCompare(hermesHome) === normalizePathForCompare(setupState.profile.hermesHome);
}

function normalizeBridgeConfig(
  options: Pick<HermesSetupOptions, 'bridgeUrl' | 'gatewayUrl' | 'bridgeHealthUrl'>,
): HermesSetupState['bridge'] | undefined {
  const url = stripTrailingSlashes(trimmed(options.bridgeUrl) ?? '');
  const explicitGatewayUrl = stripTrailingSlashes(trimmed(options.gatewayUrl) ?? '');
  const healthUrl = stripTrailingSlashes(trimmed(options.bridgeHealthUrl) ?? '');
  const gatewayUrl = explicitGatewayUrl || (!url && !healthUrl ? DEFAULT_HERMES_API_SERVER_URL : '');
  const protocol = gatewayUrl && !gatewayUrl.endsWith('/api/hermes-channel')
    ? 'hermes-openai'
    : 'hermes-channel';
  if (url && !isLoopbackUrl(url)) {
    throw new Error('Hermes bridge URL must be a loopback URL; use --gateway-url for WSL2 or remote Hermes gateways.');
  }
  if (healthUrl) {
    if (!url && !gatewayUrl) {
      throw new Error('Hermes bridge health URL requires --bridge-url or --gateway-url so health checks match the chat transport.');
    }
    const allowedBases = [
      ...(url ? [url] : []),
      ...(gatewayUrl ? [protocol === 'hermes-openai' ? gatewayUrl : buildHermesGatewayBase(gatewayUrl)] : []),
    ];
    if (!allowedBases.some((base) => urlBelongsToBase(healthUrl, base))) {
      throw new Error('Hermes bridge health URL must belong to the configured --bridge-url or --gateway-url transport.');
    }
  }
  return {
    ...(gatewayUrl ? { protocol } : {}),
    ...(url ? { url } : {}),
    ...(gatewayUrl ? { gatewayUrl } : {}),
    ...(healthUrl ? { healthUrl } : {}),
  };
}

function buildHermesGatewayBase(value: string): string {
  return value.endsWith('/api/hermes-channel')
    ? value
    : `${value}/api/hermes-channel`;
}

function urlBelongsToBase(value: string, base: string): boolean {
  try {
    const parsedValue = new URL(value);
    const parsedBase = new URL(base);
    if (parsedValue.origin !== parsedBase.origin) return false;
    const basePath = stripTrailingSlashes(parsedBase.pathname);
    if (!basePath || basePath === '/') return true;
    return parsedValue.pathname === basePath
      || parsedValue.pathname.startsWith(`${basePath}/`);
  } catch {
    return false;
  }
}

function isLoopbackUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    return host === 'localhost'
      || host === '::1'
      || host === '[::1]'
      || (isIP(host) === 4 && host.startsWith('127.'));
  } catch {
    return false;
  }
}

function loadDkgAuthToken(daemonUrl?: string): string | undefined {
  const envToken = trimmed(process.env.DKG_API_TOKEN) ?? trimmed(process.env.DKG_AUTH_TOKEN);
  if (envToken) return envToken;

  const dkgHome = resolve(expandHome(trimmed(process.env.DKG_HOME) ?? dkgDir(daemonUrl)));
  try {
    const rawTokenFile = readFileSync(join(dkgHome, 'auth.token'), 'utf-8');
    for (const line of rawTokenFile.split('\n')) {
      const token = trimmed(line);
      if (token && !token.startsWith('#')) return token;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function dkgDir(daemonUrl?: string): string {
  return resolveDkgHome({ daemonUrl }) ?? resolveDkgConfigHome({ startDir: __dirname });
}

function printPlan(label: string, plan: HermesSetupPlan): void {
  console.log(`${label}: ${plan.profile.profileName ?? 'default'} (${plan.profile.hermesHome})`);
  for (const warning of plan.warnings) {
    console.warn(`warning: ${warning}`);
  }
  for (const action of plan.actions) {
    console.log(`${plan.dryRun ? 'would ' : ''}${action.type}: ${action.path}`);
  }
}

function printVerify(label: string, result: HermesVerifyResult): void {
  console.log(`${label}: ${result.status} (${result.profile.hermesHome})`);
  for (const warning of result.warnings) {
    console.warn(`warning: ${warning}`);
  }
  for (const error of result.errors) {
    console.error(`error: ${error}`);
  }
}

function printRestore(label: string, result: HermesRestoreResult): void {
  console.log(`${label}: path=${result.path}`);
  if (result.path === 'surgical' && result.restoredProvider) {
    console.log(`  restored memory.provider: ${result.restoredProvider}`);
  }
  if (result.path === 'backup-file' && result.restoredFrom) {
    console.log(`  restored from backup: ${result.restoredFrom}`);
  }
  if (result.restoreError) {
    console.warn(`  restore error: ${result.restoreError}`);
  }
}

function detectProviderConflict(profile: HermesProfileMetadata, memoryMode: HermesMemoryMode): string[] {
  if (memoryMode !== 'provider' || !existsSync(profile.configPath)) return [];
  const raw = readFileSync(profile.configPath, 'utf-8');
  const provider = findConfiguredMemoryProvider(raw);
  if (provider && provider !== 'dkg') {
    return [`Hermes profile already has memory.provider: ${provider}; use tools-only mode or switch explicitly.`];
  }
  return [];
}

function findConfiguredMemoryProvider(raw: string): string | null {
  const lines = raw.split(/\r?\n/);
  let inMemory = false;
  let provider: string | null = null;
  for (const line of lines) {
    if (TOP_LEVEL_MEMORY_BLOCK_RE.test(line)) {
      inMemory = true;
      continue;
    }
    if (inMemory && /^\S/.test(line)) {
      inMemory = false;
    }
    if (inMemory) {
      const match = readIndentedProviderLine(line);
      if (match) provider = match.value;
    }
    const inline = line.match(TOP_LEVEL_MEMORY_PROVIDER_RE);
    if (inline) provider = inline[1];
  }
  return provider;
}

function hasManagedDkgProvider(raw: string): boolean {
  const lines = raw.split(/\r?\n/);
  let inManagedBlock = false;
  for (const line of lines) {
    if (line.includes(CONFIG_BEGIN)) {
      inManagedBlock = true;
      continue;
    }
    if (line.includes(CONFIG_END)) {
      inManagedBlock = false;
      continue;
    }
    if (inManagedBlock) {
      const match = line.match(/^\s*provider\s*:\s*["']?([^"'\s#]+)["']?/);
      if (match?.[1] === 'dkg') return true;
      const inline = line.match(/^\s*memory\.provider\s*:\s*["']?([^"'\s#]+)["']?/);
      if (inline?.[1] === 'dkg') return true;
    }
  }
  return false;
}

/**
 * Result of `ensureManagedProviderBlock`. When the call replaced an
 * existing non-DKG provider, `swap` describes the prior provider and
 * the path of the timestamped backup file we wrote BEFORE the
 * replacement. When the call was a no-op (already-DKG, fresh install,
 * or `preserveProvider: true` on a fresh install), `swap` is `null`
 * and the function did not touch `<hermesHome>/config.yaml.bak.*`.
 *
 * Caller is responsible for first-wins persistence into
 * `state.priorMemoryProvider`: if a prior install already captured a
 * snapshot, the second install must NOT overwrite it.
 */
interface EnsureManagedProviderBlockResult {
  swap: {
    provider: string;
    configBackupPath: string;
    capturedAt: string;
  } | null;
}

/**
 * Peek the provider-swap intent for a `setupHermesProfile` call WITHOUT
 * writing anything. Returns the same `{ swap }` shape that
 * `ensureManagedProviderBlock` will produce, with `configBackupPath`
 * pre-computed using the supplied `nowMs` timestamp.
 *
 * This split exists because of the SIGINT mid-execute partial-state
 * bug surfaced by the adversarial reviewer (see
 * `agent-docs/hermes-parity/adversarial-findings.md` §6). The caller
 * (`setupHermesProfile`) writes `setup-state.json` with the intended
 * `priorMemoryProvider` BEFORE the destructive `config.yaml` rewrite,
 * so a SIGINT between the two writes leaves recoverable state on disk
 * (re-run sees existingState.priorMemoryProvider populated and routes
 * `restoreHermesProfile` correctly to the orphan backup).
 *
 * Throws when `preserveProvider: true` AND the existing config carries
 * a non-DKG provider — same canonical message as
 * `ensureManagedProviderBlock` (H-AC-30 adapter-half stable string).
 */
function peekProviderSwapIntent(
  configPath: string,
  options: { preserveProvider?: boolean; nowMs?: number } = {},
): EnsureManagedProviderBlockResult {
  const existing = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : '';
  const configuredProvider = findConfiguredMemoryProvider(existing);
  if (!existing.includes(CONFIG_BEGIN) && configuredProvider === 'dkg') {
    return { swap: null };
  }
  if (configuredProvider && configuredProvider !== 'dkg') {
    if (options.preserveProvider === true) {
      throw new Error(`Refusing to replace existing Hermes memory.provider: ${configuredProvider}`);
    }
    const ts = options.nowMs ?? Date.now();
    return {
      swap: {
        provider: configuredProvider,
        configBackupPath: `${configPath}.bak.${ts}`,
        capturedAt: new Date(ts).toISOString(),
      },
    };
  }
  return { swap: null };
}

function ensureManagedProviderBlock(
  configPath: string,
  options: {
    preserveProvider?: boolean;
    /**
     * The `{ provider, configBackupPath, capturedAt }` snapshot
     * produced by `peekProviderSwapIntent`. When supplied, this
     * function writes the backup file at the pre-computed path and
     * skips re-detection. Required when the caller has already
     * persisted `priorMemoryProvider` to setup-state.json (vector 6
     * fix: SIGINT-safe ordering).
     */
    intendedSwap?: NonNullable<EnsureManagedProviderBlockResult['swap']>;
  } = {},
): EnsureManagedProviderBlockResult {
  const existing = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : '';
  const configuredProvider = findConfiguredMemoryProvider(existing);
  if (!existing.includes(CONFIG_BEGIN) && configuredProvider === 'dkg') {
    writeOwnedText(configPath, markExistingDkgProvider(existing), false);
    return { swap: null };
  }
  if (configuredProvider && configuredProvider !== 'dkg') {
    // S4 step 2 (issue #386): replace-by-default with backup + capture.
    // Pre-#386 behavior is preserved verbatim behind `--preserve-provider`
    // for operators who want the throw (H-AC-30 adapter-half asserts the
    // exact message stays grep-stable).
    if (options.preserveProvider === true) {
      throw new Error(`Refusing to replace existing Hermes memory.provider: ${configuredProvider}`);
    }
    // Replace-by-default: write a timestamped backup of the current
    // config.yaml bytes BEFORE the managed-block rewrite. The backup
    // is what `restoreHermesProfile` (S4 step 3) consumes for the
    // backup-file fallback path; the line-rewrite path uses the
    // captured `provider` name instead.
    //
    // SIGINT-safe ordering (vector 6 fix): when the caller has already
    // persisted `priorMemoryProvider` via `peekProviderSwapIntent`, we
    // honor the pre-computed `configBackupPath` so the on-disk state
    // points at the same backup path that gets written here. Without
    // the injection, a tiny clock skew between peek and execute could
    // produce a different `Date.now()` and leave the snapshot pointing
    // at a non-existent backup.
    const swap = options.intendedSwap ?? {
      provider: configuredProvider,
      configBackupPath: `${configPath}.bak.${Date.now()}`,
      capturedAt: new Date().toISOString(),
    };
    writeFileSync(swap.configBackupPath, existing);
    const unmanaged = removeManagedBlock(existing);
    const next = hasTopLevelMemoryBlock(unmanaged)
      ? insertManagedProviderIntoMemoryBlock(unmanaged)
      : appendManagedMemoryBlock(unmanaged);
    writeOwnedText(configPath, next, false);
    return { swap };
  }

  const unmanaged = removeManagedBlock(existing);
  const next = hasTopLevelMemoryBlock(unmanaged)
    ? insertManagedProviderIntoMemoryBlock(unmanaged)
    : appendManagedMemoryBlock(unmanaged);
  writeOwnedText(configPath, next, false);
  return { swap: null };
}

function markExistingDkgProvider(raw: string): string {
  const lines = raw.split(/\r?\n/);
  const next: string[] = [];
  let inMemory = false;
  let marked = false;

  for (const line of lines) {
    if (!marked) {
      const inline = line.match(TOP_LEVEL_MEMORY_PROVIDER_RE);
      if (inline?.[1] === 'dkg') {
        next.push(CONFIG_BEGIN);
        next.push(line);
        next.push(CONFIG_END);
        marked = true;
        continue;
      }
    }

    if (TOP_LEVEL_MEMORY_BLOCK_RE.test(line)) {
      inMemory = true;
      next.push(line);
      continue;
    }
    if (inMemory && /^\S/.test(line)) {
      inMemory = false;
    }
    if (!marked && inMemory) {
      const match = line.match(INDENTED_PROVIDER_RE);
      if (match?.[2] === 'dkg') {
        next.push(`${match[1]}${CONFIG_BEGIN}`);
        next.push(line);
        next.push(`${match[1]}${CONFIG_END}`);
        marked = true;
        continue;
      }
    }
    next.push(line);
  }

  if (marked) return next.join('\n');
  return appendManagedMemoryBlock(raw);
}

function removeManagedProviderBlock(configPath: string): void {
  if (!existsSync(configPath)) return;
  const existing = readFileSync(configPath, 'utf-8');
  if (!existing.includes(CONFIG_BEGIN)) return;
  const next = removeManagedBlock(existing);
  writeFileSync(configPath, next);
}

function appendManagedMemoryBlock(raw: string): string {
  const block = `${CONFIG_BEGIN}\nmemory:\n  provider: dkg\n${CONFIG_END}\n`;
  return `${raw}${raw && !raw.endsWith('\n') ? '\n' : ''}${block}`;
}

function insertManagedProviderIntoMemoryBlock(raw: string): string {
  const lines = raw.split(/\r?\n/);
  const next: string[] = [];
  const replaceExistingProvider = hasMemoryProviderLine(raw);
  let inserted = false;
  let inMemory = false;
  for (const line of lines) {
    if (TOP_LEVEL_MEMORY_BLOCK_RE.test(line)) {
      inMemory = true;
      next.push(line);
      if (!replaceExistingProvider) {
        const indent = line.match(/^(\s*)/)?.[1] ?? '';
        next.push(`${indent}  ${CONFIG_BEGIN}`);
        next.push(`${indent}  provider: dkg`);
        next.push(`${indent}  ${CONFIG_END}`);
        inserted = true;
      }
      continue;
    }
    if (inMemory && /^\S/.test(line)) {
      inMemory = false;
    }
    if (replaceExistingProvider && inMemory) {
      const provider = readIndentedProviderLine(line);
      if (provider) {
        if (!inserted) {
          next.push(`${provider.indent}${CONFIG_BEGIN}`);
          next.push(`${provider.indent}provider: dkg`);
          next.push(`${provider.indent}${CONFIG_END}`);
          inserted = true;
        }
        continue;
      }
    }
    next.push(line);
  }
  return next.join('\n');
}

function hasMemoryProviderLine(raw: string): boolean {
  const lines = raw.split(/\r?\n/);
  let inMemory = false;
  for (const line of lines) {
    if (TOP_LEVEL_MEMORY_BLOCK_RE.test(line)) {
      inMemory = true;
      continue;
    }
    if (inMemory && /^\S/.test(line)) {
      inMemory = false;
    }
    if (inMemory && readIndentedProviderLine(line)) return true;
  }
  return false;
}

function readIndentedProviderLine(line: string): { indent: string; value: string } | null {
  const match = line.match(INDENTED_PROVIDER_LINE_RE);
  if (!match) return null;
  return {
    indent: match[1],
    value: (match[3] ?? match[4] ?? '').trim(),
  };
}

function hasTopLevelMemoryBlock(raw: string): boolean {
  return raw.split(/\r?\n/).some((line) => TOP_LEVEL_MEMORY_BLOCK_RE.test(line));
}

function removeManagedBlock(raw: string): string {
  return raw.replace(
    new RegExp(`^[ \\t]*${escapeRegExp(CONFIG_BEGIN)}\\r?\\n[\\s\\S]*?^[ \\t]*${escapeRegExp(CONFIG_END)}\\r?\\n?`, 'm'),
    '',
  );
}

function readSetupState(profile: HermesProfileMetadata): HermesSetupState | null {
  const statePath = join(profile.stateDir, 'setup-state.json');
  if (!existsSync(statePath)) return null;
  try {
    return JSON.parse(readFileSync(statePath, 'utf-8')) as HermesSetupState;
  } catch {
    return null;
  }
}

function writeOwnedJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeOwnedText(path: string, content: string, wrap = true): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = wrap
    ? `<!-- Managed by ${MANAGED_BY}; sha256:${sha256(content)} -->\n${content}`
    : content;
  writeFileSync(path, body.endsWith('\n') ? body : `${body}\n`);
}

function isOwnedJson(path: string): boolean {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    return raw?.managedBy === MANAGED_BY;
  } catch {
    return false;
  }
}

function removeOwnedArtifact(path: string): void {
  if (!existsSync(path)) return;
  if (statSync(path).isDirectory()) {
    if (!isOwnedPluginDir(path)) return;
    rmSync(path, { recursive: true, force: true });
    return;
  }
  if (path.endsWith('.json') && !isOwnedJson(path)) return;
  if (!path.endsWith('.json')) {
    const raw = readFileSync(path, 'utf-8');
    if (!raw.includes(`Managed by ${MANAGED_BY}`)) return;
  }
  rmSync(path, { force: true });
}

function removeEmptyDir(path: string): void {
  try {
    rmdirSync(path);
  } catch {
    // Best effort. A non-empty or absent state dir is preserved.
  }
}

function installHermesProviderPlugin(profile: HermesProfileMetadata): void {
  const source = resolveBundledHermesPluginDir();
  const target = join(profile.hermesHome, 'plugins', 'dkg');
  if (existsSync(target) && !isOwnedPluginDir(target)) {
    throw new Error(`Refusing to overwrite non-managed Hermes DKG provider plugin: ${target}`);
  }

  rmSync(target, { recursive: true, force: true });
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, {
    recursive: true,
    filter: (sourcePath) => {
      const normalized = sourcePath.replace(/\\/g, '/');
      return !normalized.includes('/__pycache__/') && !normalized.endsWith('.pyc');
    },
  });
  writeOwnedJson(join(target, PLUGIN_OWNER_FILE), {
    managedBy: MANAGED_BY,
    sourcePackage: '@origintrail-official/dkg-adapter-hermes',
    installedAt: new Date().toISOString(),
  });
}

function resolveBundledHermesPluginDir(): string {
  const moduleDir = __dirname;
  const candidates = [
    resolve(moduleDir, '..', 'hermes-plugin'),
    resolve(moduleDir, '..', '..', 'hermes-plugin'),
  ];
  const found = candidates.find((candidate) => existsSync(join(candidate, '__init__.py')));
  if (!found) {
    throw new Error('Bundled Hermes provider plugin was not found in @origintrail-official/dkg-adapter-hermes');
  }
  return found;
}

function isOwnedPluginDir(path: string): boolean {
  const marker = join(path, PLUGIN_OWNER_FILE);
  return existsSync(marker) && isOwnedJson(marker);
}

function expandHome(path: string): string {
  return path.replace(/^~(?=$|[\\/])/, homedir());
}

function normalizePathForCompare(path: string): string {
  const normalized = resolve(expandHome(path)).split('\\').join('/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function trimmed(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return value.slice(0, end);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

// ---------------------------------------------------------------------------
// S2 step 3 — `runHermesSetup` orchestrator helpers (issue #386).
// ---------------------------------------------------------------------------

/**
 * Translate a `HermesSetupRequest` (the canonical entrypoint shape) into
 * the legacy `HermesCliOptions` shape that `toSetupOptions` already knows
 * how to consume. Mirrors `cliOptionsToSetupRequest` for the CLI bridge.
 */
function setupRequestToCliOptions(req: HermesSetupRequest): HermesCliOptions {
  return {
    profile: req.profile,
    hermesHome: req.hermesHome,
    daemonUrl: req.daemonUrl,
    bridgeUrl: req.bridgeUrl,
    gatewayUrl: req.gatewayUrl,
    bridgeHealthUrl: req.bridgeHealthUrl,
    port: req.port,
    memoryMode: req.memoryMode,
    dryRun: req.dryRun,
    verify: req.verify,
    start: req.start,
    fund: req.fund,
    preserveProvider: req.preserveProvider,
    signal: req.signal,
    invokedBy: req.invokedBy,
    nodeSkillContent: req.nodeSkillContent,
  };
}

/**
 * Inverse of `setupRequestToCliOptions` — used by the backwards-compat
 * `runSetup` wrapper to bridge legacy `HermesCliOptions` callers into
 * the new `HermesSetupRequest` shape `runHermesSetup` consumes.
 */
function cliOptionsToSetupRequest(options: HermesCliOptions): HermesSetupRequest {
  return {
    profile: options.profile,
    hermesHome: options.hermesHome,
    daemonUrl: options.daemonUrl,
    bridgeUrl: options.bridgeUrl,
    gatewayUrl: options.gatewayUrl,
    bridgeHealthUrl: options.bridgeHealthUrl,
    port: options.port,
    memoryMode: options.memoryMode,
    dryRun: options.dryRun,
    verify: options.verify,
    start: options.start,
    fund: options.fund,
    preserveProvider: options.preserveProvider,
    signal: options.signal,
    invokedBy: options.invokedBy,
    nodeSkillContent: options.nodeSkillContent,
  };
}

/**
 * Bootstrap `~/.dkg/config.json` via `ensureDkgNodeConfig` (S1.4) when
 * the file is missing. The agent name comes from the resolved profile
 * (Hermes uses `profileName` as identity, unlike OpenClaw's IDENTITY.md
 * lookup); the daemon API port comes from the resolved daemon URL.
 *
 * Network config loading is deferred to `loadHermesNetworkConfig` —
 * absent network config means we can't bootstrap and the caller logs a
 * warning. This matches the OpenClaw "skip when no faucet configured"
 * shape: bootstrap is best-effort during fresh setup, not a hard requirement.
 */
async function bootstrapDkgNodeConfig(
  profile: HermesProfileMetadata,
  setupOptions: HermesSetupOptions,
  warnings: string[],
): Promise<void> {
  const network = loadHermesNetworkConfig(warnings);
  if (!network) return;
  const apiPort = setupOptions.daemonUrl
    ? new URL(setupOptions.daemonUrl).port
      ? Number(new URL(setupOptions.daemonUrl).port)
      : 9200
    : 9200;
  const agentName = profile.profileName ?? 'hermes-default';
  // Late-bind the import so test suites that mock `dkg-core` don't have to
  // declare `ensureDkgNodeConfig` in the mock returns up front.
  const { ensureDkgNodeConfig } = await import('@origintrail-official/dkg-core');
  ensureDkgNodeConfig({
    agentName,
    network,
    apiPort,
    existing: {},
  });
}

/**
 * Probe `network/<env>.json` from the bundled CLI package. Mirrors
 * OpenClaw's `loadNetworkConfig` shape but inlined here per
 * `helper-reuse-recommendation.md` §43-46 (Hermes-only copy-shape; the
 * CLI lookup itself uses the shared `resolveCliPackageDir` from S1.1).
 *
 * Returns `null` (with a warning) when the network config can't be
 * located; absent network config is non-fatal — bootstrap and faucet
 * steps simply skip.
 */
function loadHermesNetworkConfig(warnings: string[]): FundWalletsNetworkConfig & {
  networkName: string;
  defaultNodeRole: string;
  defaultContextGraphs?: string[];
  autoUpdate?: { enabled: boolean };
} | null {
  // Defer import — keeps adapter-hermes startup light when the orchestrator
  // is not invoked, and lets test suites mock `dkg-core` without declaring
  // `resolveCliPackageDir`.
  let cliDir: string | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const core = require('@origintrail-official/dkg-core') as typeof import('@origintrail-official/dkg-core');
    cliDir = core.resolveCliPackageDir();
  } catch {
    cliDir = null;
  }
  // testnet.json is the default network — operators with a custom env can
  // pre-write `~/.dkg/config.json` and `runHermesSetup` will skip bootstrap.
  const candidates: string[] = [];
  if (cliDir) candidates.push(join(cliDir, 'network', 'testnet.json'));
  candidates.push(resolve(__dirname, '..', '..', '..', 'network', 'testnet.json'));
  candidates.push(resolve(__dirname, '..', '..', '..', '..', 'network', 'testnet.json'));
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        return JSON.parse(readFileSync(candidate, 'utf-8'));
      } catch (err: any) {
        warnings.push(`Could not parse ${candidate}: ${err?.message ?? String(err)}`);
        return null;
      }
    }
  }
  warnings.push('Could not locate network/testnet.json (network bootstrap + faucet steps skipped)');
  return null;
}

/**
 * Fire a `console.warn` when both `--port` and `--daemon-url` are passed
 * and the URL host:port disagrees with `--port`. First-wins on
 * `daemonUrl` per `setup-entrypoint-contract.md` §2 Open Question 1.
 * The exact warn string is asserted by H-AC-58 (added in S2 step 6).
 */
function warnPortConflict(req: HermesSetupRequest, warnings: string[]): void {
  if (req.port == null || !req.daemonUrl) return;
  const portNum = typeof req.port === 'number' ? req.port : Number(req.port);
  if (!Number.isFinite(portNum)) return;
  let urlPort: number | null = null;
  let urlHost = '';
  try {
    const u = new URL(req.daemonUrl);
    urlHost = u.hostname;
    urlPort = u.port ? Number(u.port) : null;
  } catch {
    return;
  }
  if (urlPort == null || urlPort === portNum) return;
  const line = `daemon URL host:port (${urlHost}:${urlPort}) does not match --port (${portNum}); using URL`;
  console.warn(line);
  warnings.push(line);
}

/**
 * Lift the resolved bridge config from `HermesSetupState` (or the
 * profile metadata when state is absent) into the canonical
 * `HermesSetupResult.transport` shape. Falls back to the legacy
 * `{ kind: 'hermes-openai', gatewayUrl: DEFAULT_HERMES_API_SERVER_URL }`
 * shape that the daemon route already uses (`local-agents.ts:509-512`)
 * when nothing is configured.
 */
function computeTransportFromState(
  state: HermesSetupState | undefined,
  _profile: HermesProfileMetadata,
): HermesSetupResult['transport'] {
  const bridge = state?.bridge;
  if (bridge) {
    return {
      kind: bridge.protocol ?? 'hermes-channel',
      ...(bridge.url ? { bridgeUrl: bridge.url } : {}),
      ...(bridge.gatewayUrl ? { gatewayUrl: bridge.gatewayUrl } : {}),
      ...(bridge.healthUrl ? { healthUrl: bridge.healthUrl } : {}),
    };
  }
  return { kind: 'hermes-openai', gatewayUrl: DEFAULT_HERMES_API_SERVER_URL };
}
