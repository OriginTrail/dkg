import { hermesConnector } from './hermes.js';
import { openClawConnector } from './openclaw.js';
import { primeAgentConnector } from './prime-agent.js';
import type { LocalAgentConnectorStrategy } from './types.js';

const CONNECTORS: Readonly<Record<string, LocalAgentConnectorStrategy>> = {
  hermes: hermesConnector,
  openclaw: openClawConnector,
  'prime-agent': primeAgentConnector,
};

export function localAgentConnectorFor(id: string): LocalAgentConnectorStrategy | undefined {
  return CONNECTORS[id];
}

export type {
  LocalAgentAttachStateSink,
  LocalAgentConnectPlan,
  LocalAgentConnectorContext,
  LocalAgentConnectorStrategy,
  LocalAgentUiAttachDeps,
} from './types.js';
