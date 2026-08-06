/**
 * Setup lifecycle for the Prime Agent adapter.
 *
 * Prime Agent has no memory-provider slot to swap, so "election" here means
 * registering our extension in `settings.json.extensions`. The ownership and
 * reversal contract is copied from adapter-hermes deliberately, because it is
 * the part that has to survive a SIGINT:
 *
 *   1. write setup-state.json carrying `priorSettings` (FIRST-WINS)  ← intent
 *   2. write settings.json.bak.<unix-ms> with the original bytes      ← backup
 *   3. rewrite settings.json adding our extension path                ← destructive
 *
 * An interrupt between any two steps stays recoverable: a later run reads the
 * persisted snapshot and can restore from the captured backup even if step 3
 * never happened.
 *
 * One asymmetry versus Hermes: `priorMemoryProvider` is a scalar, ours is an
 * array the user may legitimately edit between setup and disconnect. Restore is
 * therefore *entry removal*, never wholesale replacement — otherwise we would
 * silently revert unrelated user edits.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readLiveSessions,
  isLoopbackBridgeUrl,
} from './session-registry.js';
import type {
  PrimeAgentProfileMetadata,
  PrimeAgentPublishGuardPolicy,
  PrimeAgentRestoreRequest,
  PrimeAgentRestoreResult,
  PrimeAgentSetupPlan,
  PrimeAgentSetupPlanAction,
  PrimeAgentSetupRequest,
  PrimeAgentSetupResult,
  PrimeAgentSetupState,
  PrimeAgentVerifyResult,
} from './types.js';

export const MANAGED_BY = '@origintrail-official/dkg-adapter-prime-agent';
export const ADAPTER_STATE_DIRNAME = '.dkg-adapter-prime-agent';
export const SETUP_STATE_FILENAME = 'setup-state.json';
export const ADAPTER_CONFIG_FILENAME = 'dkg.json';
export const DEFAULT_DAEMON_URL = 'http://127.0.0.1:9200';
export const DEFAULT_CONTEXT_GRAPH = 'agent-context';
export const DEFAULT_MEMORY_ASSERTION = 'memory';

/** Conservative by construction — see DESIGN.md §Q9. */
export const DEFAULT_PUBLISH_GUARD: PrimeAgentPublishGuardPolicy = {
  defaultToolExposure: 'request-only',
  allowDirectPublish: false,
  allowContextGraphAdminTools: false,
  requireExplicitApproval: true,
  importRoots: [],
};

export interface PrimeAgentSetupOptions {
  profileName?: string;
  agentDir?: string;
  memoryMode?: 'hooks' | 'tools-only';
  daemonUrl?: string;
  contextGraph?: string;
  memoryAssertion?: string;
  preserveSettings?: boolean;
  dryRun?: boolean;
  /** Injectable for tests; defaults to the shipped extension file. */
  extensionPath?: string;
}

/** `~/.prime/agent` unless PRIME_AGENT_CODING_AGENT_DIR overrides it. */
export function resolveAgentDir(explicit?: string): string {
  if (explicit) return resolve(explicit);
  const fromEnv = process.env.PRIME_AGENT_CODING_AGENT_DIR;
  if (fromEnv) return resolve(fromEnv);
  return join(homedir(), '.prime', 'agent');
}

/** Absolute path of the extension we register. Ships inside this package. */
export function defaultExtensionPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/setup.js -> package root -> extension/dist/extension.js
  return resolve(here, '..', 'extension', 'dist', 'extension.js');
}

export function resolvePrimeAgentProfile(
  options: Pick<PrimeAgentSetupOptions, 'profileName' | 'agentDir' | 'memoryMode'> = {},
): PrimeAgentProfileMetadata {
  if (options.profileName && /[\\/]/.test(options.profileName)) {
    throw new Error('profile name must not contain path separators');
  }
  const agentDir = resolveAgentDir(options.agentDir);
  const stateDir = join(agentDir, ADAPTER_STATE_DIRNAME);
  return {
    ...(options.profileName ? { profileName: options.profileName } : {}),
    agentDir,
    settingsPath: join(agentDir, 'settings.json'),
    stateDir,
    sessionsDir: join(stateDir, 'sessions'),
    memoryMode: options.memoryMode ?? 'hooks',
  };
}

interface PrimeSettings {
  extensions?: string[];
  [k: string]: unknown;
}

export function readSettings(settingsPath: string): PrimeSettings {
  if (!existsSync(settingsPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as PrimeSettings;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    // A malformed settings.json is the user's file, not ours. Refuse rather
    // than "repair" it — rewriting would destroy whatever they were editing.
    throw new Error(
      `Prime Agent settings.json is not valid JSON (${settingsPath}); refusing to modify it: ${String(err)}`,
    );
  }
}

export function readSetupState(profile: PrimeAgentProfileMetadata): PrimeAgentSetupState | undefined {
  const path = join(profile.stateDir, SETUP_STATE_FILENAME);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PrimeAgentSetupState;
  } catch {
    return undefined;
  }
}

function writeSetupState(profile: PrimeAgentProfileMetadata, state: PrimeAgentSetupState): string {
  mkdirSync(profile.stateDir, { recursive: true });
  const path = join(profile.stateDir, SETUP_STATE_FILENAME);
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  return path;
}

function buildState(
  profile: PrimeAgentProfileMetadata,
  options: PrimeAgentSetupOptions,
  extensionPath: string,
  prior?: PrimeAgentSetupState,
): PrimeAgentSetupState {
  const now = new Date().toISOString();
  return {
    managedBy: MANAGED_BY,
    version: '10.0.12',
    status: 'configured',
    profile,
    daemonUrl: options.daemonUrl ?? prior?.daemonUrl ?? DEFAULT_DAEMON_URL,
    contextGraph: options.contextGraph ?? prior?.contextGraph ?? DEFAULT_CONTEXT_GRAPH,
    memoryAssertion: options.memoryAssertion ?? prior?.memoryAssertion ?? DEFAULT_MEMORY_ASSERTION,
    extensionPath,
    publishGuard: prior?.publishGuard ?? DEFAULT_PUBLISH_GUARD,
    installedAt: prior?.installedAt ?? now,
    updatedAt: now,
    managedFiles: prior?.managedFiles ?? [],
    // FIRST-WINS: never overwrite a snapshot taken by an earlier run.
    ...(prior?.priorSettings ? { priorSettings: prior.priorSettings } : {}),
  };
}

/** Non-destructive: computes what setup would do. */
export function planPrimeAgentSetup(options: PrimeAgentSetupOptions = {}): PrimeAgentSetupPlan {
  const profile = resolvePrimeAgentProfile(options);
  const extensionPath = options.extensionPath ?? defaultExtensionPath();
  const prior = readSetupState(profile);
  const state = buildState(profile, options, extensionPath, prior);
  const actions: PrimeAgentSetupPlanAction[] = [];
  const warnings: string[] = [];

  const settings = readSettings(profile.settingsPath);
  const extensions = Array.isArray(settings.extensions) ? settings.extensions : [];
  const already = extensions.includes(extensionPath);

  if (!existsSync(profile.agentDir)) {
    warnings.push(
      `Prime Agent config dir not found at ${profile.agentDir} — is Prime Agent installed for this user?`,
    );
  }

  actions.push({
    type: existsSync(profile.stateDir) ? 'update' : 'create',
    path: join(profile.stateDir, SETUP_STATE_FILENAME),
    reason: 'adapter setup state (records priorSettings before any destructive write)',
  });
  actions.push({
    type: existsSync(profile.sessionsDir) ? 'skip' : 'create',
    path: profile.sessionsDir,
    reason: 'per-session bridge discovery directory, written by the extension',
  });

  if (already) {
    actions.push({
      type: 'skip',
      path: profile.settingsPath,
      reason: 'extension already registered in settings.json',
    });
  } else if (options.preserveSettings) {
    const conflicting = extensions.filter((p) => p.includes('dkg-adapter-prime-agent'));
    if (conflicting.length) {
      warnings.push(
        `--preserve-settings: refusing to modify settings.json; a conflicting DKG entry exists: ${conflicting.join(', ')}`,
      );
      actions.push({ type: 'skip', path: profile.settingsPath, reason: 'preserve-settings' });
    } else {
      actions.push({ type: 'update', path: profile.settingsPath, reason: 'register extension path' });
    }
  } else {
    actions.push({ type: 'update', path: profile.settingsPath, reason: 'register extension path' });
    if (existsSync(profile.settingsPath)) {
      actions.push({
        type: 'create',
        path: `${profile.settingsPath}.bak.<unix-ms>`,
        reason: 'verbatim backup taken before the destructive write',
      });
    }
  }

  if (!existsSync(extensionPath)) {
    warnings.push(
      `extension bundle missing at ${extensionPath} — run the package build before setup`,
    );
  }

  return { dryRun: options.dryRun ?? false, profile, actions, warnings, state };
}

/**
 * The destructive half. Ordering is the contract; see the module comment.
 */
export function setupPrimeAgentProfile(options: PrimeAgentSetupOptions = {}): PrimeAgentSetupPlan {
  const plan = planPrimeAgentSetup(options);
  if (plan.dryRun) return plan;

  const { profile } = plan;
  const extensionPath = plan.state.extensionPath;
  mkdirSync(profile.stateDir, { recursive: true });
  mkdirSync(profile.sessionsDir, { recursive: true });

  const settings = readSettings(profile.settingsPath);
  const extensions = Array.isArray(settings.extensions) ? [...settings.extensions] : [];
  const already = extensions.includes(extensionPath);
  const preserveBlocked =
    options.preserveSettings && extensions.some((p) => p.includes('dkg-adapter-prime-agent')) && !already;

  const managedFiles = new Set(plan.state.managedFiles);
  managedFiles.add(join(profile.stateDir, SETUP_STATE_FILENAME));
  managedFiles.add(profile.sessionsDir);

  let state: PrimeAgentSetupState = { ...plan.state, managedFiles: [...managedFiles] };

  if (!already && !preserveBlocked) {
    const backupPath = `${profile.settingsPath}.bak.${Date.now()}`;

    // STEP 1 — intent before destruction. First-wins: only capture if we have
    // not captured before, so a re-run cannot overwrite the original truth.
    if (!state.priorSettings) {
      state = {
        ...state,
        priorSettings: {
          extensionsSnapshot: [...extensions],
          settingsBackupPath: backupPath,
          capturedAt: new Date().toISOString(),
        },
      };
    }
    writeSetupState(profile, state);

    // STEP 2 — verbatim backup of the original bytes.
    if (existsSync(profile.settingsPath)) {
      writeFileSync(state.priorSettings!.settingsBackupPath, readFileSync(profile.settingsPath));
      managedFiles.add(state.priorSettings!.settingsBackupPath);
    }

    // STEP 3 — the destructive write.
    const next: PrimeSettings = { ...settings, extensions: [...extensions, extensionPath] };
    writeFileSync(profile.settingsPath, `${JSON.stringify(next, null, 2)}\n`);
    managedFiles.add(profile.settingsPath);
  }

  state = { ...state, managedFiles: [...managedFiles], updatedAt: new Date().toISOString() };
  writeSetupState(profile, state);
  return { ...plan, state };
}

/**
 * Restore: surgical first (remove exactly our entry, leave unrelated user edits
 * intact), backup-rename as fallback, then VERIFY the entry is really gone.
 */
export function restorePrimeAgentProfile(req: PrimeAgentRestoreRequest = {}): PrimeAgentRestoreResult {
  const profile = resolvePrimeAgentProfile({ agentDir: req.agentDir, profileName: req.profile });
  const state = readSetupState(profile);
  if (!state) return { ok: true, path: 'noop' };

  const target = state.extensionPath;
  try {
    const settings = readSettings(profile.settingsPath);
    const extensions = Array.isArray(settings.extensions) ? settings.extensions : [];
    if (extensions.includes(target)) {
      const next: PrimeSettings = { ...settings, extensions: extensions.filter((p) => p !== target) };
      writeFileSync(profile.settingsPath, `${JSON.stringify(next, null, 2)}\n`);
      const post = readSettings(profile.settingsPath);
      const stillThere = Array.isArray(post.extensions) && post.extensions.includes(target);
      if (stillThere) return { ok: false, path: 'failed', restoreError: 'entry still present after rewrite' };
      return { ok: true, path: 'surgical' };
    }
    return { ok: true, path: 'noop' };
  } catch (surgicalErr) {
    const backup = state.priorSettings?.settingsBackupPath;
    if (backup && existsSync(backup)) {
      try {
        renameSync(backup, profile.settingsPath);
        const post = readSettings(profile.settingsPath);
        const stillThere = Array.isArray(post.extensions) && post.extensions.includes(target);
        if (stillThere) {
          return { ok: false, path: 'failed', restoredFrom: backup, restoreError: 'entry present in backup' };
        }
        return { ok: true, path: 'backup-file', restoredFrom: backup };
      } catch (renameErr) {
        return { ok: false, path: 'failed', restoreError: String(renameErr) };
      }
    }
    return { ok: false, path: 'failed', restoreError: String(surgicalErr) };
  }
}

export function disconnectPrimeAgentProfile(options: PrimeAgentSetupOptions = {}): PrimeAgentSetupPlan {
  const plan = planPrimeAgentSetup(options);
  if (plan.dryRun) return plan;
  restorePrimeAgentProfile({ agentDir: options.agentDir, profile: options.profileName });
  const profile = plan.profile;
  const state = readSetupState(profile);
  if (state) writeSetupState(profile, { ...state, status: 'disconnected', updatedAt: new Date().toISOString() });
  return plan;
}

export function verifyPrimeAgentProfile(options: PrimeAgentSetupOptions = {}): PrimeAgentVerifyResult {
  const profile = resolvePrimeAgentProfile(options);
  const state = readSetupState(profile);
  const warnings: string[] = [];
  const errors: string[] = [];

  if (!state) {
    return {
      ok: false,
      status: 'error',
      profile,
      warnings,
      errors: ['adapter is not set up for this Prime Agent config dir'],
      sessions: [],
    };
  }

  if (!existsSync(state.extensionPath)) {
    errors.push(`extension bundle missing at ${state.extensionPath}`);
  }

  try {
    const settings = readSettings(profile.settingsPath);
    const extensions = Array.isArray(settings.extensions) ? settings.extensions : [];
    if (!extensions.includes(state.extensionPath)) {
      errors.push('extension path is not registered in settings.json');
    }
    // Election here is advisory, not enforced by the host: another extension can
    // register the same hooks. Say so rather than implying exclusivity.
    const others = extensions.filter((p) => p !== state.extensionPath);
    if (others.length) {
      warnings.push(
        `${others.length} other extension(s) are registered; DKG memory election is advisory, not exclusive`,
      );
    }
  } catch (err) {
    errors.push(String(err));
  }

  const sessions = readLiveSessions(profile.sessionsDir);
  if (sessions.length === 0) {
    // A first-class, non-error state: the adapter is installed and correct,
    // there simply is no live session to talk to right now.
    warnings.push('no live Prime Agent session — start one for chat to be routable');
  }
  for (const s of sessions) {
    if (!isLoopbackBridgeUrl(s.bridgeUrl)) {
      errors.push(`session ${s.sessionId} advertises a non-loopback bridge url`);
    }
  }

  const ok = errors.length === 0;
  return {
    ok,
    status: ok ? (sessions.length ? 'configured' : 'degraded') : 'error',
    profile,
    warnings,
    errors,
    sessions,
    state,
  };
}

/** Canonical orchestrator, mirroring runHermesSetup's role. */
export async function runPrimeAgentSetup(
  req: PrimeAgentSetupRequest = {},
): Promise<PrimeAgentSetupResult> {
  const options: PrimeAgentSetupOptions = {
    ...(req.profile !== undefined ? { profileName: req.profile } : {}),
    ...(req.agentDir !== undefined ? { agentDir: req.agentDir } : {}),
    ...(req.memoryMode !== undefined ? { memoryMode: req.memoryMode } : {}),
    ...(req.daemonUrl !== undefined ? { daemonUrl: req.daemonUrl } : {}),
    ...(req.contextGraph !== undefined ? { contextGraph: req.contextGraph } : {}),
    ...(req.memoryAssertion !== undefined ? { memoryAssertion: req.memoryAssertion } : {}),
    ...(req.preserveSettings !== undefined ? { preserveSettings: req.preserveSettings } : {}),
    ...(req.dryRun !== undefined ? { dryRun: req.dryRun } : {}),
  };

  const warnings: string[] = [];
  const errors: string[] = [];
  let plan: PrimeAgentSetupPlan;
  try {
    plan = setupPrimeAgentProfile(options);
  } catch (err) {
    const profile = resolvePrimeAgentProfile(options);
    return {
      ok: false,
      status: 'error',
      profile,
      transport: { kind: 'prime-agent-channel' },
      settingsPatched: false,
      warnings,
      errors: [String(err)],
    };
  }
  warnings.push(...plan.warnings);

  const shouldVerify = req.verify !== false && !plan.dryRun;
  let sessions = plan.dryRun ? [] : readLiveSessions(plan.profile.sessionsDir);
  if (shouldVerify) {
    const v = verifyPrimeAgentProfile(options);
    warnings.push(...v.warnings);
    errors.push(...v.errors);
    sessions = v.sessions;
  }

  const first = sessions[0];
  const ok = errors.length === 0;
  return {
    ok,
    status: ok ? (sessions.length ? 'configured' : 'degraded') : 'error',
    profile: plan.profile,
    transport: {
      kind: 'prime-agent-channel',
      ...(first ? { bridgeUrl: first.bridgeUrl, healthUrl: `${first.bridgeUrl}/health` } : {}),
    },
    settingsPatched: plan.actions.some((a) => a.path === plan.profile.settingsPath && a.type === 'update'),
    warnings,
    errors,
    state: plan.state,
  };
}

/* CLI-facing verbs, named to match `dkg hermes <verb>`. */

export async function runSetup(options: PrimeAgentSetupRequest = {}): Promise<void> {
  const result = await runPrimeAgentSetup(options);
  for (const w of result.warnings) console.warn(`[prime-agent] ${w}`);
  if (!result.ok) throw new Error(result.errors.join('\n'));
  console.log(`[prime-agent] ${result.status}; settings patched: ${result.settingsPatched}`);
}

export async function runVerify(options: PrimeAgentSetupOptions = {}): Promise<void> {
  const v = verifyPrimeAgentProfile(options);
  for (const w of v.warnings) console.warn(`[prime-agent] ${w}`);
  for (const e of v.errors) console.error(`[prime-agent] ${e}`);
  if (!v.ok) throw new Error('verification failed');
  console.log(`[prime-agent] ${v.status}; live sessions: ${v.sessions.length}`);
}

export async function runStatus(options: PrimeAgentSetupOptions = {}): Promise<void> {
  const profile = resolvePrimeAgentProfile(options);
  const state = readSetupState(profile);
  const sessions = readLiveSessions(profile.sessionsDir);
  console.log(
    JSON.stringify(
      { configured: Boolean(state), status: state?.status ?? 'disconnected', sessions },
      null,
      2,
    ),
  );
}

export async function runDoctor(options: PrimeAgentSetupOptions = {}): Promise<void> {
  const v = verifyPrimeAgentProfile(options);
  const lines: string[] = [];
  lines.push(`agent dir      : ${v.profile.agentDir}`);
  lines.push(`settings.json  : ${existsSync(v.profile.settingsPath) ? 'present' : 'MISSING'}`);
  lines.push(`extension      : ${v.state?.extensionPath ?? '(not set up)'}`);
  lines.push(`live sessions  : ${v.sessions.length}`);
  if (v.sessions.length === 0) {
    lines.push('  -> installed but no session running: this is normal, start a Prime Agent session');
  }
  for (const w of v.warnings) lines.push(`warning        : ${w}`);
  for (const e of v.errors) lines.push(`error          : ${e}`);
  console.log(lines.join('\n'));
}

export async function runDisconnect(options: PrimeAgentSetupOptions = {}): Promise<void> {
  disconnectPrimeAgentProfile(options);
  console.log('[prime-agent] disconnected');
}

export async function runReconnect(options: PrimeAgentSetupOptions = {}): Promise<void> {
  await runSetup(options as PrimeAgentSetupRequest);
}

export async function runUninstall(options: PrimeAgentSetupOptions = {}): Promise<void> {
  const restore = restorePrimeAgentProfile({ agentDir: options.agentDir, profile: options.profileName });
  if (!restore.ok) console.warn(`[prime-agent] restore reported: ${restore.restoreError}`);
  console.log('[prime-agent] uninstalled (backup retained)');
}

export const setup = runSetup;
export const verify = runVerify;
export const status = runStatus;
export const doctor = runDoctor;
export const disconnect = runDisconnect;
export const reconnect = runReconnect;
export const uninstall = runUninstall;
