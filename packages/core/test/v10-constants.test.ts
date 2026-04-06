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
  contextGraphDataUri,
  contextGraphMetaUri,
  contextGraphPrivateUri,
  contextGraphSharedMemoryUri,
  contextGraphSharedMemoryMetaUri,
  contextGraphVerifiedMemoryUri,
  contextGraphVerifiedMemoryMetaUri,
  contextGraphDraftUri,
  contextGraphRulesUri,
  contextGraphSubGraphUri,
  // Deprecated aliases
  paranetPublishTopic,
  paranetWorkspaceTopic,
  paranetFinalizationTopic,
  paranetUpdateTopic,
  paranetAppTopic,
  paranetDataGraphUri,
  paranetMetaGraphUri,
  paranetPrivateGraphUri,
  paranetWorkspaceGraphUri,
  paranetWorkspaceMetaGraphUri,
  paranetSessionsTopic,
  paranetSessionTopic,
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

  it('draft URI', () => {
    expect(contextGraphDraftUri(id, '0xAbc', 'my-draft')).toBe('did:dkg:context-graph:42/draft/0xAbc/my-draft');
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

  it('paranetPublishTopic maps to finalization topic', () => {
    expect(paranetPublishTopic(id)).toBe(contextGraphFinalizationTopic(id));
  });

  it('paranetWorkspaceTopic maps to shared memory topic', () => {
    expect(paranetWorkspaceTopic(id)).toBe(contextGraphSharedMemoryTopic(id));
  });

  it('paranetFinalizationTopic maps to finalization topic', () => {
    expect(paranetFinalizationTopic(id)).toBe(contextGraphFinalizationTopic(id));
  });

  it('paranetUpdateTopic maps to update topic', () => {
    expect(paranetUpdateTopic(id)).toBe(contextGraphUpdateTopic(id));
  });

  it('paranetAppTopic maps to app topic', () => {
    expect(paranetAppTopic(id)).toBe(contextGraphAppTopic(id));
  });

  it('paranetDataGraphUri maps to data URI', () => {
    expect(paranetDataGraphUri(id)).toBe(contextGraphDataUri(id));
  });

  it('paranetMetaGraphUri maps to meta URI', () => {
    expect(paranetMetaGraphUri(id)).toBe(contextGraphMetaUri(id));
  });

  it('paranetPrivateGraphUri maps to private URI', () => {
    expect(paranetPrivateGraphUri(id)).toBe(contextGraphPrivateUri(id));
  });

  it('paranetWorkspaceGraphUri maps to shared memory URI', () => {
    expect(paranetWorkspaceGraphUri(id)).toBe(contextGraphSharedMemoryUri(id));
  });

  it('paranetWorkspaceMetaGraphUri maps to shared memory meta URI', () => {
    expect(paranetWorkspaceMetaGraphUri(id)).toBe(contextGraphSharedMemoryMetaUri(id));
  });

  it('paranetSessionsTopic maps to sessions topic', () => {
    expect(paranetSessionsTopic(id)).toBe(contextGraphSessionsTopic(id));
  });

  it('paranetSessionTopic maps to session topic', () => {
    expect(paranetSessionTopic(id, 'sess')).toBe(contextGraphSessionTopic(id, 'sess'));
  });

  it('all deprecated URIs use did:dkg:context-graph: prefix', () => {
    expect(paranetDataGraphUri(id)).toContain('did:dkg:context-graph:');
    expect(paranetMetaGraphUri(id)).toContain('did:dkg:context-graph:');
    expect(paranetPrivateGraphUri(id)).toContain('did:dkg:context-graph:');
    expect(paranetWorkspaceGraphUri(id)).toContain('did:dkg:context-graph:');
  });

  it('all deprecated topics use dkg/context-graph/ prefix', () => {
    expect(paranetWorkspaceTopic(id)).toContain('dkg/context-graph/');
    expect(paranetFinalizationTopic(id)).toContain('dkg/context-graph/');
    expect(paranetUpdateTopic(id)).toContain('dkg/context-graph/');
    expect(paranetAppTopic(id)).toContain('dkg/context-graph/');
  });
});
