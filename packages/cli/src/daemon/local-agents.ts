// Local-agent integration code extracted from the legacy monolithic
// `daemon.ts`. Owns the integration registry, normalize/merge
// helpers, and the UI-driven connect / reverse / refresh flows that
// drive Hermes / OpenClaw setup from the node UI.
//
// Heavy on calls into `./openclaw.ts` for the actual transport
// machinery. Stays separate so the local-agent vocabulary
// (definitions, records, statuses) doesn't pollute the openclaw
// module.

import { writeFile, mkdir, readFile, unlink } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';

import type { DKGAgent } from '@origintrail-official/dkg-agent';
import {
  loadConfig,
  saveConfig,
  dkgDir,
  type DkgConfig,
  type LocalAgentIntegrationCapabilities,
  type LocalAgentIntegrationConfig,
  type LocalAgentIntegrationManifest,
  type LocalAgentIntegrationRuntime,
  type LocalAgentIntegrationStatus,
  type LocalAgentIntegrationTransport,
} from '../config.js';
import { daemonState } from './state.js';
// Pull every needed symbol from openclaw — including the previously
// module-private helpers that handle-request and these flows reach
// into.
import {
  OpenClawChannelTarget,
  OpenClawChannelHealthReport,
  OpenClawUiAttachDeps,
  cancelPendingLocalAgentAttachJob,
  scheduleOpenClawUiAttachJob,
  isOpenClawUiAttachCancelled,
  formatOpenClawUiAttachFailure,
  getOpenClawChannelTargets,
  isOpenClawMemorySlotElected,
  probeOpenClawChannelHealth,
  runOpenClawUiSetup,
  restartOpenClawGateway,
  waitForOpenClawChatReady,
  transportPatchFromOpenClawTarget,
  ensureOpenClawBridgeAvailable,
  buildOpenClawChannelHeaders,
  trimTrailingSlashes,
  buildOpenClawGatewayBase,
  loadBridgeAuthToken,
  localOpenclawConfigPath,
} from './openclaw.js';
import {
  DEFAULT_HERMES_API_SERVER_URL,
  type HermesChannelHealthReport,
  probeHermesChannelHealth,
  runHermesUiSetup,
  transportPatchFromHermesTarget,
} from './hermes.js';
import {
  type PendingAttachJob,
  scheduleAttachJob,
  isCancelled as isAttachJobCancelled,
} from './local-agent-attach-jobs.js';
import type { HermesSetupResult } from '@origintrail-official/dkg-adapter-hermes';

const daemonRequire = createRequire(import.meta.url);

export interface LocalAgentIntegrationDefinition {
  id: string;
  name: string;
  description: string;
  transportKind?: string;
  capabilities: LocalAgentIntegrationCapabilities;
  manifest?: LocalAgentIntegrationManifest;
}

export interface LocalAgentIntegrationRecord extends LocalAgentIntegrationConfig {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  transport: LocalAgentIntegrationTransport;
  capabilities: LocalAgentIntegrationCapabilities;
  runtime: LocalAgentIntegrationRuntime;
  status: LocalAgentIntegrationStatus;
  manifest?: LocalAgentIntegrationManifest;
}

export const LOCAL_AGENT_INTEGRATION_DEFINITIONS: Record<string, LocalAgentIntegrationDefinition> = {
  openclaw: {
    id: 'openclaw',
    name: 'OpenClaw',
    description: 'Connect a local OpenClaw agent through the DKG node.',
    transportKind: 'openclaw-channel',
    capabilities: {
      localChat: true,
      connectFromUi: true,
      installNode: true,
      dkgPrimaryMemory: true,
      wmImportPipeline: true,
      nodeServedSkill: true,
    },
    manifest: {
      packageName: '@origintrail-official/dkg-adapter-openclaw',
      setupEntry: './setup-entry.mjs',
    },
  },
  hermes: {
    id: 'hermes',
    name: 'Hermes',
    description: 'Connect a local Hermes agent through the DKG node.',
    transportKind: 'hermes-openai',
    capabilities: {
      localChat: true,
      chatAttachments: true,
      connectFromUi: true,
      installNode: true,
      dkgPrimaryMemory: true,
      wmImportPipeline: true,
      nodeServedSkill: true,
    },
    manifest: {
      packageName: '@origintrail-official/dkg-adapter-hermes',
      setupEntry: './setup-entry.mjs',
    },
  },
};


export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeIntegrationId(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeLocalAgentTransport(input: unknown): LocalAgentIntegrationTransport | undefined {
  if (!isPlainRecord(input)) return undefined;
  const transport: LocalAgentIntegrationTransport = {};
  if (typeof input.kind === 'string' && input.kind.trim()) transport.kind = input.kind.trim();
  if (typeof input.bridgeUrl === 'string' && input.bridgeUrl.trim()) transport.bridgeUrl = trimTrailingSlashes(input.bridgeUrl.trim());
  if (typeof input.gatewayUrl === 'string' && input.gatewayUrl.trim()) transport.gatewayUrl = trimTrailingSlashes(input.gatewayUrl.trim());
  if (Object.prototype.hasOwnProperty.call(input, 'healthUrl')) {
    transport.healthUrl = typeof input.healthUrl === 'string' && input.healthUrl.trim()
      ? trimTrailingSlashes(input.healthUrl.trim())
      : undefined;
  }
  return Object.keys(transport).length > 0 ? transport : undefined;
}

export function normalizeLocalAgentCapabilities(input: unknown): LocalAgentIntegrationCapabilities | undefined {
  if (!isPlainRecord(input)) return undefined;
  const capabilities: LocalAgentIntegrationCapabilities = {};
  const keys: (keyof LocalAgentIntegrationCapabilities)[] = [
    'localChat',
    'chatAttachments',
    'connectFromUi',
    'installNode',
    'dkgPrimaryMemory',
    'wmImportPipeline',
    'nodeServedSkill',
  ];
  for (const key of keys) {
    if (typeof input[key] === 'boolean') capabilities[key] = input[key];
  }
  return Object.keys(capabilities).length > 0 ? capabilities : undefined;
}

export function normalizeLocalAgentManifest(input: unknown): LocalAgentIntegrationManifest | undefined {
  if (!isPlainRecord(input)) return undefined;
  const manifest: LocalAgentIntegrationManifest = {};
  if (typeof input.packageName === 'string' && input.packageName.trim()) manifest.packageName = input.packageName.trim();
  if (typeof input.version === 'string' && input.version.trim()) manifest.version = input.version.trim();
  if (typeof input.setupEntry === 'string' && input.setupEntry.trim()) manifest.setupEntry = input.setupEntry.trim();
  return Object.keys(manifest).length > 0 ? manifest : undefined;
}

export function normalizeLocalAgentRuntime(input: unknown): LocalAgentIntegrationRuntime | undefined {
  if (!isPlainRecord(input)) return undefined;
  const runtime: LocalAgentIntegrationRuntime = {};
  const validStatuses = new Set<LocalAgentIntegrationStatus>([
    'disconnected',
    'configured',
    'connecting',
    'ready',
    'degraded',
    'error',
  ]);
  if (typeof input.status === 'string' && validStatuses.has(input.status as LocalAgentIntegrationStatus)) {
    runtime.status = input.status as LocalAgentIntegrationStatus;
  }
  if (typeof input.ready === 'boolean') runtime.ready = input.ready;
  if (input.lastError === null || typeof input.lastError === 'string') runtime.lastError = input.lastError;
  if (typeof input.updatedAt === 'string' && input.updatedAt.trim()) runtime.updatedAt = input.updatedAt.trim();
  return Object.keys(runtime).length > 0 ? runtime : undefined;
}

export function isLocalAgentExplicitlyUserDisabled(
  integration: Pick<LocalAgentIntegrationConfig, 'metadata'> | null | undefined,
): boolean {
  return integration?.metadata?.userDisabled === true;
}

export function isExplicitLocalAgentDisconnectPatch(patch: Pick<LocalAgentIntegrationConfig, 'enabled' | 'runtime'>): boolean {
  return patch.runtime?.status === 'disconnected';
}

export function normalizeExplicitLocalAgentDisconnectBody(body: Record<string, unknown>): Record<string, unknown> {
  const runtime = isPlainRecord(body.runtime) ? body.runtime : undefined;
  if (body.enabled !== false && runtime?.status !== 'disconnected') return body;
  return {
    ...body,
    enabled: false,
    runtime: {
      ...(runtime ?? {}),
      status: 'disconnected',
      ready: false,
      lastError: runtime?.lastError ?? null,
    },
  };
}

export function mergeLocalAgentIntegrationConfig(
  base: LocalAgentIntegrationConfig | undefined,
  patch: LocalAgentIntegrationConfig,
  options: { mergeTransport?: boolean } = {},
): LocalAgentIntegrationConfig {
  return {
    ...(base ?? {}),
    ...patch,
    transport: patch.transport !== undefined && options.mergeTransport ? {
      ...(base?.transport ?? {}),
      ...patch.transport,
    } : (patch.transport !== undefined ? patch.transport : (base?.transport ?? undefined)),
    capabilities: {
      ...(base?.capabilities ?? {}),
      ...(patch.capabilities ?? {}),
    },
    manifest: {
      ...(base?.manifest ?? {}),
      ...(patch.manifest ?? {}),
    },
    runtime: {
      ...(base?.runtime ?? {}),
      ...(patch.runtime ?? {}),
    },
    metadata: {
      ...(base?.metadata ?? {}),
      ...(patch.metadata ?? {}),
    },
  };
}

export function getStoredLocalAgentIntegrations(config: DkgConfig): Record<string, LocalAgentIntegrationConfig> {
  return config.localAgentIntegrations ?? {};
}

export function computeLocalAgentIntegrationStatus(record: LocalAgentIntegrationConfig): LocalAgentIntegrationStatus {
  if (record.runtime?.status) return record.runtime.status;
  if (record.runtime?.ready === true) return 'ready';
  if (record.enabled) return 'configured';
  return 'disconnected';
}

export function buildLocalAgentIntegrationRecord(
  id: string,
  definition: LocalAgentIntegrationDefinition | undefined,
  stored: LocalAgentIntegrationConfig | undefined,
): LocalAgentIntegrationRecord {
  const merged = mergeLocalAgentIntegrationConfig(
    definition
      ? {
          id,
          name: definition.name,
          description: definition.description,
          capabilities: definition.capabilities,
          manifest: definition.manifest,
          transport: definition.transportKind ? { kind: definition.transportKind } : undefined,
        }
      : { id },
    stored ?? { id },
  );
  const status = computeLocalAgentIntegrationStatus(merged);
  return {
    ...merged,
    id,
    name: merged.name?.trim() || definition?.name || id,
    description: merged.description?.trim() || definition?.description || `${id} local agent integration`,
    enabled: merged.enabled === true,
    transport: merged.transport ?? {},
    capabilities: merged.capabilities ?? {},
    runtime: merged.runtime ?? {},
    status,
  };
}

export function listLocalAgentIntegrations(config: DkgConfig): LocalAgentIntegrationRecord[] {
  const ids = new Set<string>([
    ...Object.keys(LOCAL_AGENT_INTEGRATION_DEFINITIONS),
    ...Object.keys(getStoredLocalAgentIntegrations(config)),
  ]);
  return [...ids]
    .map((id) => buildLocalAgentIntegrationRecord(id, LOCAL_AGENT_INTEGRATION_DEFINITIONS[id], getStoredLocalAgentIntegrations(config)[id]))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getLocalAgentIntegration(config: DkgConfig, id: string): LocalAgentIntegrationRecord | null {
  const normalizedId = normalizeIntegrationId(id);
  return listLocalAgentIntegrations(config).find((integration) => integration.id === normalizedId) ?? null;
}

export function pruneLegacyOpenClawConfig(config: DkgConfig): void {
  const mutable = config as DkgConfig & {
    openclawAdapter?: boolean;
    openclawChannel?: { bridgeUrl?: string; gatewayUrl?: string };
  };
  delete mutable.openclawAdapter;
  delete mutable.openclawChannel;
}

export function extractLocalAgentIntegrationPatch(body: Record<string, unknown>): LocalAgentIntegrationConfig {
  const patch: LocalAgentIntegrationConfig = {};
  if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim();
  if (typeof body.description === 'string' && body.description.trim()) patch.description = body.description.trim();
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;

  const transport = normalizeLocalAgentTransport(body.transport);
  const topLevelTransport = normalizeLocalAgentTransport({
    kind: typeof body.transportKind === 'string' ? body.transportKind : undefined,
    bridgeUrl: body.bridgeUrl,
    gatewayUrl: body.gatewayUrl,
    healthUrl: body.healthUrl,
  });
  patch.transport = transport || topLevelTransport;
  patch.capabilities = normalizeLocalAgentCapabilities(body.capabilities);
  patch.manifest = normalizeLocalAgentManifest(body.manifest);
  patch.runtime = normalizeLocalAgentRuntime(body.runtime);
  if (typeof body.setupEntry === 'string' && body.setupEntry.trim()) patch.setupEntry = body.setupEntry.trim();
  if (isPlainRecord(body.metadata)) patch.metadata = body.metadata;
  return patch;
}

export function connectLocalAgentIntegration(
  config: DkgConfig,
  body: Record<string, unknown>,
  now = new Date(),
): LocalAgentIntegrationRecord {
  const rawId = typeof body.id === 'string' ? body.id : '';
  const id = normalizeIntegrationId(rawId);
  if (!id) throw new Error('Missing "id"');
  const existing = getStoredLocalAgentIntegrations(config)[id];
  const patch = extractLocalAgentIntegrationPatch(body);
  const base: LocalAgentIntegrationConfig = {
    id,
    enabled: patch.enabled ?? true,
    connectedAt: existing?.connectedAt ?? now.toISOString(),
    updatedAt: now.toISOString(),
    runtime: patch.runtime ?? { status: patch.enabled === false ? 'disconnected' : 'configured', updatedAt: now.toISOString() },
  };
  const next = mergeLocalAgentIntegrationConfig(
    mergeLocalAgentIntegrationConfig(existing, base),
    patch,
    { mergeTransport: id === 'hermes' },
  );
  if (next.enabled === true && isLocalAgentExplicitlyUserDisabled(next)) {
    next.metadata = { ...(next.metadata ?? {}), userDisabled: false };
  }
  next.runtime = { ...(next.runtime ?? {}), updatedAt: now.toISOString() };
  config.localAgentIntegrations = { ...getStoredLocalAgentIntegrations(config), [id]: next };
  if (id === 'openclaw') pruneLegacyOpenClawConfig(config);
  return getLocalAgentIntegration(config, id)!;
}

export function updateLocalAgentIntegration(
  config: DkgConfig,
  id: string,
  body: Record<string, unknown>,
  now = new Date(),
): LocalAgentIntegrationRecord {
  const normalizedId = normalizeIntegrationId(id);
  if (!normalizedId) throw new Error('Missing integration id');
  const existing = getStoredLocalAgentIntegrations(config)[normalizedId] ?? { id: normalizedId };
  const patch = extractLocalAgentIntegrationPatch(body);
  const next = mergeLocalAgentIntegrationConfig(existing, patch, { mergeTransport: normalizedId === 'hermes' });
  if (isExplicitLocalAgentDisconnectPatch(patch)) {
    next.enabled = false;
    next.runtime = { ...(next.runtime ?? {}), status: 'disconnected', ready: false, lastError: null };
    next.metadata = { ...(next.metadata ?? {}), userDisabled: true };
  } else if (patch.enabled === true && isLocalAgentExplicitlyUserDisabled(next)) {
    next.metadata = { ...(next.metadata ?? {}), userDisabled: false };
  }
  next.id = normalizedId;
  next.updatedAt = now.toISOString();
  next.runtime = { ...(next.runtime ?? {}), updatedAt: now.toISOString() };
  if (!next.runtime.status) next.runtime.status = next.enabled === true ? 'configured' : 'disconnected';
  config.localAgentIntegrations = { ...getStoredLocalAgentIntegrations(config), [normalizedId]: next };
  if (normalizedId === 'openclaw') pruneLegacyOpenClawConfig(config);
  return getLocalAgentIntegration(config, normalizedId)!;
}

export function hasConfiguredLocalAgentChat(config: DkgConfig, id: string): boolean {
  const integration = getLocalAgentIntegration(config, id);
  return integration?.enabled === true
    && integration.capabilities.localChat === true;
}

export function hasStoredLocalAgentTransportConfig(
  integration: Pick<LocalAgentIntegrationConfig, 'transport' | 'runtime'> | null | undefined,
): boolean {
  if (!integration) return false;
  return Boolean(
    integration.transport?.bridgeUrl
    || integration.transport?.gatewayUrl
    || integration.transport?.healthUrl
    || integration.runtime?.ready === true,
  );
}

export type LocalAgentUiAttachDeps = OpenClawUiAttachDeps & {
  probeHermesHealth?: (
    config: DkgConfig,
    bridgeAuthToken: string | undefined,
    opts?: { timeoutMs?: number },
  ) => Promise<HermesChannelHealthReport>;
  resolveHermesProfile?: (options?: { profileName?: string; hermesHome?: string }) => {
    profileName?: string;
    hermesHome: string;
    memoryMode?: string;
  };
  /** Test injection: stub the Hermes UI setup entrypoint. */
  runHermesSetup?: (signal?: AbortSignal) => Promise<HermesSetupResult>;
};

async function addHermesProfileMetadataForUiConnect(
  config: DkgConfig,
  body: Record<string, unknown>,
  deps: LocalAgentUiAttachDeps,
): Promise<Record<string, unknown>> {
  const metadata = isPlainRecord(body.metadata) ? { ...body.metadata } : {};
  const topLevelProfileName = typeof body.profileName === 'string' && body.profileName.trim()
    ? body.profileName.trim()
    : undefined;
  const topLevelHermesHome = typeof body.hermesHome === 'string' && body.hermesHome.trim()
    ? body.hermesHome.trim()
    : undefined;
  const existing = getStoredLocalAgentIntegrations(config).hermes;
  const existingMetadata = isPlainRecord(existing?.metadata) ? existing.metadata : {};
  const profileName =
    topLevelProfileName
    ?? stringMetadataValue(metadata, 'profileName')
    ?? stringMetadataValue(existingMetadata, 'profileName');
  const hermesHome =
    topLevelHermesHome
    ?? stringMetadataValue(metadata, 'hermesHome')
    ?? stringMetadataValue(existingMetadata, 'hermesHome');

  if (profileName || hermesHome) {
    return {
      ...body,
      metadata: {
        ...metadata,
        ...(profileName ? { profileName } : {}),
        ...(hermesHome ? { hermesHome } : {}),
      },
    };
  }

  const adapter = deps.resolveHermesProfile
    ? { resolveHermesProfile: deps.resolveHermesProfile }
    : await import('@origintrail-official/dkg-adapter-hermes');
  const profile = adapter.resolveHermesProfile({});
  return {
    ...body,
    metadata: {
      ...metadata,
      ...(profile.profileName ? { profileName: profile.profileName } : {}),
      hermesHome: profile.hermesHome,
      ...(profile.memoryMode ? { memoryMode: profile.memoryMode } : {}),
    },
  };
}

/**
 * CONTRACT (issue #198): This handler MUST leave ~/.openclaw/openclaw.json in a state
 * where the OpenClaw gateway, on next restart, will load the adapter from the
 * workspace build and elect it into plugins.slots.memory. The post-setup invariant
 * check enforces this before transitioning to `ready`.
 */
export async function connectLocalAgentIntegrationFromUi(
  config: DkgConfig,
  body: Record<string, unknown>,
  bridgeAuthToken: string | undefined,
  deps: LocalAgentUiAttachDeps = {},
): Promise<{ integration: LocalAgentIntegrationRecord; notice?: string }> {
  const requestedId = typeof body.id === 'string' ? normalizeIntegrationId(body.id) : '';
  const existingBeforeConnect = requestedId ? getLocalAgentIntegration(config, requestedId) : null;
  const hadStoredTransportBeforeConnect = hasStoredLocalAgentTransportConfig(existingBeforeConnect);
  const connectBody = requestedId === 'hermes'
    ? await addHermesProfileMetadataForUiConnect(config, body, deps)
    : body;
  const requested = connectLocalAgentIntegration(config, {
    ...connectBody,
    runtime: {
      status: 'connecting',
      ready: false,
      lastError: null,
    },
  });
  if (requested.id === 'hermes') {
    const probeHermesHealth = deps.probeHermesHealth ?? probeHermesChannelHealth;
    const runSetup = deps.runHermesSetup ?? runHermesUiSetup;
    const saveConfigState = deps.saveConfig;

    const health = await probeHermesHealth(config, bridgeAuthToken, { timeoutMs: 3_000 });
    if (health.ok && hadStoredTransportBeforeConnect) {
      const transport = transportPatchFromHermesTarget(config, health.target)
        ?? (health.target === 'gateway'
          ? { kind: 'hermes-openai', gatewayUrl: DEFAULT_HERMES_API_SERVER_URL }
          : undefined);
      const integration = updateLocalAgentIntegration(config, requested.id, {
        transport,
        runtime: {
          status: 'ready',
          ready: true,
          lastError: null,
        },
      });
      return {
        integration,
        notice: `${integration.name} is connected and chat-ready.`,
      };
    }

    const persistHermesIntegrationState = async (patch: Record<string, unknown>): Promise<LocalAgentIntegrationRecord | null> => {
      const current = getLocalAgentIntegration(config, requested.id);
      if (current?.enabled === false && patch.enabled !== false) {
        return null;
      }
      const integration = updateLocalAgentIntegration(config, requested.id, patch);
      if (saveConfigState) {
        await saveConfigState(config);
      }
      return integration;
    };

    const { started } = scheduleAttachJob(requested.id, async (attachJob: PendingAttachJob) => {
      try {
        const result = await runSetup(attachJob.controller.signal);
        if (isAttachJobCancelled(attachJob)) return;

        // setup-entrypoint-contract.md §3: result.transport is non-optional and
        // already matches the LocalAgentIntegrationTransport patch shape, so we
        // lift it straight rather than calling transportPatchFromHermesTarget.
        // Provider-swap audit (§3) goes onto record.metadata so disconnect/restore
        // and the UI's hermesDetail formatter can both reach it.
        const metadataPatch = result.providerSwap
          ? {
              priorProvider: result.providerSwap.previousProvider,
              backupPath: result.providerSwap.backupPath,
            }
          : undefined;

        if (!result.ok || result.status === 'error') {
          await persistHermesIntegrationState({
            ...(metadataPatch ? { metadata: metadataPatch } : {}),
            runtime: {
              status: 'error',
              ready: false,
              lastError: result.errors[0] ?? 'Hermes setup failed',
            },
          });
          return;
        }

        if (result.status === 'degraded') {
          await persistHermesIntegrationState({
            transport: result.transport,
            ...(metadataPatch ? { metadata: metadataPatch } : {}),
            runtime: {
              status: 'degraded',
              ready: false,
              lastError: result.warnings[0] ?? null,
            },
          });
          return;
        }

        await persistHermesIntegrationState({
          transport: result.transport,
          ...(metadataPatch ? { metadata: metadataPatch } : {}),
          runtime: {
            status: 'ready',
            ready: true,
            lastError: null,
          },
        });
      } catch (err: any) {
        if (isAttachJobCancelled(attachJob)) return;
        await persistHermesIntegrationState({
          enabled: hadStoredTransportBeforeConnect ? true : false,
          ...(hadStoredTransportBeforeConnect && existingBeforeConnect?.transport
            ? { transport: existingBeforeConnect.transport }
            : {}),
          runtime: {
            status: 'error',
            ready: false,
            lastError: err?.message ?? 'Hermes attach failed',
          },
        });
      }
    }, deps.onAttachScheduled);

    const integration = updateLocalAgentIntegration(config, requested.id, {
      runtime: {
        status: 'connecting',
        ready: false,
        lastError: null,
      },
    });
    return {
      integration,
      notice: started
        ? 'Hermes setup started. This chat tab will come online automatically once Hermes finishes setting up.'
        : 'Hermes setup is already in progress. This chat tab will come online automatically once Hermes finishes setting up.',
    };
  }

  if (requested.id !== 'openclaw') {
    return {
      integration: requested,
      notice: `${requested.name} was registered. Chat will appear here once its framework bridge is available.`,
    };
  }

  const probeHealth = deps.probeHealth ?? probeOpenClawChannelHealth;
  const waitForReady = deps.waitForReady ?? waitForOpenClawChatReady;
  const runSetup = deps.runSetup ?? runOpenClawUiSetup;
  const restartGateway = deps.restartGateway ?? restartOpenClawGateway;
  const verifyMemorySlot = deps.verifyMemorySlot ?? isOpenClawMemorySlotElected;
  const saveConfigState = deps.saveConfig;

  let health = await probeHealth(config, bridgeAuthToken, { ignoreBridgeCache: true });
  if (health.ok && hadStoredTransportBeforeConnect) {
    const integration = updateLocalAgentIntegration(config, requested.id, {
      transport: transportPatchFromOpenClawTarget(config, health.target),
      runtime: {
        status: 'ready',
        ready: true,
        lastError: null,
      },
    });
    return {
      integration,
      notice: `${integration.name} is connected and chat-ready.`,
    };
  }

  const persistIntegrationState = async (patch: Record<string, unknown>): Promise<LocalAgentIntegrationRecord | null> => {
    const current = getLocalAgentIntegration(config, requested.id);
    if (current?.enabled === false && patch.enabled !== false) {
      return null;
    }
    const integration = updateLocalAgentIntegration(config, requested.id, patch);
    if (saveConfigState) {
      await saveConfigState(config);
    }
    return integration;
  };

  const { started } = scheduleOpenClawUiAttachJob(requested.id, async (attachJob) => {
    try {
      daemonState.openClawBridgeHealth = null;
      await runSetup(attachJob.controller.signal);
      if (isOpenClawUiAttachCancelled(attachJob)) return;
      daemonState.openClawBridgeHealth = null;

      if (!verifyMemorySlot()) {
        await persistIntegrationState({
          runtime: {
            status: 'error',
            ready: false,
            lastError: 'OpenClaw memory slot election failed after setup — adapter-openclaw not elected to plugins.slots.memory',
          },
        });
        return;
      }

      let latest = await probeHealth(config, bridgeAuthToken, {
        ignoreBridgeCache: true,
        timeoutMs: 3_000,
      });
      if (isOpenClawUiAttachCancelled(attachJob)) return;
      if (!latest.ok) {
        await restartGateway(attachJob.controller.signal);
        if (isOpenClawUiAttachCancelled(attachJob)) return;
        daemonState.openClawBridgeHealth = null;
        latest = await waitForReady(config, bridgeAuthToken, attachJob.controller.signal);
      }
      if (isOpenClawUiAttachCancelled(attachJob)) return;

      if (latest.ok) {
        await persistIntegrationState({
          transport: transportPatchFromOpenClawTarget(config, latest.target),
          runtime: {
            status: 'ready',
            ready: true,
            lastError: null,
          },
        });
        return;
      }

      await persistIntegrationState({
        transport: transportPatchFromOpenClawTarget(config, latest.target),
        runtime: {
          status: 'connecting',
          ready: false,
          lastError: latest.error ?? null,
        },
      });
    } catch (err: any) {
      if (isOpenClawUiAttachCancelled(attachJob)) {
        return;
      }
      await persistIntegrationState({
        enabled: hadStoredTransportBeforeConnect ? true : false,
        ...(hadStoredTransportBeforeConnect && existingBeforeConnect?.transport
          ? { transport: existingBeforeConnect.transport }
          : {}),
        runtime: {
          status: 'error',
          ready: false,
          lastError: formatOpenClawUiAttachFailure(err),
        },
      });
    } finally {
      daemonState.openClawBridgeHealth = null;
    }
  }, deps.onAttachScheduled);

  const integration = updateLocalAgentIntegration(config, requested.id, {
    runtime: {
      status: 'connecting',
      ready: false,
      lastError: null,
    },
  });
  return {
    integration,
    notice: started
      ? 'OpenClaw attach started. This chat tab will come online automatically once OpenClaw finishes reloading.'
      : 'OpenClaw attach is already in progress. This chat tab will come online automatically once OpenClaw finishes reloading.',
  };
}

/**
 * CONTRACT (issue #198 / D1 reverse-setup): This helper MUST leave
 * ~/.openclaw/openclaw.json in a state where `plugins.slots.memory !==
 * "adapter-openclaw"` and the adapter load path is no longer listed.
 * If the reverse-merge completes but the invariant is still violated,
 * callers must surface runtime.status='error' and NOT transition to
 * 'disconnected'. The adapter's `unmergeOpenClawConfig` is symmetric to
 * `mergeOpenClawConfig` and writes a `.bak.<ts>` backup.
 */
export type ReverseLocalAgentSetupDeps = {
  unmergeOpenClawConfig?: (configPath: string) => unknown;
  verifyUnmergeInvariants?: (configPath: string) => string | null;
  removeCanonicalNodeSkill?: (workspaceDir: string) => void;
  verifySkillRemoved?: (installedWorkspace: string) => string | null;
};

export type HermesRestoreOutcome = {
  ok: boolean;
  path: 'surgical' | 'backup-file' | 'noop' | 'failed';
  restoreError?: string;
};

export type ReverseHermesSetupDeps = {
  disconnectHermesProfile?: (options: { profileName?: string; hermesHome?: string }) => unknown;
  /**
   * Attempt to restore the prior `memory.provider` after disconnect. Per
   * setup-entrypoint-contract.md §6, restore failure does NOT roll back the
   * disconnect — it surfaces as a warning while `runtime.status` stays
   * `'disconnected'`. S4 step 3 will land the real `restoreHermesProfile` in
   * `@origintrail-official/dkg-adapter-hermes`; until then the dynamic-import
   * fallback returns a `'noop'` outcome so the wiring is exercise-able now
   * and the swap is a one-line change when S4 ships.
   */
  restoreHermesProfile?: (options: { profileName?: string; hermesHome?: string }) => Promise<HermesRestoreOutcome>;
};

function stringMetadataValue(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export async function reverseHermesSetupForUi(
  config: DkgConfig,
  deps: ReverseHermesSetupDeps = {},
): Promise<{ restoreError?: string }> {
  const stored = getStoredLocalAgentIntegrations(config).hermes;
  const metadata = isPlainRecord(stored?.metadata) ? stored.metadata : {};
  const options = {
    profileName: stringMetadataValue(metadata, 'profileName'),
    hermesHome: stringMetadataValue(metadata, 'hermesHome'),
  };
  if (!options.profileName && !options.hermesHome) {
    throw new Error('Hermes profile metadata is missing; run dkg hermes disconnect for the target profile.');
  }

  // Disconnect first — removes the managed memory.provider block + sets state
  // to disconnected. Throwing here is fatal; the PUT handler will surface as
  // runtime.status: 'error'.
  const adapter = deps.disconnectHermesProfile
    ? { disconnectHermesProfile: deps.disconnectHermesProfile }
    : await import('@origintrail-official/dkg-adapter-hermes');
  await adapter.disconnectHermesProfile(options);

  // Restore second — puts the captured prior provider back. Per
  // setup-entrypoint-contract.md §6, restore failure does NOT roll back the
  // disconnect: integration stays `disconnected`, restoreError surfaces as a
  // `runtime.lastError` warning. The PUT handler honors this by reading
  // `restoreError` off the return value rather than catching a throw.
  type RestoreFn = NonNullable<ReverseHermesSetupDeps['restoreHermesProfile']>;
  const noopRestore: RestoreFn = async () => ({ ok: true, path: 'noop' });
  let restoreFn: RestoreFn;
  if (deps.restoreHermesProfile) {
    restoreFn = deps.restoreHermesProfile;
  } else {
    // S4 step 3 will land the real `restoreHermesProfile` export. Until then,
    // feature-detect: if exported, use it; otherwise no-op (no provider was
    // captured pre-S4 anyway, so 'noop' is the truthful outcome). The
    // try/catch defends against test mocks that spread-replace the adapter
    // module without re-exporting every property.
    try {
      const adapterModule = await import('@origintrail-official/dkg-adapter-hermes') as Record<string, unknown>;
      const candidate = adapterModule.restoreHermesProfile;
      restoreFn = typeof candidate === 'function' ? (candidate as RestoreFn) : noopRestore;
    } catch {
      restoreFn = noopRestore;
    }
  }

  try {
    const outcome = await restoreFn(options);
    return outcome.ok ? {} : { restoreError: outcome.restoreError ?? 'Hermes provider restore failed' };
  } catch (err: any) {
    return { restoreError: err?.message ?? 'Hermes provider restore failed' };
  }
}

export async function reverseLocalAgentSetupForUi(
  _config: DkgConfig,
  openclawConfigPath?: string,
  deps: ReverseLocalAgentSetupDeps = {},
): Promise<void> {
  const resolvedPath = openclawConfigPath && openclawConfigPath.trim()
    ? openclawConfigPath
    : localOpenclawConfigPath();

  // Defer to the adapter for every helper we need so install (setup) and
  // removal (Disconnect) agree on the same primitives. Codex R1-1 shared
  // the workspace resolver; R2-1/R2-2 persisted the authoritative install
  // path on `entry.config.installedWorkspace`; R3-2 now reorders so the skill
  // cleanup runs BEFORE the config-level unmerge — a failed cleanup leaves
  // both `entry.config.installedWorkspace` AND the openclaw.json wiring intact,
  // so the user can retry Disconnect and we still know where to look.
  const adapter = (
    deps.unmergeOpenClawConfig
    && deps.verifyUnmergeInvariants
    && deps.removeCanonicalNodeSkill
    && deps.verifySkillRemoved
  )
    ? {
        unmergeOpenClawConfig: deps.unmergeOpenClawConfig,
        verifyUnmergeInvariants: deps.verifyUnmergeInvariants,
        removeCanonicalNodeSkill: deps.removeCanonicalNodeSkill,
        verifySkillRemoved: deps.verifySkillRemoved,
      }
    : await import('@origintrail-official/dkg-adapter-openclaw');
  const unmergeOpenClawConfig = deps.unmergeOpenClawConfig ?? adapter.unmergeOpenClawConfig;
  const verifyUnmergeInvariants = deps.verifyUnmergeInvariants ?? adapter.verifyUnmergeInvariants;
  const removeCanonicalNodeSkill = deps.removeCanonicalNodeSkill ?? adapter.removeCanonicalNodeSkill;
  const verifySkillRemoved = deps.verifySkillRemoved ?? adapter.verifySkillRemoved;

  // Step 1 — discover the workspace to clean up, reading openclaw.json once.
  // Authoritative source is `plugins.entries['adapter-openclaw'].config.installedWorkspace`
  // persisted at merge time (R2-1, hotfixed to live inside `entry.config`
  // because OpenClaw's gateway schema strict-rejects unknown keys at the
  // entry root). No legacy fallback via `resolveWorkspaceDirFromConfig`:
  // pre-R2 configs don't exist outside local testing, and the config-
  // derived workspace isn't guaranteed to be where an earlier
  // `--workspace`-overridden install actually put SKILL.md (R11-2 decline
  // of destructive best-guess). A missing pointer simply means no skill
  // cleanup runs — the config unmerge below still completes.
  let workspaceDir: string | null = null;
  if (existsSync(resolvedPath)) {
    try {
      const raw = JSON.parse(readFileSync(resolvedPath, 'utf-8'));
      const entry = raw?.plugins?.entries?.['adapter-openclaw'];
      if (entry && typeof entry === 'object') {
        const installedFromConfig = typeof entry.config?.installedWorkspace === 'string'
          && entry.config.installedWorkspace.trim()
          ? entry.config.installedWorkspace.trim()
          : undefined;
        if (installedFromConfig) {
          workspaceDir = installedFromConfig;
        }
      }
      // else: entry already absent → workspaceDir stays null → skill cleanup
      // is skipped. The config-level unmerge below is a no-op in that case.
    } catch {
      // Unparseable openclaw.json — leave null. The config-level unmerge
      // below short-circuits on the same condition and no skill file path
      // is recoverable, so skill cleanup is implicitly skipped too.
    }
  }

  // Step 2 — retire the adapter-owned SKILL.md BEFORE touching the config.
  // Failures here throw out of the function; the outer PUT handler surfaces
  // them as `runtime.lastError`. Because the config is untouched,
  // `entry.config.installedWorkspace` is still on disk, so a retry re-enters this
  // same branch with the same workspace target (R3-2).
  if (workspaceDir) {
    removeCanonicalNodeSkill(workspaceDir);
    const skillFailure = verifySkillRemoved(workspaceDir);
    if (skillFailure) {
      throw new Error(skillFailure);
    }
  }

  // Step 3 — now commit to the config-level unmerge. Safe to do after the
  // skill has been retired because the config no longer carries an authority
  // pointer to a file we haven't cleaned up.
  unmergeOpenClawConfig(resolvedPath);
  const failure = verifyUnmergeInvariants(resolvedPath);
  if (failure) {
    throw new Error(failure);
  }
}

export async function refreshLocalAgentIntegrationFromUi(
  config: DkgConfig,
  id: string,
  bridgeAuthToken: string | undefined,
): Promise<LocalAgentIntegrationRecord> {
  const normalizedId = normalizeIntegrationId(id);
  const existing = getLocalAgentIntegration(config, normalizedId);
  if (!existing) {
    throw new Error(`Unknown integration: ${id}`);
  }
  if (normalizedId !== 'openclaw') {
    if (normalizedId === 'hermes') {
      const health = await probeHermesChannelHealth(config, bridgeAuthToken, {
        timeoutMs: 3_000,
      });

      if (health.ok) {
        const transport = transportPatchFromHermesTarget(config, health.target)
          ?? (health.target === 'gateway'
            ? { kind: 'hermes-openai', gatewayUrl: DEFAULT_HERMES_API_SERVER_URL }
            : undefined);
        return updateLocalAgentIntegration(config, normalizedId, {
          transport,
          runtime: {
            status: 'ready',
            ready: true,
            lastError: null,
          },
        });
      }

      return updateLocalAgentIntegration(config, normalizedId, {
        runtime: {
          status: 'degraded',
          ready: false,
          lastError: health.error ?? 'Hermes bridge offline',
        },
      });
    }

    return existing;
  }

  daemonState.openClawBridgeHealth = null;
  const health = await probeOpenClawChannelHealth(config, bridgeAuthToken, {
    ignoreBridgeCache: true,
    timeoutMs: 3_000,
  });

  if (health.ok) {
    return updateLocalAgentIntegration(config, normalizedId, {
      transport: transportPatchFromOpenClawTarget(config, health.target),
      runtime: {
        status: 'ready',
        ready: true,
        lastError: null,
      },
    });
  }

  return updateLocalAgentIntegration(config, normalizedId, {
    runtime: {
      status: 'error',
      ready: false,
      lastError: health.error ?? 'OpenClaw bridge offline',
    },
  });
}
