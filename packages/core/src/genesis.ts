/**
 * Genesis Knowledge — the DKG equivalent of a blockchain genesis block.
 *
 * Every DKG network begins with a deterministic set of RDF triples loaded into
 * each node on first boot. The SHA-256 hash of the genesis content serves as
 * the networkId, ensuring only nodes with identical genesis can peer.
 */

const GENESIS_TRIG = `\
@prefix dkg:     <https://dkg.network/ontology#> .
@prefix erc8004: <https://eips.ethereum.org/erc-8004#> .
@prefix prov:    <http://www.w3.org/ns/prov#> .
@prefix schema:  <https://schema.org/> .
@prefix rdfs:    <http://www.w3.org/2000/01/rdf-schema#> .
@prefix rdf:     <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix xsd:     <http://www.w3.org/2001/XMLSchema#> .

<did:dkg:network:v9-testnet>
    a dkg:Network ;
    schema:name "DKG V9 Testnet" ;
    dkg:genesisVersion "1"^^xsd:integer ;
    dkg:createdAt "2026-02-24T00:00:00Z"^^xsd:dateTime ;
    dkg:systemParanets <did:dkg:context-graph:agents> ;
    dkg:systemParanets <did:dkg:context-graph:ontology> .
`;

const GENESIS_AGENTS_GRAPH = 'did:dkg:context-graph:agents';
const GENESIS_ONTOLOGY_GRAPH = 'did:dkg:context-graph:ontology';

export interface GenesisQuad {
  subject: string;
  predicate: string;
  object: string;
  graph: string;
}

const RDF  = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const XSD  = 'http://www.w3.org/2001/XMLSchema#';
const SCHEMA = 'https://schema.org/';
const DKG  = 'https://dkg.network/ontology#';
const ERC8004 = 'https://eips.ethereum.org/erc-8004#';
const PROV = 'http://www.w3.org/ns/prov#';

function q(graph: string, s: string, p: string, o: string): GenesisQuad {
  return { subject: s, predicate: p, object: o, graph };
}

function buildGenesisQuads(): GenesisQuad[] {
  const quads: GenesisQuad[] = [];
  const DEFAULT = '';
  const AG = GENESIS_AGENTS_GRAPH;
  const OG = GENESIS_ONTOLOGY_GRAPH;

  // --- Default graph: network definition ---
  quads.push(q(DEFAULT, 'did:dkg:network:v9-testnet', `${RDF}type`, `${DKG}Network`));
  quads.push(q(DEFAULT, 'did:dkg:network:v9-testnet', `${SCHEMA}name`, '"DKG V9 Testnet"'));
  quads.push(q(DEFAULT, 'did:dkg:network:v9-testnet', `${DKG}genesisVersion`, '"1"'));
  quads.push(q(DEFAULT, 'did:dkg:network:v9-testnet', `${DKG}createdAt`, '"2026-02-24T00:00:00Z"'));
  quads.push(q(DEFAULT, 'did:dkg:network:v9-testnet', `${DKG}systemParanets`, `did:dkg:context-graph:agents`));
  quads.push(q(DEFAULT, 'did:dkg:network:v9-testnet', `${DKG}systemParanets`, `did:dkg:context-graph:ontology`));

  // --- Agents paranet definition ---
  quads.push(q(AG, 'did:dkg:context-graph:agents', `${RDF}type`, `${DKG}Paranet`));
  quads.push(q(AG, 'did:dkg:context-graph:agents', `${RDF}type`, `${DKG}SystemParanet`));
  quads.push(q(AG, 'did:dkg:context-graph:agents', `${SCHEMA}name`, '"Agent Registry"'));
  quads.push(q(AG, 'did:dkg:context-graph:agents', `${SCHEMA}description`, '"System paranet for agent discovery and profiles"'));
  quads.push(q(AG, 'did:dkg:context-graph:agents', `${DKG}gossipTopic`, '"dkg/paranet/agents/publish"'));
  quads.push(q(AG, 'did:dkg:context-graph:agents', `${DKG}replicationPolicy`, '"full"'));

  // --- Ontology paranet definition ---
  quads.push(q(OG, 'did:dkg:context-graph:ontology', `${RDF}type`, `${DKG}Paranet`));
  quads.push(q(OG, 'did:dkg:context-graph:ontology', `${RDF}type`, `${DKG}SystemParanet`));
  quads.push(q(OG, 'did:dkg:context-graph:ontology', `${SCHEMA}name`, '"Ontology Registry"'));
  quads.push(q(OG, 'did:dkg:context-graph:ontology', `${SCHEMA}description`, '"System paranet for shared ontology and paranet definitions"'));
  quads.push(q(OG, 'did:dkg:context-graph:ontology', `${DKG}gossipTopic`, '"dkg/paranet/ontology/publish"'));
  quads.push(q(OG, 'did:dkg:context-graph:ontology', `${DKG}replicationPolicy`, '"full"'));

  // --- Ontology class definitions ---
  quads.push(q(OG, `${DKG}Network`,              `${RDF}type`, `${RDFS}Class`));
  quads.push(q(OG, `${DKG}Paranet`,              `${RDF}type`, `${RDFS}Class`));
  quads.push(q(OG, `${DKG}SystemParanet`,        `${RDF}type`, `${RDFS}Class`));
  quads.push(q(OG, `${DKG}SystemParanet`,        `${RDFS}subClassOf`, `${DKG}Paranet`));
  quads.push(q(OG, `${DKG}Agent`,                `${RDF}type`, `${RDFS}Class`));
  quads.push(q(OG, `${DKG}Agent`,                `${RDFS}subClassOf`, `${ERC8004}Agent`));
  quads.push(q(OG, `${DKG}Agent`,                `${RDFS}subClassOf`, `${PROV}Agent`));
  quads.push(q(OG, `${DKG}CoreNode`,             `${RDF}type`, `${RDFS}Class`));
  quads.push(q(OG, `${DKG}CoreNode`,             `${RDFS}subClassOf`, `${DKG}Agent`));
  quads.push(q(OG, `${DKG}EdgeNode`,             `${RDF}type`, `${RDFS}Class`));
  quads.push(q(OG, `${DKG}EdgeNode`,             `${RDFS}subClassOf`, `${DKG}Agent`));
  quads.push(q(OG, `${DKG}KnowledgeAsset`,       `${RDF}type`, `${RDFS}Class`));
  quads.push(q(OG, `${DKG}KnowledgeAsset`,       `${RDFS}subClassOf`, `${PROV}Entity`));
  quads.push(q(OG, `${DKG}KnowledgeCollection`,  `${RDF}type`, `${RDFS}Class`));

  // Properties
  quads.push(q(OG, `${DKG}peerId`,            `${RDF}type`, `${RDF}Property`));
  quads.push(q(OG, `${DKG}publicKey`,         `${RDF}type`, `${RDF}Property`));
  quads.push(q(OG, `${DKG}nodeRole`,          `${RDF}type`, `${RDF}Property`));
  quads.push(q(OG, `${DKG}paranet`,           `${RDF}type`, `${RDF}Property`));
  quads.push(q(OG, `${DKG}gossipTopic`,       `${RDF}type`, `${RDF}Property`));
  quads.push(q(OG, `${DKG}relayAddress`,      `${RDF}type`, `${RDF}Property`));
  quads.push(q(OG, `${DKG}genesisVersion`,    `${RDF}type`, `${RDF}Property`));
  quads.push(q(OG, `${DKG}networkId`,         `${RDF}type`, `${RDF}Property`));

  return quads;
}

let _cachedQuads: GenesisQuad[] | null = null;
let _cachedNetworkId: string | null = null;

export function getGenesisQuads(): GenesisQuad[] {
  if (!_cachedQuads) {
    _cachedQuads = buildGenesisQuads();
  }
  return _cachedQuads;
}

/**
 * Canonical representation of genesis for hashing.
 * Sorted N-Quads lines to ensure deterministic output.
 */
function canonicalGenesisString(): string {
  const quads = getGenesisQuads();
  const lines = quads.map(q => {
    const s = q.subject.startsWith('"') ? q.subject : `<${q.subject}>`;
    const p = `<${q.predicate}>`;
    const o = q.object.startsWith('"') ? q.object : `<${q.object}>`;
    const g = q.graph ? `<${q.graph}>` : '';
    return g ? `${s} ${p} ${o} ${g} .` : `${s} ${p} ${o} .`;
  });
  return lines.sort().join('\n');
}

export async function computeNetworkId(): Promise<string> {
  if (_cachedNetworkId) return _cachedNetworkId;

  const data = new TextEncoder().encode(canonicalGenesisString());
  const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', data);
  const hashArray = new Uint8Array(hashBuffer);
  const hex = Array.from(hashArray).map(b => b.toString(16).padStart(2, '0')).join('');
  _cachedNetworkId = hex;
  return hex;
}

export function getGenesisRaw(): string {
  return GENESIS_TRIG;
}

export const SYSTEM_CONTEXT_GRAPHS = {
  AGENTS: 'agents',
  ONTOLOGY: 'ontology',
} as const;

/** @deprecated Use SYSTEM_CONTEXT_GRAPHS */
export const SYSTEM_PARANETS = SYSTEM_CONTEXT_GRAPHS;

export const DKG_ONTOLOGY = {
  RDF_TYPE: `${RDF}type`,
  SCHEMA_NAME: `${SCHEMA}name`,
  SCHEMA_DESCRIPTION: `${SCHEMA}description`,
  DKG_AGENT: `${DKG}Agent`,
  DKG_CORE_NODE: `${DKG}CoreNode`,
  DKG_EDGE_NODE: `${DKG}EdgeNode`,
  DKG_PEER_ID: `${DKG}peerId`,
  DKG_PUBLIC_KEY: `${DKG}publicKey`,
  DKG_NODE_ROLE: `${DKG}nodeRole`,
  DKG_RELAY_ADDRESS: `${DKG}relayAddress`,
  DKG_CONTEXT_GRAPH: `${DKG}Paranet`,
  DKG_SYSTEM_CONTEXT_GRAPH: `${DKG}SystemParanet`,
  /** @deprecated Use DKG_CONTEXT_GRAPH */
  DKG_PARANET: `${DKG}Paranet`,
  /** @deprecated Use DKG_SYSTEM_CONTEXT_GRAPH */
  DKG_SYSTEM_PARANET: `${DKG}SystemParanet`,
  DKG_NETWORK: `${DKG}Network`,
  DKG_NETWORK_ID: `${DKG}networkId`,
  DKG_GENESIS_VERSION: `${DKG}genesisVersion`,
  DKG_CREATOR: `${DKG}creator`,
  DKG_CREATED_AT: `${DKG}createdAt`,
  DKG_GOSSIP_TOPIC: `${DKG}gossipTopic`,
  DKG_REPLICATION_POLICY: `${DKG}replicationPolicy`,
  DKG_ACCESS_POLICY: `${DKG}accessPolicy`,
  DKG_CCL_POLICY: `${DKG}CCLPolicy`,
  DKG_POLICY_BINDING: `${DKG}PolicyBinding`,
  DKG_POLICY_APPLIES_TO_PARANET: `${DKG}appliesToParanet`,
  DKG_POLICY_VERSION: `${DKG}policyVersion`,
  DKG_POLICY_LANGUAGE: `${DKG}policyLanguage`,
  DKG_POLICY_FORMAT: `${DKG}policyFormat`,
  DKG_POLICY_HASH: `${DKG}policyHash`,
  DKG_POLICY_BODY: `${DKG}policyBody`,
  DKG_POLICY_STATUS: `${DKG}policyStatus`,
  DKG_POLICY_CONTEXT_TYPE: `${DKG}contextType`,
  DKG_ACTIVE_POLICY: `${DKG}activePolicy`,
  DKG_POLICY_BINDING_STATUS: `${DKG}policyBindingStatus`,
  DKG_APPROVED_BY: `${DKG}approvedBy`,
  DKG_APPROVED_AT: `${DKG}approvedAt`,
  DKG_REVOKED_BY: `${DKG}revokedBy`,
  DKG_REVOKED_AT: `${DKG}revokedAt`,
  DKG_CCL_EVALUATION: `${DKG}CCLEvaluation`,
  DKG_CCL_RESULT_ENTRY: `${DKG}CCLResultEntry`,
  DKG_EVALUATED_POLICY: `${DKG}evaluatedPolicy`,
  DKG_FACT_SET_HASH: `${DKG}factSetHash`,
  DKG_FACT_QUERY_HASH: `${DKG}factQueryHash`,
  DKG_FACT_RESOLVER_VERSION: `${DKG}factResolverVersion`,
  DKG_FACT_RESOLUTION_MODE: `${DKG}factResolutionMode`,
  DKG_SCOPE_UAL: `${DKG}scopeUal`,
  DKG_VIEW: `${DKG}view`,
  DKG_SNAPSHOT_ID: `${DKG}snapshotId`,
  DKG_RESULT_KIND: `${DKG}resultKind`,
  DKG_RESULT_NAME: `${DKG}resultName`,
  DKG_HAS_RESULT: `${DKG}hasResult`,
  DKG_CCL_RESULT_ARG: `${DKG}CCLResultArg`,
  DKG_HAS_RESULT_ARG: `${DKG}hasResultArg`,
  DKG_RESULT_ARG_INDEX: `${DKG}resultArgIndex`,
  DKG_RESULT_ARG_VALUE: `${DKG}resultArgValue`,
  ERC8004_CAPABILITY: `${ERC8004}Capability`,
  ERC8004_CAPABILITIES: `${ERC8004}capabilities`,
  PROV_GENERATED_BY: `${PROV}wasGeneratedBy`,
  PROV_ACTIVITY: `${PROV}Activity`,
  PROV_ASSOCIATED_WITH: `${PROV}wasAssociatedWith`,
  PROV_AT_TIME: `${PROV}atTime`,
  PROV_ENDED_AT_TIME: `${PROV}endedAtTime`,
  DKG_ENDORSES: `${DKG}endorses`,
  DKG_ENDORSED_AT: `${DKG}endorsedAt`,
  SKILL_OFFERS: 'https://dkg.origintrail.io/skill#offersSkill',
  SKILL_FRAMEWORK: 'https://dkg.origintrail.io/skill#framework',
} as const;
