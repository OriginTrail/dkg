import { describe, expect, it } from 'vitest';
import {
  buildAssertionSealQuads,
  contextGraphAssertionUri,
  contextGraphMetaUri,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/dkg-agent.js';

const CG = 'publish-agent-lane';
const NAME = 'asset';
const DEFAULT_AGENT = `0x${'11'.repeat(20)}`;
const AGENT_B = `0x${'22'.repeat(20)}`;
const ROOT = 'urn:test:agent-b-root';
const MERKLE = new Uint8Array(32).fill(7);
const RESERVED_KA_ID = (BigInt(AGENT_B) << 96n) | 1n;

function makeLog() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

describe('DKGAgent publishFromFinalizedAssertion agent lane', () => {
  it('reads finalized assertions from the explicitly selected non-default agent lane', async () => {
    const store = new OxigraphStore();
    const assertionUri = contextGraphAssertionUri(CG, AGENT_B, NAME);

    await store.insert(buildAssertionSealQuads({
      assertionUri,
      metaGraph: contextGraphMetaUri(CG),
      merkleRoot: MERKLE,
      authorAddress: AGENT_B,
      authorAttestationR: new Uint8Array(32).fill(1),
      authorAttestationVS: new Uint8Array(32).fill(2),
      authorSchemeVersion: 1,
      chainId: 31337n,
      kav10Address: AGENT_B,
      reservedKaId: RESERVED_KA_ID,
      finalizedAtIso: '2026-01-01T00:00:00.000Z',
      rootEntities: [ROOT],
    }) as Quad[]);

    const markerCalls: Array<{
      contextGraphId: string;
      name: string;
      agentAddress: string;
      subGraphName?: string;
    }> = [];
    const publishCalls: Array<{ contextGraphId: string; selection: any; opts: any }> = [];
    const loadCalls: Array<{ contextGraphId: string; selection: any; subGraphName?: string }> = [];

    const agent = Object.create(DKGAgent.prototype) as any;
    agent.store = store;
    agent.chain = {};
    agent.defaultAgentAddress = DEFAULT_AGENT;
    Object.defineProperty(agent, 'peerId', {
      value: '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6',
      configurable: true,
    });
    agent.log = makeLog();
    agent.publisher = {
      hasSwmShareComplete: async (
        contextGraphId: string,
        name: string,
        agentAddress: string,
        subGraphName?: string,
      ) => {
        markerCalls.push({ contextGraphId, name, agentAddress, subGraphName });
        return agentAddress === AGENT_B;
      },
      clearSwmShareComplete: async () => {},
    };
    agent._loadSelectedSWMQuads = async (
      contextGraphId: string,
      selection: any,
      subGraphName?: string,
    ) => {
      loadCalls.push({ contextGraphId, selection, subGraphName });
      return [{
        subject: ROOT,
        predicate: 'http://schema.org/name',
        object: '"B lane"',
        graph: '',
      }];
    };
    agent.publishFromSharedMemory = async (contextGraphId: string, selection: any, opts: any) => {
      publishCalls.push({ contextGraphId, selection, opts });
      return {
        kaId: RESERVED_KA_ID,
        ual: 'did:dkg:test/31337/1',
        merkleRoot: MERKLE,
        kaManifest: [],
        status: 'tentative',
        publicQuads: [],
      };
    };

    await expect(agent.publishFromFinalizedAssertion(CG, NAME)).rejects.toThrow(/is not finalized/);

    const result = await agent.publishFromFinalizedAssertion(CG, NAME, {
      agentAddress: AGENT_B,
    });

    expect(result.assertionUri).toBe(assertionUri);
    expect(markerCalls).toEqual([{
      contextGraphId: CG,
      name: NAME,
      agentAddress: AGENT_B,
      subGraphName: undefined,
    }]);
    expect(loadCalls).toEqual([{
      contextGraphId: CG,
      selection: { rootEntities: [ROOT] },
      subGraphName: undefined,
    }]);
    expect(publishCalls).toHaveLength(1);
    expect(publishCalls[0]).toMatchObject({
      contextGraphId: CG,
      selection: { rootEntities: [ROOT] },
    });
    expect(publishCalls[0]?.opts).toMatchObject({
      reservedKaId: RESERVED_KA_ID,
      precomputedAttestation: {
        expectedMerkleRoot: MERKLE,
        authorAddress: AGENT_B,
        schemeVersion: 1,
        reservedKaId: RESERVED_KA_ID,
      },
    });
    expect(result.status).toBe('tentative');
  });
});
