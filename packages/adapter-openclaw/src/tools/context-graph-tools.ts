/**
 * Context-graph lifecycle & membership tool definitions for
 * {@link DkgNodePlugin}.
 *
 * Moved verbatim out of `DkgNodePlugin.tools()` — same metadata and handler
 * delegation, only relocated. The `execute` callbacks forward to the host's
 * `handle*` methods (see {@link DkgToolHost}). No behavior change.
 */
import type { OpenClawTool } from '../types.js';
import { EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION } from '../dkg-node-plugin-constants.js';
import type { DkgToolHost } from './tool-host.js';

export function buildContextGraphTools(ctx: DkgToolHost): OpenClawTool[] {
  return [
    {
      name: 'dkg_list_context_graphs',
      description:
        'List contextGraphs known to this node. Defaults to this caller\'s created/joined context graphs ' +
        'to avoid noisy discovered graphs; pass scope="all" to inspect every known graph. Use this only ' +
        'when no target context graph is injected or configured and the agent needs to choose one.',
      parameters: {
        type: 'object',
        properties: {
          scope: {
            type: 'string',
            enum: ['mine', 'all'],
            description: 'Defaults to "mine" (created/joined context graphs for this caller). Use "all" for every known graph.',
          },
        },
        required: [],
      },
      execute: async (_toolCallId, params) => ctx.handleListContextGraphs(params ?? {}),
    },
    {
      name: 'dkg_context_graph_create',
      description:
        'Create a new context graph on the DKG node. A context graph is a scoped knowledge domain ' +
        'that organizes published knowledge. Returns the context graph ID and URI (did:dkg:context-graph:<id>). ' +
        'The ID is auto-generated from the name if not provided. ' +
        'Defaults to a curated/private context graph — the creator is auto-included in the allowlist ' +
        'and can immediately write to working/shared memory. Pass `public: true` for an open/discoverable ' +
        'context graph, or `allowed_agents` to invite collaborators atomically with creation. ' +
        'For later writes, use the exact returned id or full did:dkg:context-graph:<id> URI.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Human-readable context graph name (e.g. "My Research Context Graph")',
          },
          description: {
            type: 'string',
            description: 'Optional description of what this context graph contains',
          },
          id: {
            type: 'string',
            description:
              'Optional create-only context graph id slug. Auto-generated from name if omitted ' +
              '(e.g. "My Research" -> "my-research"). For later writes, use the exact returned id ' +
              'or full did:dkg:context-graph:<id> URI.',
          },
          public: {
            type: 'boolean',
            description: 'If true, creates an open/discoverable context graph (anyone can subscribe and read). Default is false — the context graph is curated/private and restricted to allowed_agents (the creator is always auto-included).',
          },
          allowed_agents: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional agent addresses (0x...) to add to the curation allowlist at creation time. The creator\'s own address is auto-added regardless. Ignored when public is true.',
          },
        },
        required: ['name'],
      },
      execute: async (_toolCallId, args) => ctx.handleContextGraphCreate(args),
    },
    {
      name: 'dkg_context_graph_invite',
      description:
        'Invite a peer to a context graph using their peer ID. For "share this project with my friend" ' +
        'requests, this is the primary user-facing deliverable because it returns a ready-to-share invite code ' +
        'that the friend can paste into Join. Use this when you have a peer ID but not the friend\'s agent ' +
        'address, or alongside `dkg_participant_add` when you have both identifiers for a private project.',
      parameters: {
        type: 'object',
        properties: {
          context_graph_id: { type: 'string', description: `Target context graph. ${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION}` },
          peer_id: { type: 'string', description: 'Target peer ID (12D3KooW...).' },
        },
        required: ['context_graph_id', 'peer_id'],
      },
      execute: async (_toolCallId, args) => ctx.handleContextGraphInvite(args),
    },
    {
      name: 'dkg_participant_add',
      description:
        'Add an agent address to a curated/private context graph allowlist. Use this when you know the ' +
        'friend\'s DKG agent address. For "share with my friend" requests on private projects, prefer ' +
        'returning an invite code too when you also have their peer ID, because allowlisting alone is not the ' +
        'full UI join flow.',
      parameters: {
        type: 'object',
        properties: {
          context_graph_id: { type: 'string', description: `Target context graph. ${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION}` },
          agent_address: { type: 'string', description: 'Friend\'s DKG agent address (0x...).' },
        },
        required: ['context_graph_id', 'agent_address'],
      },
      execute: async (_toolCallId, args) => ctx.handleParticipantAdd(args),
    },
    {
      name: 'dkg_participant_remove',
      description:
        'Remove an agent address from a curated/private context graph allowlist.',
      parameters: {
        type: 'object',
        properties: {
          context_graph_id: { type: 'string', description: `Target context graph. ${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION}` },
          agent_address: { type: 'string', description: 'Agent address to remove (0x...).' },
        },
        required: ['context_graph_id', 'agent_address'],
      },
      execute: async (_toolCallId, args) => ctx.handleParticipantRemove(args),
    },
    {
      name: 'dkg_participant_list',
      description:
        'List the allowed agent addresses for a context graph.',
      parameters: {
        type: 'object',
        properties: {
          context_graph_id: { type: 'string', description: `Target context graph. ${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION}` },
        },
        required: ['context_graph_id'],
      },
      execute: async (_toolCallId, args) => ctx.handleParticipantList(args),
    },
    {
      name: 'dkg_join_request_list',
      description:
        'List pending join requests for a context graph so the curator can review them.',
      parameters: {
        type: 'object',
        properties: {
          context_graph_id: { type: 'string', description: `Target context graph. ${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION}` },
        },
        required: ['context_graph_id'],
      },
      execute: async (_toolCallId, args) => ctx.handleJoinRequestList(args),
    },
    {
      name: 'dkg_join_request_approve',
      description:
        'Approve a pending join request for the given agent address.',
      parameters: {
        type: 'object',
        properties: {
          context_graph_id: { type: 'string', description: `Target context graph. ${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION}` },
          agent_address: { type: 'string', description: 'Requesting agent address (0x...).' },
        },
        required: ['context_graph_id', 'agent_address'],
      },
      execute: async (_toolCallId, args) => ctx.handleJoinRequestApprove(args),
    },
    {
      name: 'dkg_join_request_reject',
      description:
        'Reject a pending join request for the given agent address.',
      parameters: {
        type: 'object',
        properties: {
          context_graph_id: { type: 'string', description: `Target context graph. ${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION}` },
          agent_address: { type: 'string', description: 'Requesting agent address (0x...).' },
        },
        required: ['context_graph_id', 'agent_address'],
      },
      execute: async (_toolCallId, args) => ctx.handleJoinRequestReject(args),
    },
    {
      name: 'dkg_subscribe',
      description:
        'Subscribe to a context graph to receive its data from peers. Call once before querying or publishing ' +
        'a remotely-authored CG.',
      parameters: {
        type: 'object',
        properties: {
          context_graph_id: { type: 'string', description: `Context graph to subscribe to. ${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION}` },
          include_shared_memory: {
            type: 'boolean',
            description: 'Also sync Shared Working Memory. Default: true.',
          },
        },
        required: ['context_graph_id'],
      },
      execute: async (_toolCallId, args) => ctx.handleSubscribe(args),
    },
  ];
}
