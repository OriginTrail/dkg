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
    dkg:systemParanets <did:dkg:paranet:agents> ;
    dkg:systemParanets <did:dkg:paranet:ontology> .
`;

const GENESIS_AGENTS_GRAPH = 'did:dkg:paranet:agents';
const GENESIS_ONTOLOGY_GRAPH = 'did:dkg:paranet:ontology';

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
  quads.push(q(DEFAULT, 'did:dkg:network:v9-testnet', `${DKG}systemParanets`, `did:dkg:paranet:agents`));
  quads.push(q(DEFAULT, 'did:dkg:network:v9-testnet', `${DKG}systemParanets`, `did:dkg:paranet:ontology`));

  // --- Agents paranet definition ---
  quads.push(q(AG, 'did:dkg:paranet:agents', `${RDF}type`, `${DKG}Paranet`));
  quads.push(q(AG, 'did:dkg:paranet:agents', `${RDF}type`, `${DKG}SystemParanet`));
  quads.push(q(AG, 'did:dkg:paranet:agents', `${SCHEMA}name`, '"Agent Registry"'));
  quads.push(q(AG, 'did:dkg:paranet:agents', `${SCHEMA}description`, '"System paranet for agent discovery and profiles"'));
  quads.push(q(AG, 'did:dkg:paranet:agents', `${DKG}gossipTopic`, '"dkg/paranet/agents/publish"'));
  quads.push(q(AG, 'did:dkg:paranet:agents', `${DKG}replicationPolicy`, '"full"'));

  // --- Ontology definitions ---
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

export const SYSTEM_PARANETS = {
  AGENTS: 'agents',
  ONTOLOGY: 'ontology',
} as const;

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
  DKG_PARANET: `${DKG}Paranet`,
  DKG_NETWORK: `${DKG}Network`,
  DKG_NETWORK_ID: `${DKG}networkId`,
  DKG_GENESIS_VERSION: `${DKG}genesisVersion`,
  ERC8004_CAPABILITY: `${ERC8004}Capability`,
  ERC8004_CAPABILITIES: `${ERC8004}capabilities`,
  PROV_GENERATED_BY: `${PROV}wasGeneratedBy`,
  PROV_ACTIVITY: `${PROV}Activity`,
  PROV_AT_TIME: `${PROV}atTime`,
  SKILL_OFFERS: 'https://dkg.origintrail.io/skill#offersSkill',
  SKILL_FRAMEWORK: 'https://dkg.origintrail.io/skill#framework',
} as const;
