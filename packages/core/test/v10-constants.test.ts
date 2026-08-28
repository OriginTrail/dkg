import { describe, it, expect } from 'vitest';
import {
  PROTOCOL_PUBLISH,
  PROTOCOL_QUERY,
  PROTOCOL_DISCOVER,
  PROTOCOL_SYNC,
  PROTOCOL_MESSAGE,
  PROTOCOL_ACCESS,
  PROTOCOL_QUERY_REMOTE,
  PROTOCOL_SWM_SENDER_KEY,
  PROTOCOL_SWM_UPDATE,
  PROTOCOL_SWM_SHARE_ACK,
  PROTOCOL_VERIFY_PROPOSAL,
  PROTOCOL_VERIFY_APPROVAL,
  PROTOCOL_STORAGE_ACK,
  PROTOCOL_STORAGE_ACK_V2,
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
  sharedMemoryReadBothFilter,
  contextGraphVerifiableMemoryUri,
  contextGraphVerifiableMemoryMetaUri,
  contextGraphAssertionUri,
  contextGraphLayerUri,
  contextGraphLayerUriCandidates,
  contextGraphLayerPrefixCandidates,
  knowledgeAssetAgentAddressesEqual,
  contextGraphRulesUri,
  contextGraphSubGraphUri,
  // Deprecated aliases
  contextGraphPublishTopic,
  contextGraphWorkspaceTopic,
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
  contextGraphPrivateGraphUri,
  contextGraphWorkspaceGraphUri,
  contextGraphWorkspaceMetaGraphUri,
} from '../src/constants.js';
import { MemoryLayer } from '../src/memory-model.js';
import { STORAGE_ACK_MAX_STAGING_BYTES } from '../src/protocol-limits.js';

describe('V10 protocol stream IDs', () => {
  // rc.9 plan: protocols on /dkg/10.0.1/* are migrated onto the
  // Universal Messenger substrate (envelope wrap + receiver dedup +
  // durable outbox). PR-3 migrated /message (chat + skill); PR-8
  // migrated /private-access + /swm-sender-key; PR-9 migrated
  // /query-remote; PR-11 migrated /storage-ack + /verify-proposal;
  // PR-E (SWM reliable fan-out plan, Step 2) migrates /sync so the
  // catch-up safety net itself rides the same reliability substrate.
  it('legacy + not-yet-migrated protocols on the /dkg/10.0.0/ prefix', () => {
    expect(PROTOCOL_PUBLISH).toBe('/dkg/10.0.0/publish');
    expect(PROTOCOL_QUERY).toBe('/dkg/10.0.0/query');
    expect(PROTOCOL_DISCOVER).toBe('/dkg/10.0.0/discover');
  });

  // /verify-approval stays on /dkg/10.0.0/ because it's an async
  // follow-up signal, not a synchronous request.
  it('substrate-migrated protocols use /dkg/10.0.1/ prefix', () => {
    expect(PROTOCOL_MESSAGE).toBe('/dkg/10.0.1/message');
    expect(PROTOCOL_ACCESS).toBe('/dkg/10.0.1/private-access');
    expect(PROTOCOL_QUERY_REMOTE).toBe('/dkg/10.0.1/query-remote');
    expect(PROTOCOL_SWM_SENDER_KEY).toBe('/dkg/10.0.1/swm-sender-key');
    expect(PROTOCOL_SWM_UPDATE).toBe('/dkg/10.0.1/swm-update');
    expect(PROTOCOL_SWM_SHARE_ACK).toBe('/dkg/10.0.1/swm-share-ack');
    expect(PROTOCOL_VERIFY_PROPOSAL).toBe('/dkg/10.0.1/verify-proposal');
    expect(PROTOCOL_VERIFY_APPROVAL).toBe('/dkg/10.0.0/verify-approval');
    expect(PROTOCOL_STORAGE_ACK).toBe('/dkg/10.0.1/storage-ack');
  });

  it('sync uses the /dkg/10.0.2/ prefix (taken back OFF the messenger substrate)', () => {
    expect(PROTOCOL_SYNC).toBe('/dkg/10.0.2/sync');
  });

  it('storage ACK V2 uses the /dkg/10.0.2/ prefix for field-20 capable ACKs', () => {
    expect(PROTOCOL_STORAGE_ACK_V2).toBe('/dkg/10.0.2/storage-ack');
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

  it('limits one DKG gossip application payload to the 4 MiB StorageACK ceiling', () => {
    expect(DKG_GOSSIP_MAX_MESSAGE_BYTES).toBe(4 * 1024 * 1024);
    expect(DKG_GOSSIP_MAX_MESSAGE_BYTES).toBe(STORAGE_ACK_MAX_STAGING_BYTES);
    expect(DKG_GOSSIP_MAX_RPC_BYTES).toBe(DKG_GOSSIP_MAX_MESSAGE_BYTES + 256 * 1024);
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

  it('shared memory read-both filter covers bucket and non-staging per-KA graphs', () => {
    expect(sharedMemoryReadBothFilter(contextGraphSharedMemoryUri(id), '?graph')).toBe(
      'FILTER(((STRSTARTS(STR(?graph), "did:dkg:context-graph:42/_shared_memory/") && !STRSTARTS(STR(?graph), "did:dkg:context-graph:42/_shared_memory/staging/")) || STR(?graph) = "did:dkg:context-graph:42/_shared_memory"))',
    );
  });

  it('shared memory read-both filter rejects unsafe interpolation inputs', () => {
    expect(() => sharedMemoryReadBothFilter('did:dkg:context-graph:42/_shared_memory" } UNION { ?s ?p ?o } #'))
      .toThrow(/Unsafe or empty IRI value/);
    expect(() => sharedMemoryReadBothFilter(contextGraphSharedMemoryUri(id), '?g) } UNION { ?s ?p ?o } #'))
      .toThrow(/Unsafe SPARQL graph variable/);
  });

  it('shared memory meta URI', () => {
    expect(contextGraphSharedMemoryMetaUri(id)).toBe('did:dkg:context-graph:42/_shared_memory_meta');
  });

  it('verifiable memory URI', () => {
    expect(contextGraphVerifiableMemoryUri(id, '7')).toBe('did:dkg:context-graph:42/_verifiable_memory/7');
  });

  it('verifiable memory meta URI', () => {
    expect(contextGraphVerifiableMemoryMetaUri(id, '7')).toBe('did:dkg:context-graph:42/_verifiable_memory/7/_meta');
  });

  it('assertion URI', () => {
    expect(contextGraphAssertionUri(id, '0xAbc', 'my-assertion')).toBe('did:dkg:context-graph:42/assertion/0xAbc/my-assertion');
  });

  it('uniform per-KA layer URI: every layer differs ONLY by the {_layer} token', () => {
    expect(contextGraphLayerUri(id, MemoryLayer.WorkingMemory, '0xAbc', 7))
      .toBe('did:dkg:context-graph:42/_working_memory/0xAbc/7');
    expect(contextGraphLayerUri(id, MemoryLayer.SharedWorkingMemory, '0xAbc', 7))
      .toBe('did:dkg:context-graph:42/_shared_memory/0xAbc/7');
    expect(contextGraphLayerUri(id, MemoryLayer.VerifiableMemory, '0xAbc', 7))
      .toBe('did:dkg:context-graph:42/_verifiable_memory/0xAbc/7');
  });

  it('uniform per-KA layer URI: same {addr}/{number} suffix across the lifecycle', () => {
    const wm = contextGraphLayerUri(id, MemoryLayer.WorkingMemory, '0xAbc', 7);
    const swm = contextGraphLayerUri(id, MemoryLayer.SharedWorkingMemory, '0xAbc', 7);
    const vm = contextGraphLayerUri(id, MemoryLayer.VerifiableMemory, '0xAbc', 7);
    const suffix = (u: string) => u.split('/').slice(-2).join('/');
    expect(suffix(wm)).toBe('0xAbc/7');
    expect(suffix(swm)).toBe('0xAbc/7');
    expect(suffix(vm)).toBe('0xAbc/7');
  });

  it('canonicalizes a full EVM-address suffix uniformly across every memory layer', () => {
    const mixed = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01';
    const expectedSuffix = '0xabcdef0123456789abcdef0123456789abcdef01/7';
    for (const layer of [
      MemoryLayer.WorkingMemory,
      MemoryLayer.SharedWorkingMemory,
      MemoryLayer.VerifiableMemory,
    ]) {
      expect(contextGraphLayerUri(id, layer, mixed, 7).endsWith(expectedSuffix)).toBe(true);
    }
  });

  it('centralizes canonical and caller-known legacy graph and prefix candidates', () => {
    const mixed = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01';
    const lower = mixed.toLowerCase();
    expect(contextGraphLayerUriCandidates(
      id,
      MemoryLayer.WorkingMemory,
      mixed,
      7,
      'game-state',
    )).toEqual([
      `did:dkg:context-graph:${id}/game-state/_working_memory/${lower}/7`,
      `did:dkg:context-graph:${id}/game-state/_working_memory/${mixed}/7`,
    ]);
    expect(contextGraphLayerPrefixCandidates(
      id,
      MemoryLayer.SharedWorkingMemory,
      mixed,
      'game-state',
    )).toEqual([
      `did:dkg:context-graph:${id}/game-state/_shared_memory/${lower}/`,
      `did:dkg:context-graph:${id}/game-state/_shared_memory/${mixed}/`,
    ]);
    expect(knowledgeAssetAgentAddressesEqual(mixed, lower)).toBe(true);
    expect(knowledgeAssetAgentAddressesEqual('PeerA', 'peera')).toBe(false);
  });

  it('uniform per-KA layer URI: sub-graph scoping is uniform across layers', () => {
    expect(contextGraphLayerUri(id, MemoryLayer.VerifiableMemory, '0xAbc', 7, 'game-state'))
      .toBe('did:dkg:context-graph:42/game-state/_verifiable_memory/0xAbc/7');
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
