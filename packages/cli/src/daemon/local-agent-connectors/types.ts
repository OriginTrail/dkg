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

/** Uniform handle returned by every connector-owned background attach. */
export interface LocalAgentAttachJobHandle {
  readonly started: boolean;
  readonly job: Promise<void>;
  readonly controller: AbortController;
}

export interface LocalAgentAfterCommitResult {
  readonly notice?: string;
  readonly attachJob?: LocalAgentAttachJobHandle;
}

interface LocalAgentConnectPlanBase<State> {
  /**
   * Desired initial integration state for this connect. Connectors return only
   * the attach-owned fields they decided (transport/runtime); the connect
   * planner layers them over the normalized registration so the route commits
   * one patch through one reducer against the latest configuration snapshot.
   */
  state: State;
  notice?: string;
  /** Deferred setup work that runs only after `state` is committed. */
  afterCommit?: (sink: LocalAgentAttachStateSink) => LocalAgentAfterCommitResult;
}

export type LocalAgentConnectPlan =
  | (LocalAgentConnectPlanBase<LocalAgentIntegrationConfig> & { ok: true })
  | (LocalAgentConnectPlanBase<LocalAgentIntegrationConfig> & { ok: false; error: string });

/** Connector-owned plan before the registration fields are layered on top. */
export type LocalAgentConnectorPlan =
  | (LocalAgentConnectPlanBase<LocalAgentAttachStatePatch> & { ok: true })
  | (LocalAgentConnectPlanBase<LocalAgentAttachStatePatch> & { ok: false; error: string });

export interface LocalAgentConnectorContext {
  config: ImmutableDkgConfig;
  body: Record<string, unknown>;
  bridgeAuthToken: string | undefined;
  requested: { id: string; name: string };
  existingBeforeConnect: LocalAgentIntegrationConfig | null;
  hadStoredTransportBeforeConnect: boolean;
}

/** Live re-probe of an already-registered integration. Never runs setup. */
export interface LocalAgentRefreshContext {
  config: ImmutableDkgConfig;
  id: string;
  bridgeAuthToken: string | undefined;
}

export interface LocalAgentRefreshPlan {
  patch: LocalAgentAttachStatePatch;
}

export interface LocalAgentDisconnectContext {
  config: ImmutableDkgConfig;
  id: string;
  state: Record<string, unknown>;
}

export interface LocalAgentDisconnectPlan {
  state: Record<string, unknown>;
}

export interface LocalAgentConnectorStrategy {
  prepareBody?: (
    config: ImmutableDkgConfig,
    body: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  createPlan: (context: LocalAgentConnectorContext) => Promise<LocalAgentConnectorPlan>;
  createRefreshPlan: (context: LocalAgentRefreshContext) => Promise<LocalAgentRefreshPlan>;
  cancelPending: (id: string) => void | Promise<void>;
  createDisconnectPlan: (
    context: LocalAgentDisconnectContext,
  ) => Promise<LocalAgentDisconnectPlan>;
}
