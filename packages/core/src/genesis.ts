/**
 * Genesis Knowledge — the DKG equivalent of a blockchain genesis block.
 *
 * Every DKG network begins with a deterministic set of RDF triples loaded into
 * each node on first boot. The SHA-256 hash of the genesis content serves as
 * the networkId, ensuring only nodes with identical genesis can peer.
 */

const GENESIS_AGENTS_GRAPH = 'did:dkg:context-graph:agents';
const GENESIS_ONTOLOGY_GRAPH = 'did:dkg:context-graph:ontology';
export const DEFAULT_GENESIS_ID = 'base-testnet';

interface GenesisNetworkDefinition {
  subject: string;
  name: string;
  createdAt: string;
  systemContextGraphs: readonly string[];
}

const GENESIS_NETWORKS = {
  'base-testnet': {
    subject: 'did:dkg:network:v9-testnet',
    name: 'DKG V9 Testnet',
    createdAt: '2026-02-24T00:00:00Z',
    systemContextGraphs: [GENESIS_AGENTS_GRAPH, GENESIS_ONTOLOGY_GRAPH],
  },
  'base-mainnet': {
    subject: 'did:dkg:network:base-mainnet',
    name: 'DKG V10 Base Mainnet',
    createdAt: '2026-06-20T00:00:00Z',
    systemContextGraphs: [GENESIS_AGENTS_GRAPH, GENESIS_ONTOLOGY_GRAPH],
  },
  'gnosis-mainnet': {
    subject: 'did:dkg:network:gnosis-mainnet',
    name: 'DKG V10 Gnosis Mainnet',
    createdAt: '2026-06-20T00:00:00Z',
    systemContextGraphs: [GENESIS_AGENTS_GRAPH, GENESIS_ONTOLOGY_GRAPH],
  },
  'neuroweb-mainnet': {
    subject: 'did:dkg:network:neuroweb-mainnet',
    name: 'DKG V10 NeuroWeb Mainnet',
    createdAt: '2026-06-20T00:00:00Z',
    systemContextGraphs: [GENESIS_AGENTS_GRAPH, GENESIS_ONTOLOGY_GRAPH],
  },
} satisfies Record<string, GenesisNetworkDefinition>;

export type GenesisId = keyof typeof GENESIS_NETWORKS;

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
const DCT  = 'http://purl.org/dc/terms/';
const DCAT = 'http://www.w3.org/ns/dcat#';

function q(graph: string, s: string, p: string, o: string): GenesisQuad {
  return { subject: s, predicate: p, object: o, graph };
}

function getGenesisNetwork(genesisId: string): GenesisNetworkDefinition {
  const network = GENESIS_NETWORKS[genesisId as GenesisId];
  if (!network) {
    throw new Error(`Unknown genesisId: ${genesisId}`);
  }
  return network;
}

function buildGenesisQuads(genesisId: string): GenesisQuad[] {
  const quads: GenesisQuad[] = [];
  const DEFAULT = '';
  const AG = GENESIS_AGENTS_GRAPH;
  const OG = GENESIS_ONTOLOGY_GRAPH;
  const network = getGenesisNetwork(genesisId);

  // --- Default graph: network definition ---
  quads.push(q(DEFAULT, network.subject, `${RDF}type`, `${DKG}Network`));
  quads.push(q(DEFAULT, network.subject, `${SCHEMA}name`, `"${network.name}"`));
  quads.push(q(DEFAULT, network.subject, `${DKG}genesisVersion`, '"1"'));
  quads.push(q(DEFAULT, network.subject, `${DKG}createdAt`, `"${network.createdAt}"`));
  for (const graph of network.systemContextGraphs) {
    quads.push(q(DEFAULT, network.subject, `${DKG}systemContextGraphs`, graph));
  }

  // --- Agents contextGraph definition ---
  quads.push(q(AG, 'did:dkg:context-graph:agents', `${RDF}type`, `${DKG}ContextGraph`));
  quads.push(q(AG, 'did:dkg:context-graph:agents', `${RDF}type`, `${DKG}SystemContextGraph`));
  quads.push(q(AG, 'did:dkg:context-graph:agents', `${SCHEMA}name`, '"Agent Registry"'));
  quads.push(q(AG, 'did:dkg:context-graph:agents', `${SCHEMA}description`, '"System contextGraph for agent discovery and profiles"'));
  quads.push(q(AG, 'did:dkg:context-graph:agents', `${DKG}gossipTopic`, '"dkg/context-graph/agents/finalization"'));
  quads.push(q(AG, 'did:dkg:context-graph:agents', `${DKG}replicationPolicy`, '"full"'));

  // --- Ontology contextGraph definition ---
  quads.push(q(OG, 'did:dkg:context-graph:ontology', `${RDF}type`, `${DKG}ContextGraph`));
  quads.push(q(OG, 'did:dkg:context-graph:ontology', `${RDF}type`, `${DKG}SystemContextGraph`));
  quads.push(q(OG, 'did:dkg:context-graph:ontology', `${SCHEMA}name`, '"Ontology Registry"'));
  quads.push(q(OG, 'did:dkg:context-graph:ontology', `${SCHEMA}description`, '"System contextGraph for shared ontology and contextGraph definitions"'));
  quads.push(q(OG, 'did:dkg:context-graph:ontology', `${DKG}gossipTopic`, '"dkg/context-graph/ontology/finalization"'));
  quads.push(q(OG, 'did:dkg:context-graph:ontology', `${DKG}replicationPolicy`, '"full"'));

  // --- Ontology class definitions ---
  quads.push(q(OG, `${DKG}Network`,              `${RDF}type`, `${RDFS}Class`));
  quads.push(q(OG, `${DKG}ContextGraph`,              `${RDF}type`, `${RDFS}Class`));
  quads.push(q(OG, `${DKG}SystemContextGraph`,        `${RDF}type`, `${RDFS}Class`));
  quads.push(q(OG, `${DKG}SystemContextGraph`,        `${RDFS}subClassOf`, `${DKG}ContextGraph`));
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
  quads.push(q(OG, `${DKG}contextGraph`,           `${RDF}type`, `${RDF}Property`));
  quads.push(q(OG, `${DKG}gossipTopic`,       `${RDF}type`, `${RDF}Property`));
  quads.push(q(OG, `${DKG}relayAddress`,      `${RDF}type`, `${RDF}Property`));
  quads.push(q(OG, `${DKG}genesisVersion`,    `${RDF}type`, `${RDF}Property`));
  quads.push(q(OG, `${DKG}networkId`,         `${RDF}type`, `${RDF}Property`));

  return quads;
}

const _cachedQuads = new Map<string, GenesisQuad[]>();
const _cachedNetworkIds = new Map<string, string>();

export function getGenesisQuads(genesisId: string = DEFAULT_GENESIS_ID): GenesisQuad[] {
  const cached = _cachedQuads.get(genesisId);
  if (cached) {
    return cached;
  }
  const quads = buildGenesisQuads(genesisId);
  _cachedQuads.set(genesisId, quads);
  return quads;
}

/**
 * Canonical representation of genesis for hashing.
 * Sorted N-Quads lines to ensure deterministic output.
 */
function canonicalGenesisString(genesisId: string): string {
  const quads = getGenesisQuads(genesisId);
  const lines = quads.map(q => {
    const s = q.subject.startsWith('"') ? q.subject : `<${q.subject}>`;
    const p = `<${q.predicate}>`;
    const o = q.object.startsWith('"') ? q.object : `<${q.object}>`;
    const g = q.graph ? `<${q.graph}>` : '';
    return g ? `${s} ${p} ${o} ${g} .` : `${s} ${p} ${o} .`;
  });
  return lines.sort().join('\n');
}

export async function computeNetworkId(genesisId: string = DEFAULT_GENESIS_ID): Promise<string> {
  const cached = _cachedNetworkIds.get(genesisId);
  if (cached) return cached;

  const data = new TextEncoder().encode(canonicalGenesisString(genesisId));
  const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', data);
  const hashArray = new Uint8Array(hashBuffer);
  const hex = Array.from(hashArray).map(b => b.toString(16).padStart(2, '0')).join('');
  _cachedNetworkIds.set(genesisId, hex);
  return hex;
}

function buildGenesisRaw(network: GenesisNetworkDefinition): string {
  const systemContextGraphLines = network.systemContextGraphs
    .map((graph, index) => {
      const terminator = index === network.systemContextGraphs.length - 1 ? '.' : ';';
      return `    dkg:systemContextGraphs <${graph}> ${terminator}`;
    })
    .join('\n');

  return `\
@prefix dkg:     <https://dkg.network/ontology#> .
@prefix erc8004: <https://eips.ethereum.org/erc-8004#> .
@prefix prov:    <http://www.w3.org/ns/prov#> .
@prefix schema:  <https://schema.org/> .
@prefix rdfs:    <http://www.w3.org/2000/01/rdf-schema#> .
@prefix rdf:     <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix xsd:     <http://www.w3.org/2001/XMLSchema#> .

<${network.subject}>
    a dkg:Network ;
    schema:name "${network.name}" ;
    dkg:genesisVersion "1"^^xsd:integer ;
    dkg:createdAt "${network.createdAt}"^^xsd:dateTime ;
${systemContextGraphLines}
`;
}

export function getGenesisRaw(genesisId: string = DEFAULT_GENESIS_ID): string {
  return buildGenesisRaw(getGenesisNetwork(genesisId));
}

export const SYSTEM_CONTEXT_GRAPHS = {
  AGENTS: 'agents',
  ONTOLOGY: 'ontology',
} as const;

/**
 * The agent registry (`agents`) system context graph is genesis-seeded and never
 * registered on-chain, so its profile publishes are always tentative and the
 * per-publish KC/KA `_meta` tracking record has no consumer — agent facts are
 * served from the DATA graph. Persisting that `_meta` on every heartbeat
 * (locally, and once per gossiped peer heartbeat) grows `agents/_meta` without
 * bound (#1233). The two highest-volume write paths gate on this single
 * predicate: the local publish terminal and the gossip publish receiver (the
 * dominant per-peer-heartbeat source). The remaining publisher paths — the
 * update restatement and the direct-protocol receive handler — are intentionally
 * deferred to a follow-up that prunes/bounds the record rather than skipping it,
 * because there the `_meta` is load-bearing (prior-root cleanup + the tentative
 * lifecycle). See #1233.
 */
export function isAgentRegistryContextGraph(contextGraphId: string): boolean {
  return contextGraphId === SYSTEM_CONTEXT_GRAPHS.AGENTS;
}

export const DKG_ONTOLOGY = {
  RDF_TYPE: `${RDF}type`,
  SCHEMA_NAME: `${SCHEMA}name`,
  SCHEMA_DESCRIPTION: `${SCHEMA}description`,
  DKG_AGENT: `${DKG}Agent`,
  DKG_CORE_NODE: `${DKG}CoreNode`,
  DKG_EDGE_NODE: `${DKG}EdgeNode`,
  DKG_PEER_ID: `${DKG}peerId`,
  DKG_PEER_ID_PROOF: `${DKG}peerIdProof`,
  DKG_LAST_SEEN: `${DKG}lastSeen`,
  DKG_PUBLIC_KEY: `${DKG}publicKey`,
  DKG_NODE_ROLE: `${DKG}nodeRole`,
  DKG_RELAY_ADDRESS: `${DKG}relayAddress`,
  DKG_CONTEXT_GRAPH: `${DKG}ContextGraph`,
  DKG_SYSTEM_CONTEXT_GRAPH: `${DKG}SystemContextGraph`,
  DKG_NETWORK: `${DKG}Network`,
  DKG_NETWORK_ID: `${DKG}networkId`,
  DKG_GENESIS_VERSION: `${DKG}genesisVersion`,
  DKG_CREATOR: `${DKG}creator`,
  DKG_CREATED_AT: `${DKG}createdAt`,
  DKG_GOSSIP_TOPIC: `${DKG}gossipTopic`,
  DKG_REPLICATION_POLICY: `${DKG}replicationPolicy`,
  DKG_ACCESS_POLICY: `${DKG}accessPolicy`,
  /**
   * On-chain contribution-policy dial (SPEC_CG_MEMORY_MODEL).
   *   "0" → curators-only (default; only allowedAgents may publish to VM)
   *   "1" → open (any wallet may publish to VM)
   * Persisted at create time so the deferred-registration path
   * (auto-register-on-first-VM-publish) preserves the user's create-
   * time choice. Without this triple, auto-register coerced
   * publishPolicy back to the access-policy-derived default and
   * silently broke valid combinations like curated-access + open-
   * contribution (Codex PR #610 fd5b31f1).
   */
  DKG_PUBLISH_POLICY: `${DKG}publishPolicy`,
  DKG_PARTICIPANT_IDENTITY_ID: `${DKG}participantIdentityId`,
  DKG_PARTICIPANT_AGENT: `${DKG}participantAgent`,
  DKG_PUBLISH_AUTHORITY_ACCOUNT_ID: `${DKG}publishAuthorityAccountId`,
  // Agent-signed delegation: when an agent (allowedAgent / participantAgent)
  // is approved, the join request carries an AgentDelegation naming the
  // node that hosts the agent. The curator persists those delegatee
  // identifiers alongside the agent so post-approval traffic from that
  // node can be authorised without the agent itself having to co-sign
  // every wire message. Both fields are optional individually but at
  // least one is recorded; sync auth allows on either match.
  DKG_ALLOWED_DELEGATEE_PEER: `${DKG}allowedDelegateePeer`,
  DKG_ALLOWED_DELEGATEE_KEY: `${DKG}allowedDelegateeKey`,
  DKG_DELEGATION_ISSUED_AT: `${DKG}delegationIssuedAt`,
  DKG_DELEGATION_EXPIRES_AT: `${DKG}delegationExpiresAt`,
  DKG_DELEGATION_AGENT: `${DKG}delegationAgent`,
  // Pending-side delegatee record carried on `did:dkg:join-request:*`
  // entities. Holds the SAME values the agent signed (so the curator
  // can re-verify the signature at approval time) but DOES NOT grant
  // access — only after approval do these get promoted into the
  // `allowedDelegatee*` triples on a `did:dkg:agent-delegation:*`
  // entity. Splitting predicates makes that boundary explicit and
  // prevents helpers from accidentally treating pending requests as
  // approved gates.
  DKG_DELEGATION_DELEGATEE_PEER: `${DKG}delegationDelegateePeer`,
  DKG_DELEGATION_DELEGATEE_KEY: `${DKG}delegationDelegateeKey`,
  DKG_CCL_POLICY: `${DKG}CCLPolicy`,
  DKG_POLICY_BINDING: `${DKG}PolicyBinding`,
  DKG_POLICY_APPLIES_TO_CONTEXT_GRAPH: `${DKG}appliesToContextGraph`,
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
  // verifiable public catalog entry for a private CG.
  // The private CG's public face is modeled as a DCAT dataset record (the
  // "_catalog" subgraph): a standards-compliant catalog entry any DCAT-aware
  // tool can discover, dual-typed with the dkg: class for native consumers.
  // Floor = type + identifier + accessRights only; opt-in tiers
  // (domain/blinded-anchors/aggregates/samples) are added explicitly by the
  // curator, never by default (the disclosure invariant).
  DCAT_DATASET: `${DCAT}Dataset`,                        // floor rdf:type (primary, interop)
  DCAT_DISTRIBUTION: `${DCAT}Distribution`,              // a representation of the dataset
  DCAT_DATA_SERVICE: `${DCAT}DataService`,               // access/grant endpoint as a service
  DCAT_CATALOG: `${DCAT}Catalog`,                        // the network-wide public discovery graph
  DCAT_DISTRIBUTION_PRED: `${DCAT}distribution`,         // dataset -> distribution
  DCAT_ACCESS_SERVICE: `${DCAT}accessService`,           // recommended: distribution/dataset -> DataService
  DCAT_ENDPOINT_URL: `${DCAT}endpointURL`,               // DataService -> grant endpoint
  DCAT_SERVES_DATASET: `${DCAT}servesDataset`,           // DataService -> dataset
  DCAT_KEYWORD: `${DCAT}keyword`,                        // opt-in T1: keywords
  DCAT_THEME: `${DCAT}theme`,                            // opt-in T1: coarse category
  // Standard EU access-right value: "RESTRICTED" = available under conditions
  // (members / grant), the precise fit for a curated CG.
  ACCESS_RIGHT_RESTRICTED: 'http://publications.europa.eu/resource/authority/access-right/RESTRICTED',
  DKG_PRIVATE_CONTEXT_GRAPH: `${DKG}PrivateContextGraph`, // floor rdf:type (dkg-native, dual-typed with dcat:Dataset)
  DKG_COMMITTED_ROOT: `${DKG}committedRoot`,              // separate-KA model only: links facet KA to the CG's VM root (combined model omits it)
  DKG_BLINDED_ANCHOR: `${DKG}blindedAnchor`,             // opt-in T2: HMAC(cgSecret, entityId) join key
  DCT_IDENTIFIER: `${DCT}identifier`,                     // floor: the CG's UAL
  DCT_ACCESS_RIGHTS: `${DCT}accessRights`,                // floor: -> ACCESS_RIGHT_RESTRICTED
  DCT_PUBLISHER: `${DCT}publisher`,                       // recommended: controlling identity (MAY be per-CG pseudonym)
  DCT_CONFORMS_TO: `${DCT}conformsTo`,                    // opt-in T1: ontology/domain
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
  DKG_REGISTRATION_STATUS: `${DKG}registrationStatus`,
  DKG_CURATOR: `${DKG}curator`,
  DKG_ALLOWED_PEER: `${DKG}allowedPeer`,
  DKG_ALLOWED_AGENT: `${DKG}allowedAgent`,
  // Local-only tombstone for an agent revoked from a curated CG.
  // Subject = the CG URI; object = the revoked agent address literal
  // (same shape as DKG_ALLOWED_AGENT). The recipient resolver subtracts
  // this set from the union of allowed/participant agents so a curator
  // can lock out a member even when peer sync has re-replicated the
  // original `DKG_ALLOWED_AGENT` triple from another node's local copy
  // of the CG metadata. Tombstone is intentionally NOT gossiped — the
  // curator's local store is authoritative for sender-key membership
  // on the curator's writes; remote nodes maintain their own tombstones
  // independently (and learn about the revocation through the absence
  // of future sender-key packages for the revoked agent).
  DKG_REVOKED_AGENT: `${DKG}revokedAgent`,
  DKG_AGENT_ADDRESS: `${DKG}agentAddress`,
  DKG_AGENT_MODE: `${DKG}agentMode`,
  DKG_PUBLIC_ENCRYPTION_KEY: `${DKG}publicEncryptionKey`,
  DKG_ENCRYPTION_KEY_ALGORITHM: `${DKG}encryptionKeyAlgorithm`,
  DKG_ENCRYPTION_KEY_PROOF: `${DKG}encryptionKeyProof`,
  // Wallet-signed revocation of a previously registered workspace encryption key.
  // Subject = the key URI from `workspaceAgentEncryptionKeyId(addr, pubBytes)`.
  // Authentication: ecrecover of the EIP-191 hash of
  // `computeWorkspaceAgentEncryptionKeyRevocationPayload({ agentAddress, algorithm, publicKeyBytes, revokedAt })`
  // must equal the agent's wallet address. Authorisation reuses the existing
  // `DKG_REVOKED_BY`/`DKG_REVOKED_AT` predicates on that same subject.
  DKG_ENCRYPTION_KEY_REVOCATION_PROOF: `${DKG}encryptionKeyRevocationProof`,
  DKG_AGENT_AUTH_TOKEN: `${DKG}agentAuthToken`,
  // RFC-001 §5.2 — off-chain author-attestation provenance vocabulary.
  // These are pure SPARQL-filtering convenience triples; the on-chain
  // `KnowledgeBatch.authorAddress` remains canonical. Implementations that
  // don't need rich provenance queries MAY skip emitting these triples.
  DKG_PUBLICATION: `${DKG}Publication`,
  DKG_PUBLISH_OPERATION_ID: `${DKG}publishOperationId`,
  DKG_AUTHORED_BY: `${DKG}authoredBy`,
} as const;
