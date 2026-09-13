import {
  DEFAULT_HERMES_API_SERVER_URL,
  probeHermesChannelHealth,
  runHermesUiSetup,
  transportPatchFromHermesTarget,
} from '../hermes.js';
import {
  isCancelled,
  scheduleAttachJob,
} from '../local-agent-attach-jobs.js';
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

export const hermesConnector: LocalAgentConnectorStrategy = {
  async prepareBody(config, body, deps) {
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
  },

  async createPlan(context) {
    const {
      config,
      requested,
      registration,
      bridgeAuthToken,
      deps,
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
        registration,
        initialPatch: {
          transport,
          runtime: { status: 'ready', ready: true, lastError: null },
        },
        notice: `${requested.name} is connected and chat-ready.`,
      };
    }

    return {
      ok: true,
      registration,
      initialPatch: {
        runtime: { status: 'connecting', ready: false, lastError: null },
      },
      afterCommit: (sink) => {
        const { started } = scheduleAttachJob(requested.id, async (attachJob) => {
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
        return started
          ? 'Hermes setup started. This chat tab will come online automatically once Hermes finishes setting up.'
          : 'Hermes setup is already in progress. This chat tab will come online automatically once Hermes finishes setting up.';
      },
    };
  },
};
