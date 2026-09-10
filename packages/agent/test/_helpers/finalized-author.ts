import {
  buildAssertionSealQuads, contextGraphAssertionUri, contextGraphMetaUri,
  GRAPH_KA_CONTENT_SCOPE_VERSION,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { computeFlatKCRootV10 } from '@origintrail-official/dkg-publisher';
import { DKGAgent } from '../../src/dkg-agent.js';

export const CG = 'construction';
export const MEMBER = '0xA32f1cc125401B55911678847426759094055B2d';
export const CURATOR = `0x${'11'.repeat(20)}`;
export const OTHER = `0x${'22'.repeat(20)}`;
export const NAME = 'justTriplets';
export const KA_UAL = `did:dkg:hardhat:31337/${MEMBER}/7`;
export const RESERVED_KA_ID = (BigInt(MEMBER) << 96n) | 7n;
export const PUBLIC_QUAD: Quad = {
  subject: 'urn:justTriplets:subject1',
  predicate: 'urn:justTriplets:predicate1',
  object: '"value1"',
  graph: '',
};
export const MERKLE = computeFlatKCRootV10([PUBLIC_QUAD], []);

export function sealAt(cg: string, author: string, name = NAME, subGraphName?: string): Quad[] {
  return buildAssertionSealQuads({
    assertionUri: contextGraphAssertionUri(cg, author, name, subGraphName),
    metaGraph: contextGraphMetaUri(cg),
    merkleRoot: MERKLE,
    authorAddress: author,
    authorAttestationR: new Uint8Array(32).fill(1),
    authorAttestationVS: new Uint8Array(32).fill(2),
    authorSchemeVersion: 1,
    chainId: 31337n,
    kav10Address: '0x1234567890123456789012345678901234567890',
    reservedKaId: (BigInt(author) << 96n) | 7n,
    finalizedAtIso: '2026-01-01T00:00:00.000Z',
    contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
    kaUal: `did:dkg:hardhat:31337/${author}/7`,
    assertionVersion: 1,
    publicTripleCount: 1,
    privateTripleCount: 0,
  }) as Quad[];
}

export function sealFor(author: string, name = NAME): Quad[] {
  return sealAt(CG, author, name);
}

function makeLog() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

export function stubAgent(store: OxigraphStore, defaultAgentAddress: string) {
  const agent = Object.create(DKGAgent.prototype) as any;
  agent.store = store;
  agent.log = makeLog();
  agent.defaultAgentAddress = defaultAgentAddress;
  Object.defineProperty(agent, 'peerId', {
    value: '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6',
    configurable: true,
  });
  return agent;
}
