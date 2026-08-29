/**
 * Agent discovery & peer messaging tool definitions for {@link DkgNodePlugin}.
 *
 * Moved verbatim out of `DkgNodePlugin.tools()` — same metadata and handler
 * delegation, only relocated. The `execute` callbacks forward to the host's
 * `handle*` methods (see {@link DkgToolHost}). No behavior change.
 */
import type { OpenClawTool } from '../types.js';
import type { DkgToolHost } from './tool-host.js';

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
        properties: {
          framework: { type: 'string', description: 'Filter by framework (e.g. "OpenClaw", "ElizaOS").' },
          skill_type: { type: 'string', description: 'Filter by skill type URI (e.g. "ImageAnalysis").' },
          connection_status: {
            type: 'string',
            enum: ['self', 'connected', 'disconnected'],
            description: 'Only agents in this live connection state.',
          },
          local: {
            type: 'boolean',
            description: "Only this node's own agents — the cheap way to learn your own agent address.",
          },
          limit: { type: 'number', description: 'Page size; the response carries nextCursor while rows remain.' },
          cursor: { type: 'string', description: 'Opaque cursor from a previous response; repeat the same filters.' },
        },
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
