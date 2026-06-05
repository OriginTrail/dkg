import type { AgentIdentity, LocalAgentChatContextEntry } from '../../../api.js';
import type { ContextGraph } from '../../../stores/projects.js';
import { getProjectDisplayName, toContextGraphUri } from './format.js';

export function buildChatContextEntries(
  projects: ContextGraph[],
  activeProjectId: string | null,
  currentAgent: AgentIdentity | null,
): LocalAgentChatContextEntry[] {
  const entries: LocalAgentChatContextEntry[] = [];
  if (activeProjectId) {
    const displayName = getProjectDisplayName(projects, activeProjectId);
    entries.push({
      key: 'target_context_graph',
      label: 'Target context graph id',
      value: activeProjectId,
    });
    entries.push({
      key: 'target_context_graph_uri',
      label: 'Target context graph URI',
      value: toContextGraphUri(activeProjectId),
    });
    entries.push({
      key: 'target_context_graph_name',
      label: 'Target context graph name',
      value: displayName,
    });
  }
  if (currentAgent?.agentAddress) {
    entries.push({
      key: 'current_agent_address',
      label: 'Current agent address',
      value: currentAgent.agentAddress,
    });
  }
  if (currentAgent?.agentDid) {
    entries.push({
      key: 'current_agent_did',
      label: 'Current agent DID',
      value: currentAgent.agentDid,
    });
  }
  if (currentAgent?.peerId) {
    entries.push({
      key: 'current_agent_peer_id',
      label: 'Current agent peer ID',
      value: currentAgent.peerId,
    });
  }
  return entries;
}

