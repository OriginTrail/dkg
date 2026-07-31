import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DKG_ONTOLOGY,
  SYSTEM_CONTEXT_GRAPHS,
  contextGraphDataGraphUri,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/dkg-agent.js';
import { buildAuthoritativePublicMetaAskQuery } from '../src/context-graph-public-meta-proof.js';

describe('public metadata startup authority', () => {
  it('does not promote a network-supplied ontology creator claim into root metadata', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-public-meta-spoof-'));
    const makeAgent = () => DKGAgent.create({
      name: 'PublicMetaSpoofRegression',
      listenHost: '127.0.0.1',
      listenPort: 0,
      dataDir,
    });
    const firstStart = await makeAgent();
    await firstStart.start();
    const localPeerId = firstStart.peerId;
    await firstStart.stop();

    const agent = await makeAgent();
    const store = agent.store;
    const contextGraphId = 'spoofed-local-creator-claim';
    const subject = contextGraphDataGraphUri(contextGraphId);
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const spoofedDefinition: Quad[] = [
      {
        subject,
        predicate: DKG_ONTOLOGY.RDF_TYPE,
        object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
        graph: ontologyGraph,
      },
      {
        subject,
        predicate: DKG_ONTOLOGY.DKG_CREATOR,
        object: `did:dkg:agent:${localPeerId}`,
        graph: ontologyGraph,
      },
      {
        subject,
        predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
        object: '"public"',
        graph: ontologyGraph,
      },
    ];

    try {
      await store.insert(spoofedDefinition);
      await agent.start();

      const proof = await store.query(buildAuthoritativePublicMetaAskQuery(contextGraphId));
      expect(proof).toEqual({ type: 'boolean', value: false });
    } finally {
      await agent.stop().catch(() => {});
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('repairs a legacy public graph backed by durable local-create provenance', async () => {
    const contextGraphId = 'durably-local-created-legacy-public';
    const subject = contextGraphDataGraphUri(contextGraphId);
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const store = new OxigraphStore();
    const agent = await DKGAgent.create({
      name: 'PublicMetaTrustedRepairRegression',
      listenHost: '127.0.0.1',
      listenPort: 0,
      store,
      contextGraphMembershipStore: {
        loadAll: async () => [{
          contextGraphId,
          principalType: 'agent' as const,
          principalId: '0x0000000000000000000000000000000000000001',
          role: 'curator',
          status: 'active' as const,
          source: 'local-create',
          updatedAt: 1,
        }],
        upsert: async () => {},
        delete: async () => {},
      },
    });

    try {
      await store.insert([
        {
          subject,
          predicate: DKG_ONTOLOGY.RDF_TYPE,
          object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
          graph: ontologyGraph,
        },
        {
          subject,
          predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
          object: '"public"',
          graph: ontologyGraph,
        },
      ]);
      await agent.start();

      const proof = await store.query(buildAuthoritativePublicMetaAskQuery(contextGraphId));
      expect(proof).toEqual({ type: 'boolean', value: true });
    } finally {
      await agent.stop().catch(() => {});
    }
  });
});
