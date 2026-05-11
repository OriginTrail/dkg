import { describe, it, expect } from 'vitest';
import {
  PROTOCOL_PUBLISH,
  PROTOCOL_QUERY,
  PROTOCOL_DISCOVER,
  PROTOCOL_SYNC,
  PROTOCOL_MESSAGE,
  PROTOCOL_ACCESS,
  PROTOCOL_QUERY_REMOTE,
  PROTOCOL_VERIFY_PROPOSAL,
  PROTOCOL_VERIFY_APPROVAL,
  PROTOCOL_STORAGE_ACK,
  DHT_PROTOCOL,
  contextGraphSharedMemoryTopic,
  contextGraphFinalizationTopic,
  contextGraphUpdateTopic,
  contextGraphAppTopic,
  contextGraphSessionsTopic,
  contextGraphSessionTopic,
  networkPeersTopic,
  DKG_GOSSIP_MAX_MESSAGE_BYTES,
  DKG_GOSSIP_MAX_RPC_BYTES,
  contextGraphDataUri,
  contextGraphMetaUri,
  contextGraphPrivateUri,
  contextGraphSharedMemoryUri,
  contextGraphSharedMemoryMetaUri,
  contextGraphVerifiedMemoryUri,
  contextGraphVerifiedMemoryMetaUri,
  contextGraphAssertionUri,
  contextGraphRulesUri,
  contextGraphSubGraphUri,
  // Deprecated aliases
  contextGraphPublishTopic,
  contextGraphWorkspaceTopic,
  contextGraphFinalizationTopic,
  contextGraphUpdateTopic,
  contextGraphAppTopic,
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
  contextGraphPrivateGraphUri,
  contextGraphWorkspaceGraphUri,
  contextGraphWorkspaceMetaGraphUri,
  contextGraphSessionsTopic,
  contextGraphSessionTopic,
} from '../src/constants.js';

describe('V10 protocol stream IDs', () => {
  it('uses /dkg/10.0.0/ version prefix', () => {
    expect(PROTOCOL_PUBLISH).toBe('/dkg/10.0.0/publish');
    expect(PROTOCOL_QUERY).toBe('/dkg/10.0.0/query');
    expect(PROTOCOL_DISCOVER).toBe('/dkg/10.0.0/discover');
    expect(PROTOCOL_SYNC).toBe('/dkg/10.0.0/sync');
    expect(PROTOCOL_MESSAGE).toBe('/dkg/10.0.0/message');
    expect(PROTOCOL_ACCESS).toBe('/dkg/10.0.0/private-access');
    expect(PROTOCOL_QUERY_REMOTE).toBe('/dkg/10.0.0/query-remote');
  });

  it('defines new VERIFY and ACK protocols', () => {
    expect(PROTOCOL_VERIFY_PROPOSAL).toBe('/dkg/10.0.0/verify-proposal');
    expect(PROTOCOL_VERIFY_APPROVAL).toBe('/dkg/10.0.0/verify-approval');
    expect(PROTOCOL_STORAGE_ACK).toBe('/dkg/10.0.0/storage-ack');
  });

  it('DHT protocol is unchanged', () => {
    expect(DHT_PROTOCOL).toBe('/dkg/kad/1.0.0');
  });
});

describe('V10 GossipSub topics', () => {
  const id = 'test-cg-42';

  it('shared memory (SWM) topic', () => {
    expect(contextGraphSharedMemoryTopic(id)).toBe('dkg/context-graph/test-cg-42/shared-memory');
  });

  it('finalization topic', () => {
    expect(contextGraphFinalizationTopic(id)).toBe('dkg/context-graph/test-cg-42/finalization');
  });

  it('update topic', () => {
    expect(contextGraphUpdateTopic(id)).toBe('dkg/context-graph/test-cg-42/update');
  });

  it('app topic', () => {
    expect(contextGraphAppTopic(id)).toBe('dkg/context-graph/test-cg-42/app');
  });

  it('sessions topic', () => {
    expect(contextGraphSessionsTopic(id)).toBe('dkg/context-graph/test-cg-42/sessions');
  });

  it('session topic with session ID', () => {
    expect(contextGraphSessionTopic(id, 'sess-1')).toBe('dkg/context-graph/test-cg-42/sessions/sess-1');
  });

  it('network peers topic', () => {
    expect(networkPeersTopic()).toBe('dkg/network/peers');
  });

  it('allows one 10 MB DKG gossip application payload', () => {
    expect(DKG_GOSSIP_MAX_MESSAGE_BYTES).toBe(10 * 1024 * 1024);
    expect(DKG_GOSSIP_MAX_RPC_BYTES).toBeGreaterThan(DKG_GOSSIP_MAX_MESSAGE_BYTES);
  });
});

describe('V10 named graph URIs', () => {
  const id = '42';

  it('data graph URI', () => {
    expect(contextGraphDataUri(id)).toBe('did:dkg:context-graph:42');
  });

  it('meta graph URI', () => {
    expect(contextGraphMetaUri(id)).toBe('did:dkg:context-graph:42/_meta');
  });

  it('private graph URI', () => {
    expect(contextGraphPrivateUri(id)).toBe('did:dkg:context-graph:42/_private');
  });

  it('shared memory URI', () => {
    expect(contextGraphSharedMemoryUri(id)).toBe('did:dkg:context-graph:42/_shared_memory');
  });

  it('shared memory meta URI', () => {
    expect(contextGraphSharedMemoryMetaUri(id)).toBe('did:dkg:context-graph:42/_shared_memory_meta');
  });

  it('verified memory URI', () => {
    expect(contextGraphVerifiedMemoryUri(id, '7')).toBe('did:dkg:context-graph:42/_verified_memory/7');
  });

  it('verified memory meta URI', () => {
    expect(contextGraphVerifiedMemoryMetaUri(id, '7')).toBe('did:dkg:context-graph:42/_verified_memory/7/_meta');
  });

  it('assertion URI', () => {
    expect(contextGraphAssertionUri(id, '0xAbc', 'my-assertion')).toBe('did:dkg:context-graph:42/assertion/0xAbc/my-assertion');
  });

  it('rules URI', () => {
    expect(contextGraphRulesUri(id)).toBe('did:dkg:context-graph:42/_rules');
  });

  it('sub-graph URI', () => {
    expect(contextGraphSubGraphUri(id, 'game-state')).toBe('did:dkg:context-graph:42/game-state');
  });
});

describe('deprecated V9 aliases still work', () => {
  const id = 'test-42';

  it('contextGraphPublishTopic maps to finalization topic', () => {
    expect(contextGraphPublishTopic(id)).toBe(contextGraphFinalizationTopic(id));
  });

  it('contextGraphWorkspaceTopic maps to shared memory topic', () => {
    expect(contextGraphWorkspaceTopic(id)).toBe(contextGraphSharedMemoryTopic(id));
  });

  it('contextGraphFinalizationTopic maps to finalization topic', () => {
    expect(contextGraphFinalizationTopic(id)).toBe(contextGraphFinalizationTopic(id));
  });

  it('contextGraphUpdateTopic maps to update topic', () => {
    expect(contextGraphUpdateTopic(id)).toBe(contextGraphUpdateTopic(id));
  });

  it('contextGraphAppTopic maps to app topic', () => {
    expect(contextGraphAppTopic(id)).toBe(contextGraphAppTopic(id));
  });

  it('contextGraphDataGraphUri maps to data URI', () => {
    expect(contextGraphDataGraphUri(id)).toBe(contextGraphDataUri(id));
  });

  it('contextGraphMetaGraphUri maps to meta URI', () => {
    expect(contextGraphMetaGraphUri(id)).toBe(contextGraphMetaUri(id));
  });

  it('contextGraphPrivateGraphUri maps to private URI', () => {
    expect(contextGraphPrivateGraphUri(id)).toBe(contextGraphPrivateUri(id));
  });

  it('contextGraphWorkspaceGraphUri maps to shared memory URI', () => {
    expect(contextGraphWorkspaceGraphUri(id)).toBe(contextGraphSharedMemoryUri(id));
  });

  it('contextGraphWorkspaceMetaGraphUri maps to shared memory meta URI', () => {
    expect(contextGraphWorkspaceMetaGraphUri(id)).toBe(contextGraphSharedMemoryMetaUri(id));
  });

  it('contextGraphSessionsTopic maps to sessions topic', () => {
    expect(contextGraphSessionsTopic(id)).toBe(contextGraphSessionsTopic(id));
  });

  it('contextGraphSessionTopic maps to session topic', () => {
    expect(contextGraphSessionTopic(id, 'sess')).toBe(contextGraphSessionTopic(id, 'sess'));
  });

  it('all deprecated URIs use did:dkg:context-graph: prefix', () => {
    expect(contextGraphDataGraphUri(id)).toContain('did:dkg:context-graph:');
    expect(contextGraphMetaGraphUri(id)).toContain('did:dkg:context-graph:');
    expect(contextGraphPrivateGraphUri(id)).toContain('did:dkg:context-graph:');
    expect(contextGraphWorkspaceGraphUri(id)).toContain('did:dkg:context-graph:');
  });

  it('all deprecated topics use dkg/context-graph/ prefix', () => {
    expect(contextGraphWorkspaceTopic(id)).toContain('dkg/context-graph/');
    expect(contextGraphFinalizationTopic(id)).toContain('dkg/context-graph/');
    expect(contextGraphUpdateTopic(id)).toContain('dkg/context-graph/');
    expect(contextGraphAppTopic(id)).toContain('dkg/context-graph/');
  });
});
