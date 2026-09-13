import type { HermesSetupResult } from '@origintrail-official/dkg-adapter-hermes';
import type { ImmutableDkgConfig } from '../../config-snapshot.js';
import type { LocalAgentIntegrationConfig } from '../../config.js';
import type { HermesChannelHealthReport } from '../hermes.js';
import type {
  LocalAgentAttachStatePatch,
  OpenClawUiAttachDeps,
} from '../openclaw.js';

export type LocalAgentUiAttachDeps = OpenClawUiAttachDeps & {
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
  runPrimeAgentSetup?: () => Promise<{ ok: boolean; errors: string[]; warnings: string[] }>;
};

export interface LocalAgentAttachStateSink {
  current: () => ImmutableDkgConfig;
  persist: (patch: LocalAgentAttachStatePatch) => Promise<void>;
}

interface LocalAgentConnectPlanBase {
  registration: LocalAgentIntegrationConfig;
  initialPatch: LocalAgentAttachStatePatch;
  notice?: string;
  afterCommit?: (sink: LocalAgentAttachStateSink) => string | undefined;
}

export type LocalAgentConnectPlan =
  | (LocalAgentConnectPlanBase & { ok: true })
  | (LocalAgentConnectPlanBase & { ok: false; error: string });

export interface LocalAgentConnectorContext {
  config: ImmutableDkgConfig;
  body: Record<string, unknown>;
  bridgeAuthToken: string | undefined;
  deps: LocalAgentUiAttachDeps;
  requested: { id: string; name: string };
  registration: LocalAgentIntegrationConfig;
  existingBeforeConnect: LocalAgentIntegrationConfig | null;
  hadStoredTransportBeforeConnect: boolean;
}

export interface LocalAgentConnectorStrategy {
  prepareBody?: (
    config: ImmutableDkgConfig,
    body: Record<string, unknown>,
    deps: LocalAgentUiAttachDeps,
  ) => Promise<Record<string, unknown>>;
  createPlan: (context: LocalAgentConnectorContext) => Promise<LocalAgentConnectPlan>;
}
