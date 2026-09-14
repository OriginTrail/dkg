import { createHermesConnector, type HermesConnectorDeps } from './hermes.js';
import { createOpenClawConnector, type OpenClawConnectorDeps } from './openclaw.js';
import { createPrimeAgentConnector, type PrimeAgentConnectorDeps } from './prime-agent.js';
import type { LocalAgentConnectorStrategy } from './types.js';

export type LocalAgentUiAttachDeps = OpenClawConnectorDeps
  & HermesConnectorDeps
  & PrimeAgentConnectorDeps;

export function localAgentConnectorFor(
  id: string,
  deps: LocalAgentUiAttachDeps = {},
): LocalAgentConnectorStrategy | undefined {
  if (id === 'hermes') return createHermesConnector(deps);
  if (id === 'openclaw') return createOpenClawConnector(deps);
  if (id === 'prime-agent') return createPrimeAgentConnector(deps);
  return undefined;
}

export type {
  LocalAgentAttachStateSink,
  LocalAgentAttachStatePatch,
  LocalAgentConnectPlan,
  LocalAgentConnectorPlan,
  LocalAgentConnectorContext,
  LocalAgentConnectorStrategy,
} from './types.js';
