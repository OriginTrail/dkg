import { cpSync, existsSync, readFileSync, rmSync, writeFileSync, mkdirSync, statSync, rmdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import {
  type HermesMemoryMode,
  type HermesProfileMetadata,
  type HermesPublishGuardPolicy,
  type HermesRuntimeStatus,
  type HermesSetupState,
} from './types.js';
import { HermesDkgClient, redact } from './dkg-client.js';

const MANAGED_BY = '@origintrail-official/dkg-adapter-hermes' as const;
const STATE_VERSION = 1;
const CONFIG_BEGIN = '# BEGIN DKG ADAPTER HERMES MANAGED';
const CONFIG_END = '# END DKG ADAPTER HERMES MANAGED';
const PLUGIN_OWNER_FILE = '.dkg-adapter-hermes-owner.json';
const TOP_LEVEL_MEMORY_BLOCK_RE = /^memory\s*:\s*$/;
const TOP_LEVEL_MEMORY_PROVIDER_RE = /^memory\.provider\s*:\s*["']?([^"'\s#]+)["']?/;
const INDENTED_PROVIDER_RE = /^(\s+)provider\s*:\s*["']?([^"'\s#]+)["']?/;

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
  const warnings = detectProviderConflict(profile, options.memoryMode ?? 'provider');
  const daemonUrl = stripTrailingSlashes(options.daemonUrl ?? 'http://127.0.0.1:9200');
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
    contextGraph: options.contextGraph ?? 'hermes-memory',
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
    ...(plan.state.bridge ? { bridge: plan.state.bridge } : {}),
    context_graph: plan.state.contextGraph,
    agent_name: plan.state.agentName ?? '',
    profile_name: plan.profile.profileName ?? '',
    memory_mode: plan.profile.memoryMode,
    publish_guard: plan.state.publishGuard,
    publish_tool: plan.state.publishGuard.defaultToolExposure,
    allow_direct_publish: plan.state.publishGuard.allowDirectPublish === true,
    require_explicit_approval: plan.state.publishGuard.requireExplicitApproval !== false,
    require_wallet_check: plan.state.publishGuard.requireWalletCheck !== false,
  });

  installHermesProviderPlugin(plan.profile);

  if (plan.profile.memoryMode === 'provider') {
    ensureManagedProviderBlock(plan.profile.configPath);
  } else {
    removeManagedProviderBlock(plan.profile.configPath);
  }

  if (options.nodeSkillContent) {
    const skillPath = join(plan.profile.hermesHome, 'skills', 'dkg-node', 'SKILL.md');
    writeOwnedText(skillPath, options.nodeSkillContent);
  }

  const existingState = readSetupState(plan.profile);
  const state = {
    ...plan.state,
    installedAt: existingState?.installedAt ?? plan.state.installedAt,
    updatedAt: new Date().toISOString(),
  };
  writeOwnedJson(join(plan.profile.stateDir, 'setup-state.json'), state);
  plan.state = state;
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
  const providerConflicts = detectProviderConflict(effectiveProfile, effectiveMemoryMode);
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
    } else if (!hasManagedDkgProvider(readFileSync(profile.configPath, 'utf-8'))) {
      errors.push(`Hermes provider mode requires an adapter-managed memory.provider: dkg block in ${profile.configPath}`);
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

export async function runSetup(options: HermesCliOptions = {}): Promise<void> {
  const setupOptions = toSetupOptions(options);
  await executeSetup(options, setupOptions);
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
}

export async function runReconnect(options: HermesCliOptions = {}): Promise<void> {
  await executeSetup(options, toReconnectSetupOptions(options));
}

export async function runUninstall(options: HermesCliOptions = {}): Promise<void> {
  const setupOptions = toSetupOptions(options);
  const uninstallState = readSetupState(resolveHermesProfile(setupOptions));
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
    defaultToolExposure: input?.defaultToolExposure ?? 'request-only',
    allowDirectPublish: input?.allowDirectPublish ?? false,
    requireExplicitApproval: input?.requireExplicitApproval ?? true,
    requireWalletCheck: input?.requireWalletCheck ?? true,
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
    memoryMode,
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
  const apiToken = loadDkgAuthToken();
  const transport: { kind: 'hermes-channel'; bridgeUrl?: string; gatewayUrl?: string; healthUrl?: string } = {
    kind: 'hermes-channel',
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
  const apiToken = loadDkgAuthToken();
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
  const gatewayUrl = stripTrailingSlashes(trimmed(options.gatewayUrl) ?? '');
  const healthUrl = stripTrailingSlashes(trimmed(options.bridgeHealthUrl) ?? '');
  if (!url && !gatewayUrl && !healthUrl) return undefined;
  if (url && !isLoopbackUrl(url)) {
    throw new Error('Hermes bridge URL must be a loopback URL; use --gateway-url for WSL2 or remote Hermes gateways.');
  }
  return {
    ...(url ? { url } : {}),
    ...(gatewayUrl ? { gatewayUrl } : {}),
    ...(healthUrl ? { healthUrl } : {}),
  };
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

function loadDkgAuthToken(): string | undefined {
  const envToken = trimmed(process.env.DKG_API_TOKEN) ?? trimmed(process.env.DKG_AUTH_TOKEN);
  if (envToken) return envToken;

  const dkgHome = resolve(expandHome(trimmed(process.env.DKG_HOME) ?? join(homedir(), '.dkg')));
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
  for (const line of lines) {
    if (TOP_LEVEL_MEMORY_BLOCK_RE.test(line)) {
      inMemory = true;
      continue;
    }
    if (inMemory && /^\S/.test(line)) {
      inMemory = false;
    }
    if (inMemory) {
      const match = line.match(INDENTED_PROVIDER_RE);
      if (match) return match[2];
    }
    const inline = line.match(TOP_LEVEL_MEMORY_PROVIDER_RE);
    if (inline) return inline[1];
  }
  return null;
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

function ensureManagedProviderBlock(configPath: string): void {
  const existing = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : '';
  const configuredProvider = findConfiguredMemoryProvider(existing);
  if (!existing.includes(CONFIG_BEGIN) && configuredProvider === 'dkg') {
    writeOwnedText(configPath, markExistingDkgProvider(existing), false);
    return;
  }
  if (configuredProvider && configuredProvider !== 'dkg') {
    throw new Error(`Refusing to replace existing Hermes memory.provider: ${configuredProvider}`);
  }

  const unmanaged = removeManagedBlock(existing);
  const next = hasTopLevelMemoryBlock(unmanaged)
    ? insertManagedProviderIntoMemoryBlock(unmanaged)
    : appendManagedMemoryBlock(unmanaged);
  writeOwnedText(configPath, next, false);
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
  let inserted = false;
  for (const line of lines) {
    next.push(line);
    if (!inserted && TOP_LEVEL_MEMORY_BLOCK_RE.test(line)) {
      const indent = line.match(/^(\s*)/)?.[1] ?? '';
      next.push(`${indent}  ${CONFIG_BEGIN}`);
      next.push(`${indent}  provider: dkg`);
      next.push(`${indent}  ${CONFIG_END}`);
      inserted = true;
    }
  }
  return next.join('\n');
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
  const moduleDir = dirname(fileURLToPath(import.meta.url));
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
