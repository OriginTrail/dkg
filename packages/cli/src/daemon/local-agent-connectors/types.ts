import type { ImmutableDkgConfig } from '../../config-snapshot.js';
import type { LocalAgentIntegrationConfig } from '../../config.js';

export type LocalAgentAttachStatePatch = Partial<Pick<
  LocalAgentIntegrationConfig,
  'enabled' | 'transport' | 'runtime' | 'metadata'
>>;

export interface LocalAgentAttachStateSink {
  current: () => ImmutableDkgConfig;
  persist: (patch: LocalAgentAttachStatePatch) => Promise<void>;
}

interface LocalAgentConnectPlanBase {
  /**
   * Desired initial integration state for this connect. Connectors return only
   * the attach-owned fields they decided (transport/runtime); the connect
   * planner layers them over the normalized registration so the route commits
   * one patch through one reducer against the latest configuration snapshot.
   */
  state: LocalAgentIntegrationConfig;
  notice?: string;
  /** Deferred setup work that runs only after `state` is committed. */
  afterCommit?: (sink: LocalAgentAttachStateSink) => string | undefined;
}

export type LocalAgentConnectPlan =
  | (LocalAgentConnectPlanBase & { ok: true })
  | (LocalAgentConnectPlanBase & { ok: false; error: string });

export interface LocalAgentConnectorContext {
  config: ImmutableDkgConfig;
  body: Record<string, unknown>;
  bridgeAuthToken: string | undefined;
  requested: { id: string; name: string };
  existingBeforeConnect: LocalAgentIntegrationConfig | null;
  hadStoredTransportBeforeConnect: boolean;
}

export interface LocalAgentConnectorStrategy {
  prepareBody?: (
    config: ImmutableDkgConfig,
    body: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  createPlan: (context: LocalAgentConnectorContext) => Promise<LocalAgentConnectPlan>;
}
