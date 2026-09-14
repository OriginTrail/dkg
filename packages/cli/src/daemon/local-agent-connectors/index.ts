import { createHermesConnector, type HermesConnectorDeps } from './hermes.js';
import { createOpenClawConnector, type OpenClawConnectorDeps } from './openclaw.js';
import { createPrimeAgentConnector, type PrimeAgentConnectorDeps } from './prime-agent.js';
import { createGenericConnector } from './generic.js';
import type { LocalAgentConnectorKind, LocalAgentConnectorStrategy } from './types.js';

export type LocalAgentUiAttachDeps = OpenClawConnectorDeps
  & HermesConnectorDeps
  & PrimeAgentConnectorDeps;

export function localAgentConnectorFor(
  kind: LocalAgentConnectorKind,
  deps: LocalAgentUiAttachDeps = {},
): LocalAgentConnectorStrategy {
  switch (kind) {
    case 'generic': return createGenericConnector();
    case 'hermes': return createHermesConnector(deps);
    case 'openclaw': return createOpenClawConnector(deps);
    case 'prime-agent': return createPrimeAgentConnector(deps);
    default: throw new TypeError(`Unknown local-agent connector kind: ${String(kind)}`);
  }
}

export type {
  LocalAgentAttachStateSink,
  LocalAgentAttachStatePatch,
  LocalAgentAttachJobHandle,
  LocalAgentAfterCommitResult,
  LocalAgentConnectPlan,
  LocalAgentConnectorPlan,
  LocalAgentConnectorContext,
  LocalAgentRefreshContext,
  LocalAgentRefreshPlan,
  LocalAgentDisconnectContext,
  LocalAgentDisconnectPlan,
  LocalAgentConnectorStrategy,
  LocalAgentConnectorKind,
} from './types.js';
