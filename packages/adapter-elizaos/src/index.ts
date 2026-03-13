/**
 * @origintrail-official/dkg-adapter-elizaos — ElizaOS plugin that turns any ElizaOS agent
 * into a DKG V9 node.
 *
 * Usage in a character config:
 *
 *   import { dkgPlugin } from '@origintrail-official/dkg-adapter-elizaos';
 *
 *   const character = {
 *     plugins: [dkgPlugin],
 *     settings: {
 *       DKG_DATA_DIR: '.dkg/my-agent',
 *       DKG_RELAY_PEERS: '/ip4/1.2.3.4/tcp/9090/p2p/12D3KooW...',
 *     },
 *   };
 */
import type { Plugin } from './types.js';
import { dkgService } from './service.js';
import { dkgKnowledgeProvider } from './provider.js';
import {
  dkgPublish,
  dkgQuery,
  dkgFindAgents,
  dkgSendMessage,
  dkgInvokeSkill,
} from './actions.js';

export const dkgPlugin: Plugin = {
  name: 'dkg-v9',
  description:
    'Turns this ElizaOS agent into a DKG V9 node — publish knowledge, ' +
    'query the graph, discover agents, and invoke remote skills over a ' +
    'decentralized P2P network.',
  actions: [dkgPublish, dkgQuery, dkgFindAgents, dkgSendMessage, dkgInvokeSkill],
  providers: [dkgKnowledgeProvider],
  services: [dkgService],
};

export { dkgService, getAgent } from './service.js';
export { dkgKnowledgeProvider } from './provider.js';
export { dkgPublish, dkgQuery, dkgFindAgents, dkgSendMessage, dkgInvokeSkill } from './actions.js';
export type {
  Plugin,
  Action,
  Provider,
  Service,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback,
} from './types.js';
