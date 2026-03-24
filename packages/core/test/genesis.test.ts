import { describe, it, expect } from 'vitest';
import {
  getGenesisQuads,
  computeNetworkId,
  getGenesisRaw,
  SYSTEM_CONTEXT_GRAPHS,
  DKG_ONTOLOGY,
} from '../src/genesis.js';
import { sha256 } from '../src/index.js';

describe('getGenesisQuads', () => {
  it('returns the expected number of quads', () => {
    const quads = getGenesisQuads();
    expect(quads.length).toBe(40);
  });

  it('every quad has subject, predicate, object, and graph fields', () => {
    for (const q of getGenesisQuads()) {
      expect(typeof q.subject).toBe('string');
      expect(typeof q.predicate).toBe('string');
      expect(typeof q.object).toBe('string');
      expect(typeof q.graph).toBe('string');
      expect(q.subject.length).toBeGreaterThan(0);
      expect(q.predicate.length).toBeGreaterThan(0);
      expect(q.object.length).toBeGreaterThan(0);
    }
  });

  it('includes the network definition quad with exact subject', () => {
    const quads = getGenesisQuads();
    const networkQuad = quads.find(
      q => q.subject === 'did:dkg:network:v9-testnet' &&
           q.predicate === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' &&
           q.object === 'https://dkg.network/ontology#Network',
    );
    expect(networkQuad).toBeDefined();
  });

  it('includes system context graphs (agents and ontology)', () => {
    const quads = getGenesisQuads();
    const subjects = new Set(quads.map(q => q.subject));
    expect(subjects.has('did:dkg:context-graph:agents')).toBe(true);
    expect(subjects.has('did:dkg:context-graph:ontology')).toBe(true);
  });

  it('includes exactly the expected ontology class definitions', () => {
    const quads = getGenesisQuads();
    const classQuads = quads.filter(
      q => q.predicate === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' &&
           q.object === 'http://www.w3.org/2000/01/rdf-schema#Class',
    );
    const classNames = classQuads.map(q => q.subject).sort();
    expect(classNames).toEqual([
      'https://dkg.network/ontology#Agent',
      'https://dkg.network/ontology#CoreNode',
      'https://dkg.network/ontology#EdgeNode',
      'https://dkg.network/ontology#KnowledgeAsset',
      'https://dkg.network/ontology#KnowledgeCollection',
      'https://dkg.network/ontology#Network',
      'https://dkg.network/ontology#Paranet',
      'https://dkg.network/ontology#SystemParanet',
    ]);
  });

  it('is deterministic — same result on repeated calls', () => {
    const a = getGenesisQuads();
    const b = getGenesisQuads();
    expect(a).toEqual(b);
  });

  it('genesis content integrity check — hash detects any modification', () => {
    const raw = getGenesisRaw();
    const hash = sha256(new TextEncoder().encode(raw));
    const hex = Array.from(hash).map(b => b.toString(16).padStart(2, '0')).join('');
    expect(hex).toMatchSnapshot();
  });
});

describe('computeNetworkId', () => {
  it('returns a 64-character hex string (SHA-256)', async () => {
    const id = await computeNetworkId();
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic — same hash on repeated calls', async () => {
    const a = await computeNetworkId();
    const b = await computeNetworkId();
    expect(a).toBe(b);
  });

  it('matches a known golden value to detect accidental genesis changes', async () => {
    const id = await computeNetworkId();
    expect(id).toMatchSnapshot();
  });
});

describe('getGenesisRaw', () => {
  it('returns a TriG string with required content', () => {
    const raw = getGenesisRaw();
    expect(raw.length).toBeGreaterThan(0);
    expect(raw).toContain('@prefix dkg:');
    expect(raw).toContain('dkg:Network');
    expect(raw).toContain('did:dkg:network:v9-testnet');
    expect(raw).toContain('did:dkg:context-graph:agents');
    expect(raw).toContain('did:dkg:context-graph:ontology');
  });
});

describe('SYSTEM_CONTEXT_GRAPHS', () => {
  it('has AGENTS and ONTOLOGY keys', () => {
    expect(SYSTEM_CONTEXT_GRAPHS.AGENTS).toBe('agents');
    expect(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY).toBe('ontology');
  });
});

describe('DKG_ONTOLOGY', () => {
  it('has all expected keys with valid, full URI values', () => {
    const expectedUris: Record<string, string> = {
      RDF_TYPE: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
      SCHEMA_NAME: 'https://schema.org/name',
      SCHEMA_DESCRIPTION: 'https://schema.org/description',
      DKG_AGENT: 'https://dkg.network/ontology#Agent',
      DKG_CORE_NODE: 'https://dkg.network/ontology#CoreNode',
      DKG_EDGE_NODE: 'https://dkg.network/ontology#EdgeNode',
      DKG_PEER_ID: 'https://dkg.network/ontology#peerId',
      DKG_PUBLIC_KEY: 'https://dkg.network/ontology#publicKey',
      DKG_NODE_ROLE: 'https://dkg.network/ontology#nodeRole',
      DKG_RELAY_ADDRESS: 'https://dkg.network/ontology#relayAddress',
      DKG_CONTEXT_GRAPH: 'https://dkg.network/ontology#Paranet',
      DKG_SYSTEM_CONTEXT_GRAPH: 'https://dkg.network/ontology#SystemParanet',
      DKG_NETWORK: 'https://dkg.network/ontology#Network',
      DKG_NETWORK_ID: 'https://dkg.network/ontology#networkId',
      DKG_GENESIS_VERSION: 'https://dkg.network/ontology#genesisVersion',
    };

    for (const [key, expectedUri] of Object.entries(expectedUris)) {
      expect((DKG_ONTOLOGY as Record<string, string>)[key]).toBe(expectedUri);
    }

    const cclKeys = [
      'DKG_CCL_POLICY', 'DKG_POLICY_BINDING', 'DKG_POLICY_APPLIES_TO_PARANET',
      'DKG_POLICY_VERSION', 'DKG_POLICY_LANGUAGE', 'DKG_POLICY_FORMAT',
      'DKG_POLICY_HASH', 'DKG_POLICY_BODY', 'DKG_POLICY_STATUS',
      'DKG_POLICY_CONTEXT_TYPE', 'DKG_ACTIVE_POLICY', 'DKG_APPROVED_BY',
      'DKG_APPROVED_AT', 'DKG_CCL_EVALUATION', 'DKG_CCL_RESULT_ENTRY',
      'DKG_EVALUATED_POLICY', 'DKG_FACT_SET_HASH', 'DKG_FACT_QUERY_HASH',
      'DKG_FACT_RESOLVER_VERSION', 'DKG_FACT_RESOLUTION_MODE', 'DKG_SCOPE_UAL',
      'DKG_VIEW', 'DKG_SNAPSHOT_ID', 'DKG_RESULT_KIND', 'DKG_RESULT_NAME',
      'DKG_HAS_RESULT', 'DKG_CCL_RESULT_ARG',
      'DKG_HAS_RESULT_ARG', 'DKG_RESULT_ARG_INDEX', 'DKG_RESULT_ARG_VALUE',
    ];
    for (const key of cclKeys) {
      expect((DKG_ONTOLOGY as Record<string, string>)[key]).toBeDefined();
      expect((DKG_ONTOLOGY as Record<string, string>)[key]).toMatch(/^https?:\/\//);
    }
  });

  it('all values are unique URIs (excluding deprecated alias keys that mirror canonical URIs)', () => {
    const deprecatedAliasKeys = new Set(['DKG_PARANET', 'DKG_SYSTEM_PARANET']);
    const values = Object.entries(DKG_ONTOLOGY)
      .filter(([k]) => !deprecatedAliasKeys.has(k))
      .map(([, v]) => v);
    const uniqueValues = new Set(values);
    expect(uniqueValues.size).toBe(values.length);
  });
});
