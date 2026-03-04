import type { TripleStore, Quad } from '@dkg/storage';
import type { ChainAdapter } from '@dkg/chain';
import { contextGraphDataUri } from '@dkg/core';
import { ProofIndex, type TripleProof } from './proof-index.js';

export interface VerificationInfo {
  chainId: string;
  knowledgeAssetsStorageAddress?: string;
  contextGraphStorageAddress?: string;
  contextGraphId: string;
  batchIds: string[];
  merkleRoots: Record<string, string>;
}

export interface ProvedTriple {
  subject: string;
  predicate: string;
  object: string;
  proof: TripleProof;
}

export interface EntityLookupResult {
  contextGraphId: string;
  paranetId: string;
  entity: string;
  triples: ProvedTriple[];
  verification: VerificationInfo;
}

export interface QueryWithProofsResult {
  contextGraphId: string;
  paranetId: string;
  bindings: Array<Record<string, string>>;
  provenanceTriples: ProvedTriple[];
  verification: VerificationInfo;
}

export interface TripleExistenceResult {
  exists: boolean;
  triple?: { subject: string; predicate: string; object: string };
  proof?: TripleProof;
  verification?: VerificationInfo;
}

/**
 * Context Oracle: a verifiable read layer on top of Context Graphs.
 *
 * Serves query results with Merkle inclusion proofs that can be verified
 * against on-chain state without trusting the oracle node.
 */
export class ContextOracle {
  private readonly store: TripleStore;
  private readonly chain: ChainAdapter;
  readonly proofIndex: ProofIndex;

  constructor(store: TripleStore, chain: ChainAdapter, proofIndex?: ProofIndex) {
    this.store = store;
    this.chain = chain;
    this.proofIndex = proofIndex ?? new ProofIndex();
  }

  /**
   * Lookup all triples about an entity in a context graph, with Merkle proofs.
   */
  async entityLookup(
    paranetId: string,
    contextGraphId: string,
    entityUri: string,
  ): Promise<EntityLookupResult> {
    const graphUri = contextGraphDataUri(paranetId, contextGraphId);

    const result = await this.store.query(`
      SELECT ?s ?p ?o WHERE {
        GRAPH <${graphUri}> {
          ?s ?p ?o .
          FILTER(
            ?s = <${entityUri}>
            || STRSTARTS(STR(?s), "${entityUri}/.well-known/genid/")
          )
        }
      }
    `);

    const quads: Quad[] = result.type === 'bindings'
      ? result.bindings.map(row => ({
          subject: row['s'], predicate: row['p'], object: row['o'], graph: graphUri,
        }))
      : [];

    const provedTriples = this.attachProofs(contextGraphId, quads);
    const batchIds = uniqueBatchIds(provedTriples);

    return {
      contextGraphId,
      paranetId,
      entity: entityUri,
      triples: provedTriples,
      verification: this.buildVerification(contextGraphId, batchIds),
    };
  }

  /**
   * Execute a SPARQL query scoped to a context graph and attach proofs
   * to every triple that contributed to the result.
   */
  async queryWithProofs(
    paranetId: string,
    contextGraphId: string,
    sparql: string,
  ): Promise<QueryWithProofsResult> {
    const graphUri = contextGraphDataUri(paranetId, contextGraphId);

    // Execute the user's SELECT query, scoped to the context graph
    const wrappedSparql = wrapWithGraph(sparql, graphUri);
    const selectResult = await this.store.query(wrappedSparql);
    const bindings = selectResult.type === 'bindings' ? selectResult.bindings : [];

    // Extract provenance: run a CONSTRUCT to get the actual triples
    const constructSparql = selectToConstruct(sparql, graphUri);
    const constructResult = await this.store.query(constructSparql);
    const quads: Quad[] = constructResult.type === 'quads'
      ? constructResult.quads
      : constructResult.type === 'bindings'
        ? constructResult.bindings.map(row => ({
            subject: row['s'], predicate: row['p'], object: row['o'], graph: graphUri,
          }))
        : [];

    const provedTriples = this.attachProofs(contextGraphId, quads);
    const batchIds = uniqueBatchIds(provedTriples);

    return {
      contextGraphId,
      paranetId,
      bindings,
      provenanceTriples: provedTriples,
      verification: this.buildVerification(contextGraphId, batchIds),
    };
  }

  /**
   * Prove that a specific triple exists in a context graph.
   */
  async proveTriple(
    paranetId: string,
    contextGraphId: string,
    subject: string,
    predicate: string,
    object: string,
  ): Promise<TripleExistenceResult> {
    const graphUri = contextGraphDataUri(paranetId, contextGraphId);

    // Check existence in the triple store
    const s = formatSparqlTerm(subject);
    const p = formatSparqlTerm(predicate);
    const o = formatSparqlTerm(object);
    const askResult = await this.store.query(
      `ASK { GRAPH <${graphUri}> { ${s} ${p} ${o} } }`,
    );

    const exists = askResult.type === 'boolean' ? askResult.value : false;
    if (!exists) {
      return { exists: false };
    }

    const proof = this.proofIndex.generateProof(contextGraphId, subject, predicate, object);
    if (!proof) {
      return { exists: true, triple: { subject, predicate, object } };
    }

    return {
      exists: true,
      triple: { subject, predicate, object },
      proof,
      verification: this.buildVerification(contextGraphId, [proof.batchId]),
    };
  }

  private attachProofs(contextGraphId: string, quads: Quad[]): ProvedTriple[] {
    const results: ProvedTriple[] = [];
    for (const q of quads) {
      const proof = this.proofIndex.generateProof(
        contextGraphId, q.subject, q.predicate, q.object,
      );
      if (proof) {
        results.push({
          subject: q.subject,
          predicate: q.predicate,
          object: q.object,
          proof,
        });
      }
    }
    return results;
  }

  private buildVerification(contextGraphId: string, batchIds: string[]): VerificationInfo {
    return {
      chainId: this.chain.chainId,
      contextGraphId,
      batchIds,
      merkleRoots: this.proofIndex.getMerkleRoots(contextGraphId, batchIds),
    };
  }
}

function uniqueBatchIds(triples: ProvedTriple[]): string[] {
  return [...new Set(triples.map(t => t.proof.batchId))];
}

function formatSparqlTerm(term: string): string {
  if (term.startsWith('"')) return term;
  if (term.startsWith('_:')) return term;
  if (term.startsWith('<')) return term;
  return `<${term}>`;
}

function wrapWithGraph(sparql: string, graphUri: string): string {
  if (sparql.toLowerCase().includes('graph ')) return sparql;

  const whereIdx = sparql.search(/WHERE\s*\{/i);
  if (whereIdx === -1) return sparql;

  const braceStart = sparql.indexOf('{', whereIdx);
  let depth = 0;
  let braceEnd = -1;
  for (let i = braceStart; i < sparql.length; i++) {
    if (sparql[i] === '{') depth++;
    else if (sparql[i] === '}') {
      depth--;
      if (depth === 0) { braceEnd = i; break; }
    }
  }
  if (braceEnd === -1) return sparql;

  const before = sparql.slice(0, braceStart + 1);
  const inner = sparql.slice(braceStart + 1, braceEnd);
  const after = sparql.slice(braceEnd);
  return `${before} GRAPH <${graphUri}> { ${inner} } ${after}`;
}

/**
 * Convert a SELECT query into a CONSTRUCT that returns the underlying triples.
 * This is a best-effort transform for extracting provenance triples.
 */
function selectToConstruct(sparql: string, graphUri: string): string {
  const whereMatch = sparql.match(/WHERE\s*\{([\s\S]*)\}/i);
  if (!whereMatch) return sparql;

  const body = whereMatch[1].trim();
  return `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graphUri}> { ?s ?p ?o . { ${body} } } }`;
}
