/**
 * Agent discovery & peer messaging tool definitions for {@link DkgNodePlugin}.
 *
 * Moved verbatim out of `DkgNodePlugin.tools()` — same metadata and handler
 * delegation, only relocated. The `execute` callbacks forward to the host's
 * `handle*` methods (see {@link DkgToolHost}). No behavior change.
 */
import type { OpenClawTool } from '../types.js';
import { FIND_AGENTS_TOOL_SCHEMA_PROPERTIES } from '../agent-list.js';
import type { DkgToolHost } from './tool-host.js';

/** The boundary's schema descriptor, shaped for the OpenClawTool parameter type. */
function findAgentsSchemaProperties(): Record<string, { type: string; description?: string; enum?: string[]; minimum?: number }> {
  const properties: Record<string, { type: string; description?: string; enum?: string[]; minimum?: number }> = {};
  for (const [key, spec] of Object.entries(FIND_AGENTS_TOOL_SCHEMA_PROPERTIES)) {
    properties[key] = { type: spec.type, description: spec.description };
    if ('enum' in spec && spec.enum) properties[key].enum = [...spec.enum];
    if ('minimum' in spec && spec.minimum !== undefined) properties[key].minimum = spec.minimum;
  }
  return properties;
}

export function buildMessagingTools(ctx: DkgToolHost): OpenClawTool[] {
  return [
    {
      name: 'dkg_find_agents',
      description:
        'List DKG agents known to this node — combines the local registry (this node + cached peers from the ' +
        'identity layer) with live P2P connection status. Works offline: returns locally-known agents with ' +
        'their last-seen `connectionStatus` even when no peers are currently reachable.',
      parameters: {
        type: 'object',
        // Derived from the agent-list boundary, so the advertised vocabulary
        // and the serializer's exhaustive mapping cannot drift apart.
        properties: findAgentsSchemaProperties(),
        required: [],
      },
      execute: async (_toolCallId, args) => ctx.handleFindAgents(args),
    },
    {
      name: 'dkg_send_message',
      description:
        'Send an end-to-end encrypted chat message to another DKG agent. Use dkg_find_agents first to ' +
        'discover peer IDs. Fails when the target is offline or the P2P network is unavailable.',
      parameters: {
        type: 'object',
        properties: {
          peer_id: { type: 'string', description: 'Recipient peer ID (12D3KooW…) or agent name.' },
          text: { type: 'string', description: 'Message text.' },
        },
        required: ['peer_id', 'text'],
      },
      execute: async (_toolCallId, args) => ctx.handleSendMessage(args),
    },
    {
      name: 'dkg_read_messages',
      description:
        'Read locally-persisted chat history (messages sent + received through the DKG node). Backed by the ' +
        'node\'s local message store, so it returns full history offline. Optional filters: `peer` (peer ID or ' +
        'agent name), `limit`, `since` (Unix-ms cutoff).',
      parameters: {
        type: 'object',
        properties: {
          peer: { type: 'string', description: 'Filter by peer ID or agent name.' },
          limit: { type: 'string', description: 'Max messages (default 100, max 1000).' },
          since: { type: 'string', description: 'Only messages after this Unix-ms timestamp.' },
        },
        required: [],
      },
      execute: async (_toolCallId, args) => ctx.handleReadMessages(args),
    },
    {
      name: 'dkg_invoke_skill',
      description:
        "Invoke a remote agent's skill over the DKG network. Use dkg_find_agents with skill_type first. " +
        'Fails when the peer is offline or the P2P network is unavailable.',
      parameters: {
        type: 'object',
        properties: {
          peer_id: { type: 'string', description: 'Target peer ID (12D3KooW…) or agent name.' },
          skill_uri: { type: 'string', description: 'Skill URI (e.g. "ImageAnalysis").' },
          input: { type: 'string', description: 'UTF-8 input (skill-specific semantics).' },
        },
        required: ['peer_id', 'skill_uri', 'input'],
      },
      execute: async (_toolCallId, args) => ctx.handleInvokeSkill(args),
    },
  ];
}
