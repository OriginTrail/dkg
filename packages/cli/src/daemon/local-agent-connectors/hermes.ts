import {
  DEFAULT_HERMES_API_SERVER_URL,
  probeHermesChannelHealth,
  runHermesUiSetup,
  transportPatchFromHermesTarget,
} from '../hermes.js';
import {
  cancelPending,
  isCancelled,
  scheduleAttachJob,
} from '../local-agent-attach-jobs.js';
import type { HermesSetupResult } from '@origintrail-official/dkg-adapter-hermes';
import type { ImmutableDkgConfig } from '../../config-snapshot.js';
import type { HermesChannelHealthReport } from '../hermes.js';
import type {
  LocalAgentConnectorStrategy,
} from './types.js';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringMetadataValue(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export interface HermesConnectorDeps {
  probeHermesHealth?: (
    config: Pick<ImmutableDkgConfig, 'localAgentIntegrations'>,
    bridgeAuthToken: string | undefined,
    opts?: { timeoutMs?: number },
  ) => Promise<HermesChannelHealthReport>;
  resolveHermesProfile?: (options?: { profileName?: string; hermesHome?: string }) => {
    profileName?: string;
    hermesHome: string;
    memoryMode?: string;
  };
  runHermesSetup?: (signal?: AbortSignal) => Promise<HermesSetupResult>;
  onAttachScheduled?: (id: string, job: Promise<void>) => void;
}

export function createHermesConnector(deps: HermesConnectorDeps = {}): LocalAgentConnectorStrategy {
  const prepareBody: NonNullable<LocalAgentConnectorStrategy['prepareBody']> = async (config, body) => {
    const metadata = isPlainRecord(body.metadata) ? { ...body.metadata } : {};
    const existingMetadata = isPlainRecord(config.localAgentIntegrations?.hermes?.metadata)
      ? config.localAgentIntegrations.hermes.metadata
      : {};
    const profileName = (
      typeof body.profileName === 'string' && body.profileName.trim()
        ? body.profileName.trim()
        : undefined
    ) ?? stringMetadataValue(metadata, 'profileName')
      ?? stringMetadataValue(existingMetadata, 'profileName');
    const hermesHome = (
      typeof body.hermesHome === 'string' && body.hermesHome.trim()
        ? body.hermesHome.trim()
        : undefined
    ) ?? stringMetadataValue(metadata, 'hermesHome')
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
  };

  const createPlan: LocalAgentConnectorStrategy['createPlan'] = async (context) => {
    const {
      config,
      requested,
      bridgeAuthToken,
      existingBeforeConnect,
      hadStoredTransportBeforeConnect,
    } = context;
    const probeHealth = deps.probeHermesHealth ?? probeHermesChannelHealth;
    const runSetup = deps.runHermesSetup ?? runHermesUiSetup;

    const health = await probeHealth(config, bridgeAuthToken, { timeoutMs: 3_000 });
    if (health.ok && hadStoredTransportBeforeConnect) {
      const transport = transportPatchFromHermesTarget(config, health.target)
        ?? (health.target === 'gateway'
          ? { kind: 'hermes-openai' as const, gatewayUrl: DEFAULT_HERMES_API_SERVER_URL }
          : undefined);
      return {
        ok: true,
        state: {
          transport,
          runtime: { status: 'ready', ready: true, lastError: null },
        },
        notice: `${requested.name} is connected and chat-ready.`,
      };
    }

    // Setup is deferred: the registration's `connecting` runtime stands until
    // the attach job persists its result.
    return {
      ok: true,
      state: {},
      afterCommit: (sink) => {
        const attachJob = scheduleAttachJob(requested.id, async (attachJob) => {
          try {
            const result = await runSetup(attachJob.controller.signal);
            if (isCancelled(attachJob)) return;
            const metadataPatch = result.providerSwap
              ? {
                  priorProvider: result.providerSwap.previousProvider,
                  backupPath: result.providerSwap.backupPath,
                }
              : undefined;

            if (!result.ok || result.status === 'error') {
              await sink.persist({
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
              await sink.persist({
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
            await sink.persist({
              transport: result.transport,
              ...(metadataPatch ? { metadata: metadataPatch } : {}),
              runtime: { status: 'ready', ready: true, lastError: null },
            });
          } catch (err: unknown) {
            if (isCancelled(attachJob)) return;
            await sink.persist({
              enabled: hadStoredTransportBeforeConnect ? true : false,
              ...(hadStoredTransportBeforeConnect && existingBeforeConnect?.transport
                ? { transport: existingBeforeConnect.transport }
                : {}),
              runtime: {
                status: 'error',
                ready: false,
                lastError: err instanceof Error ? err.message : 'Hermes attach failed',
              },
            });
          }
        }, deps.onAttachScheduled);
        return {
          attachJob,
          notice: attachJob.started
            ? 'Hermes setup started. This chat tab will come online automatically once Hermes finishes setting up.'
            : 'Hermes setup is already in progress. This chat tab will come online automatically once Hermes finishes setting up.',
        };
      },
    };
  };
  const createRefreshPlan: LocalAgentConnectorStrategy['createRefreshPlan'] = async ({
    config,
    bridgeAuthToken,
  }) => {
    const health = await probeHermesChannelHealth(config, bridgeAuthToken, { timeoutMs: 3_000 });
    if (health.ok) {
      const transport = transportPatchFromHermesTarget(config, health.target)
        ?? (health.target === 'gateway'
          ? { kind: 'hermes-openai' as const, gatewayUrl: DEFAULT_HERMES_API_SERVER_URL }
          : undefined);
      return {
        patch: {
          transport,
          runtime: { status: 'ready', ready: true, lastError: null },
        },
      };
    }
    return {
      patch: {
        runtime: {
          status: 'degraded',
          ready: false,
          lastError: health.error ?? 'Hermes bridge offline',
        },
      },
    };
  };
  const createDisconnectPlan: LocalAgentConnectorStrategy['createDisconnectPlan'] = async ({ config, state }) => {
    try {
      const { reverseHermesSetupForUi } = await import('../local-agents.js');
      const result = await reverseHermesSetupForUi(config);
      if (!result.restoreError) return { state };
      const runtime = isPlainRecord(state.runtime) ? state.runtime : {};
      return {
        state: {
          ...state,
          runtime: {
            ...runtime,
            status: 'disconnected',
            ready: false,
            lastError: result.restoreError,
          },
        },
      };
    } catch (err: unknown) {
      return {
        state: {
          runtime: {
            status: 'error',
            ready: false,
            lastError: `Hermes disconnect failed: ${err instanceof Error ? err.message : 'unknown error'}`,
          },
        },
      };
    }
  };
  return { prepareBody, createPlan, createRefreshPlan, cancelPending, createDisconnectPlan };
}
