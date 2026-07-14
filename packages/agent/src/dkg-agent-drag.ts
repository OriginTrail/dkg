/**
 * dRAG answer methods (OT-RFC-55 P2 — single-node `dkg_answer`).
 *
 * `dragAnswerLocal` turns a natural-language question into a grounded, CITED
 * answer over the verifiable-memory of one Context Graph held on THIS node:
 *
 *   question → keyword retrieval over per-KA VM graphs → canonical triples →
 *   a {@link VerifiableCitation} per cited fact (Merkle + live chain anchor,
 *   with an author seal when available).
 *
 * V1 retrieval is KEYWORD/STRUCTURAL — no LLM is required, which is the
 * demoable baseline (LLM synthesis is an optional enhancement, gated on a
 * configured model; see `llm` in the result). The headline guarantee is the
 * audit trail: every fact in the answer is bound to a sealed, on-chain-anchored
 * Knowledge Asset the caller can independently verify.
 */

import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import {
  prepareKaCitation,
  citeTriple,
  verifyVerifiableCitation,
  type CitationChainReads,
  type PreparedKaCitation,
} from './drag/citation.js';
import { PROTOCOL_DRAG_ANSWER, validateContextGraphId, isVerifiableCitationShape } from '@origintrail-official/dkg-core';
import type { VerifiableCitation, CitationTriple, CitationChecks } from '@origintrail-official/dkg-core';
import { buildKnowledgeAssetUal } from '@origintrail-official/dkg-chain';
import type { EntityRetrievalResult, EntityRetriever } from './drag/retriever.js';

/** Per-KA VM graph: `…/_verifiable_memory/<author>/<number>` → {author, number}. */
const VM_GRAPH_RE = /\/_verifiable_memory\/(0x[0-9a-fA-F]{40})\/(\d+)$/;

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with',
  'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'this', 'that', 'these', 'those',
  'it', 'its', 'they', 'them', 'their', 'which', 'who', 'whom', 'what', 'when', 'where', 'why',
  'how', 'do', 'does', 'did', 'has', 'have', 'had', 'can', 'could', 'should', 'would', 'will',
  'about', 'into', 'from', 'me', 'my', 'we', 'our', 'you', 'your', 'any', 'all', 'some',
]);

export interface DragFact {
  subject: string;
  predicate: string;
  object: string;
  /** Index (1-based) of the source KA in the citation list/UI source cards. */
  source: number;
}

export interface DragAnswerResult {
  question: string;
  contextGraphId: string;
  scope: 'local';
  /** Human-readable, grounded answer (keyword/structural; no LLM in V1). */
  answer: string;
  /** Whether an LLM synthesised the prose (false in the keyword baseline). */
  llm: boolean;
  /** Per-fact verifiable citations — independently auditable against the chain. */
  citations: VerifiableCitation[];
  facts: DragFact[];
  stats: {
    keywords: string[];
    kasMatched: number;
    factsCited: number;
    verified: number;
    retrieval: string;
    /** True when semantic retrieval was requested but the embedder could not run (no model) — distinguishes "unavailable" from "no matches". */
    retrievalDegraded?: boolean;
    /** End-to-end answer latency in ms (set by the route for observability). */
    latencyMs?: number;
  };
}

export interface DragPerNode {
  peerId: string;
  /** Facts the node returned (before dedup). */
  factsCited: number;
  /** Of those, how many the ASKER re-verified against the chain. */
  verified: number;
  error?: string;
}

export interface DragNetworkAnswerResult {
  question: string;
  contextGraphId: string;
  scope: 'network';
  answer: string;
  llm: boolean;
  /** Deduped citations, each RE-VERIFIED by the asker against its own chain. */
  citations: VerifiableCitation[];
  facts: DragFact[];
  perNode: DragPerNode[];
  stats: {
    keywords: string[];
    servingNodes: number;
    nodesAnswered: number;
    factsCited: number;
    verified: number;
    /** The asker proved both public policy and KA -> requested-CG membership. */
    scopeVerified: boolean;
    /** Remote citations rejected before they could become answer facts. */
    rejected: number;
    /** Remote citations left unexamined because a per-peer/global safety bound was reached. */
    notEvaluated: number;
    /** Serving peers not queried because the bounded fan-out was full. */
    peersSkipped: number;
    /** End-to-end answer latency in ms (set by the route for observability). */
    latencyMs?: number;
  };
}

export interface GatheredVerifiedFacts {
  facts: Array<{ triple: CitationTriple; citation: VerifiableCitation }>;
  /** False whenever a bound was hit or any graph/fact could not be verified. */
  complete: boolean;
  graphsSeen: number;
  graphsSkipped: number;
  truncated: boolean;
}

const MAX_FANOUT_PEERS = 12;
const MAX_CITATIONS_PER_PEER = 24;
const MAX_TOTAL_VERIFICATIONS = 96;
const FANOUT_CONCURRENCY = 4;
const MAX_REMOTE_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Extract content keywords from a question (lowercase, drop stopwords + short tokens). */
export function extractKeywords(question: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of question.toLowerCase().split(/[^a-z0-9]+/)) {
    const tok = raw.trim();
    if (tok.length < 3 || STOPWORDS.has(tok) || seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
    if (out.length >= 12) break;
  }
  return out;
}

/** Strip a namespace prefix for compact display (last path/hash segment). */
function shortPredicate(p: string): string {
  const m = p.match(/[/#]([^/#]+)$/);
  return m ? m[1] : p;
}

/** Strip N-Triples literal quoting / datatype / lang for display. */
function displayObject(o: string): string {
  const lit = o.match(/^"((?:[^"\\]|\\.)*)"(?:\^\^.*|@.*)?$/);
  if (lit) return lit[1].replace(/\\"/g, '"');
  const iri = o.match(/^<(.+)>$/);
  return iri ? iri[1] : o;
}

function objectMatchesKeyword(object: string, keywords: string[]): boolean {
  if (!object.startsWith('"')) return false; // literals only
  const lc = object.toLowerCase();
  return keywords.some((kw) => lc.includes(kw));
}

function isLiteralObject(object: string): boolean {
  return object.startsWith('"');
}

export class DragMethods extends DKGAgentBase {
  /**
   * Answer `question` over one Context Graph's verifiable memory on THIS node,
   * returning a grounded answer with a verifiable citation per cited fact.
   */
  async dragAnswerLocal(
    this: DKGAgent,
    args: {
      question: string;
      contextGraphId: string; // CG name
      maxCitations?: number;
      maxKas?: number;
    },
    opts?: { retriever?: EntityRetriever; forceKeyword?: boolean },
  ): Promise<DragAnswerResult> {
    const maxCitations = Math.min(Math.max(args.maxCitations ?? 12, 1), 50);
    const maxKas = Math.min(Math.max(args.maxKas ?? 25, 1), 100);
    const keywords = extractKeywords(args.question);
    // Vector retrieval if a retriever is available (per-request override, then
    // the daemon-attached one); else keyword. `forceKeyword` is the A/B control.
    const retriever = opts?.forceKeyword ? undefined : opts?.retriever ?? this.entityRetriever;

    const empty = (note: string, retrieval: string, retrievalDegraded = false): DragAnswerResult => ({
      question: args.question,
      contextGraphId: args.contextGraphId,
      scope: 'local',
      answer: note,
      llm: false,
      citations: [],
      facts: [],
      stats: { keywords, kasMatched: 0, factsCited: 0, verified: 0, retrieval, ...(retrievalDegraded ? { retrievalDegraded } : {}) },
    });

    // Validate the CG id before it is ever interpolated into a SPARQL literal.
    const idCheck = validateContextGraphId(args.contextGraphId);
    if (!idCheck.valid) return empty(`Invalid context graph id: ${idCheck.reason ?? 'rejected'}.`, 'none');

    // Resolve the CG's on-chain numeric id (needed by the KA extractor).
    const onChainIdStr = await this.getContextGraphOnChainId(args.contextGraphId).catch(() => null);
    if (!onChainIdStr || !/^\d+$/.test(onChainIdStr) || BigInt(onChainIdStr) === 0n) {
      return empty(
        `Context graph "${args.contextGraphId}" is not registered on-chain — verifiable citations require an anchored CG.`,
        'none',
      );
    }
    const cgOnChainId = BigInt(onChainIdStr);
    const vmPrefix = `did:dkg:context-graph:${args.contextGraphId}/_verifiable_memory/`;

    // ── Resolve "selections" = which (graph, entity?) to ground on. ──
    // Vector path yields entity-scoped selections (cite that entity's facts);
    // keyword path yields graph-only selections (cite keyword-matching triples).
    type Selection = { sourceGraph: string; entityUri?: string };
    let selections: Selection[] = [];
    let retrieval: string;

    if (retriever) {
      retrieval = `vector:${retriever.model}`;
      const { anchors, degraded } = await retriever
        .retrieve(args.question, args.contextGraphId, maxKas)
        .catch((): EntityRetrievalResult => ({ anchors: [], degraded: false }));
      const seen = new Set<string>();
      const anchorEntities: string[] = [];
      for (const a of anchors) {
        const key = `${a.sourceGraph}|${a.entityUri}`;
        if (seen.has(key)) continue;
        seen.add(key);
        selections.push({ sourceGraph: a.sourceGraph, entityUri: a.entityUri });
        anchorEntities.push(a.entityUri);
      }
      // 1-hop graph expansion: follow the anchors' object-IRIs to neighbour
      // entities that are themselves subjects in this CG's verifiable memory —
      // the "graph" in GraphRAG (semantic anchor → related entities).
      if (anchorEntities.length > 0) {
        for (const n of await this.dragExpandNeighbours(anchorEntities, vmPrefix, maxKas)) {
          const key = `${n.sourceGraph}|${n.entityUri}`;
          if (!seen.has(key)) {
            seen.add(key);
            selections.push(n);
          }
        }
      }
      if (selections.length === 0) {
        if (degraded) {
          return empty(
            `Semantic retrieval is unavailable on this node — no embedding model is reachable. ` +
              `Configure config.drag.embedder (e.g. a local Ollama via embedderBaseURL) or install the optional local model.`,
            retrieval,
            true,
          );
        }
        return empty(`No semantically-relevant entities found for "${args.question}".`, retrieval);
      }
    } else {
      retrieval = 'keyword';
      if (keywords.length === 0) return empty('No searchable keywords in the question.', retrieval);
      const kwFilter = keywords
        .map((kw) => `CONTAINS(LCASE(STR(?o)), "${kw.replace(/["\\]/g, '')}")`)
        .join(' || ');
      const sparql = `SELECT DISTINCT ?g ?s WHERE {
        GRAPH ?g { ?s ?p ?o . FILTER(isLiteral(?o)) FILTER(${kwFilter}) }
        FILTER(STRSTARTS(STR(?g), "${vmPrefix}"))
      } LIMIT ${maxKas}`;
      const result = await this.store.query(sparql);
      const matches =
        result.type === 'bindings'
          ? result.bindings
              .map((b) => ({
                sourceGraph: (b['g'] ?? '').replace(/^<|>$/g, ''),
                entityUri: (b['s'] ?? '').replace(/^<|>$/g, ''),
              }))
              .filter((x) => x.sourceGraph && x.entityUri)
          : [];
      if (matches.length === 0) return empty(`No verifiable facts found for: ${keywords.join(', ')}.`, retrieval);
      // A keyword hit selects the entity, not only the matching literal. This
      // keeps the relationship/"why" facts around that entity in the answer.
      selections = matches;
    }

    // ── Shared citation loop: per KA prepare once, cite the chosen triples. ──
    const chain: CitationChainReads = {
      getLatestMerkleRoot: (kaId) => this.chain.getLatestMerkleRoot!(kaId),
      getMerkleLeafCount: (kaId) => this.chain.getMerkleLeafCount!(kaId),
      getLatestMerkleRootAuthor: (kaId) => this.chain.getLatestMerkleRootAuthor!(kaId),
    };
    const chainId = await this.chain.getEvmChainId().catch(() => 0n);
    const deps = { store: this.store, chain, servingNode: this.peerId ?? 'local', chainId };

    const citations: VerifiableCitation[] = [];
    const facts: DragFact[] = [];
    const kaIndex = new Map<string, number>();
    const preparedCache = new Map<string, PreparedKaCitation>();
    const seenFact = new Set<string>();
    let kasMatched = 0;

    for (const sel of selections) {
      if (citations.length >= maxCitations) break;
      const m = sel.sourceGraph.match(VM_GRAPH_RE);
      if (!m) continue;
      const kaId = (BigInt(m[1]) << 96n) | BigInt(m[2]);
      const kaKey = kaId.toString();
      let prepared = preparedCache.get(kaKey);
      if (!prepared) {
        try {
          prepared = await prepareKaCitation(deps, { contextGraphId: cgOnChainId, kaId });
        } catch {
          continue; // KA not fully synced / not anchored — skip, don't fabricate
        }
        preparedCache.set(kaKey, prepared);
        kasMatched++;
      }
      const chosen = sel.entityUri
        ? prepared.triples
            .filter((t) => t.subject === sel.entityUri)
            .sort((a, b) => Number(objectMatchesKeyword(b.object, keywords)) - Number(objectMatchesKeyword(a.object, keywords)))
        : prepared.triples.filter((t) => objectMatchesKeyword(t.object, keywords));
      // Diversify a bounded answer across matching entities instead of letting
      // the first large entity consume every citation slot.
      const perSelectionCap = Math.max(2, Math.ceil(maxCitations / Math.min(selections.length, maxCitations)));
      for (const triple of chosen.slice(0, perSelectionCap)) {
        if (citations.length >= maxCitations) break;
        const fk = `${kaKey}|${triple.subject}|${triple.predicate}|${triple.object}`;
        if (seenFact.has(fk)) continue;
        let citation: VerifiableCitation;
        try {
          citation = citeTriple(prepared, triple as CitationTriple);
        } catch {
          continue;
        }
        // Facts/citations are the authoritative API surface. Never let a failed
        // verification become prose or reach optional synthesis/reasoning.
        if (!citation.checks.verified) continue;
        seenFact.add(fk);
        let idx = kaIndex.get(citation.kaId);
        if (idx === undefined) {
          idx = kaIndex.size + 1;
          kaIndex.set(citation.kaId, idx);
        }
        citations.push(citation);
        facts.push({ subject: triple.subject, predicate: triple.predicate, object: triple.object, source: idx });
      }
    }

    const verified = citations.filter((c) => c.checks.verified).length;
    const answer = renderAnswer(args.question, facts, kaIndex);

    return {
      question: args.question,
      contextGraphId: args.contextGraphId,
      scope: 'local',
      answer,
      llm: false,
      citations,
      facts,
      stats: { keywords, kasMatched, factsCited: citations.length, verified, retrieval },
    };
  }

  /**
   * Gather EVERY verified fact of a context graph — all canonical triples
   * (relationship + attribute, NOT just literal-object like the answer path),
   * each with its VerifiableCitation, filtered to `checks.verified`. This is the
   * fact set the reasoning tier (EYE) consumes: COMPLETE over the CG (so
   * closed-world negation is sound) and TRUSTLESS (only chain-proven facts reach
   * the reasoner). Bounded by `cap` KAs. Reuses the exact citation machinery as
   * `dragAnswerLocal`; never fabricates (un-anchored KAs / un-citeable triples skipped).
   */
  async gatherVerifiedFacts(
    this: DKGAgent,
    contextGraphId: string,
    opts?: { cap?: number; maxTriples?: number },
  ): Promise<GatheredVerifiedFacts> {
    const empty = (complete = false): GatheredVerifiedFacts => ({
      facts: [], complete, graphsSeen: 0, graphsSkipped: 0, truncated: false,
    });
    const idCheck = validateContextGraphId(contextGraphId);
    if (!idCheck.valid) return empty();
    const onChainIdStr = await this.getContextGraphOnChainId(contextGraphId).catch(() => null);
    if (!onChainIdStr || !/^\d+$/.test(onChainIdStr) || BigInt(onChainIdStr) === 0n) return empty();
    const cgOnChainId = BigInt(onChainIdStr);
    // Root verifiable memory only. NOTE: sub-graph VM (e.g. `…/{cg}/rules/_verifiable_memory/…`)
    // is intentionally NOT scanned — the proof-extraction core (extractV10KCFromStore →
    // contextGraphDataUri) resolves a KA's graph as CG-root, so a sub-graph KA cannot yet
    // be cited. Reasoning over sub-graphs is a follow-up gated on sub-graph-aware extraction.
    const vmPrefix = `did:dkg:context-graph:${contextGraphId}/_verifiable_memory/`;
    const cap = Math.max(1, Math.min(opts?.cap ?? 200, 1000));
    // Bound the TOTAL fact set (not just KA count) — the reasoner's runtime grows
    // with the fact set, so this caps the compute an untrusted/large CG can drive.
    const maxTriples = Math.max(1, Math.min(opts?.maxTriples ?? 10000, 100000));

    const result = await this.store
      .query(`SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } FILTER(STRSTARTS(STR(?g), "${vmPrefix}")) } LIMIT ${cap + 1}`)
      .catch(() => null);
    if (!result || result.type !== 'bindings') return empty();
    const graphs =
      result && result.type === 'bindings'
        ? result.bindings.map((b) => (b['g'] ?? '').replace(/^<|>$/g, '')).filter(Boolean)
        : [];
    if (graphs.length === 0) return empty(true);
    const graphTruncated = graphs.length > cap;
    const boundedGraphs = graphs.slice(0, cap);

    const chain: CitationChainReads = {
      getLatestMerkleRoot: (kaId) => this.chain.getLatestMerkleRoot!(kaId),
      getMerkleLeafCount: (kaId) => this.chain.getMerkleLeafCount!(kaId),
      getLatestMerkleRootAuthor: (kaId) => this.chain.getLatestMerkleRootAuthor!(kaId),
    };
    const chainId = await this.chain.getEvmChainId().catch(() => 0n);
    const deps = { store: this.store, chain, servingNode: this.peerId ?? 'local', chainId };

    const out: Array<{ triple: CitationTriple; citation: VerifiableCitation }> = [];
    const seen = new Set<string>();
    let graphsSkipped = 0;
    let tripleTruncated = false;
    for (const g of boundedGraphs) {
      if (out.length >= maxTriples) { tripleTruncated = true; break; }
      const m = g.match(VM_GRAPH_RE);
      if (!m) { graphsSkipped++; continue; }
      const kaId = (BigInt(m[1]) << 96n) | BigInt(m[2]);
      let prepared: PreparedKaCitation;
      try {
        prepared = await prepareKaCitation(deps, { contextGraphId: cgOnChainId, kaId });
      } catch {
        graphsSkipped++;
        continue; // not anchored / not synced — skip, never fabricate
      }
      for (const triple of prepared.triples) {
        if (out.length >= maxTriples) { tripleTruncated = true; break; }
        const fk = `${triple.subject}|${triple.predicate}|${triple.object}`;
        if (seen.has(fk)) continue;
        let citation: VerifiableCitation;
        try {
          citation = citeTriple(prepared, triple as CitationTriple);
        } catch {
          graphsSkipped++;
          continue; // un-citeable (not a real public leaf) — skip
        }
        if (!citation.checks.verified) { graphsSkipped++; continue; } // trust gate
        seen.add(fk);
        out.push({ triple: { subject: triple.subject, predicate: triple.predicate, object: triple.object }, citation });
      }
    }
    const truncated = graphTruncated || tripleTruncated;
    return {
      facts: out,
      complete: !truncated && graphsSkipped === 0,
      graphsSeen: boundedGraphs.length,
      graphsSkipped,
      truncated,
    };
  }

  /** Attach (or clear) the semantic entry-point retriever used by `dragAnswerLocal`. */
  attachEntityRetriever(this: DKGAgent, retriever: EntityRetriever | null): void {
    this.entityRetriever = retriever ?? undefined;
  }

  /**
   * 1-hop graph expansion: neighbour entities reachable from `anchors` via an
   * IRI object, that are themselves subjects in this CG's verifiable memory.
   * This is the relationship-following step that turns vector-RAG into GraphRAG.
   */
  async dragExpandNeighbours(
    this: DKGAgent,
    anchors: string[],
    vmPrefix: string,
    limit: number,
  ): Promise<Array<{ sourceGraph: string; entityUri: string }>> {
    const values = anchors
      .slice(0, 24)
      .filter((a) => !/[<>"{}\\^`\s]/.test(a))
      .map((a) => `<${a}>`)
      .join(' ');
    if (!values) return [];
    const sparql = `SELECT DISTINCT ?neighbour ?ng WHERE {
      VALUES ?anchor { ${values} }
      GRAPH ?ag { ?anchor ?p ?neighbour . FILTER(isIRI(?neighbour)) FILTER(?neighbour != ?anchor) }
      GRAPH ?ng { ?neighbour ?p2 ?o2 }
      FILTER(STRSTARTS(STR(?ag), "${vmPrefix}"))
      FILTER(STRSTARTS(STR(?ng), "${vmPrefix}"))
    } LIMIT ${limit}`;
    const r = await this.store.query(sparql).catch(() => null);
    if (!r || r.type !== 'bindings') return [];
    return r.bindings
      .map((b) => ({
        entityUri: (b['neighbour'] ?? '').replace(/^<|>$/g, ''),
        sourceGraph: (b['ng'] ?? '').replace(/^<|>$/g, ''),
      }))
      .filter((x) => x.entityUri.length > 0 && x.sourceGraph.length > 0);
  }

  /**
   * Ask ONE peer to answer `question` over a public context graph it serves.
   * JSON over the dRAG-answer libp2p protocol; the peer runs its own
   * `dragAnswerLocal` and returns grounded, verifiable citations.
   */
  async dragAnswerRemote(
    this: DKGAgent,
    peerId: string,
    args: { question: string; contextGraphId: string; maxCitations?: number; maxKas?: number },
  ): Promise<DragAnswerResult> {
    const payload = new TextEncoder().encode(
      JSON.stringify({
        question: args.question,
        contextGraphId: args.contextGraphId,
        maxCitations: args.maxCitations,
        maxKas: args.maxKas,
      }),
    );
    // A dRAG answer is owned by this request. Raw request/response avoids
    // durable outbox retries and retained large responses after the caller left.
    const response = await this.messenger.sendToPeer(peerId, PROTOCOL_DRAG_ANSWER, payload, { timeoutMs: 15_000 });
    if (response.byteLength > MAX_REMOTE_RESPONSE_BYTES) {
      throw new Error(`peer ${peerId.slice(-8)} returned an oversized dRAG response`);
    }
    const decoded: unknown = JSON.parse(new TextDecoder().decode(response));
    if (decoded && typeof decoded === 'object' && 'error' in decoded) {
      throw new Error(`peer ${peerId.slice(-8)}: ${String((decoded as { error: unknown }).error)}`);
    }
    // Validate the shape up front so a single malformed / version-skewed peer
    // cannot throw deep in the aggregator and discard every honest peer's
    // citations — a bad response becomes a clean per-node error instead.
    if (!isValidDragAnswerResult(decoded)) {
      throw new Error(`peer ${peerId.slice(-8)} returned a malformed dRAG response`);
    }
    return decoded;
  }

  /**
   * Answer `question` over a PUBLIC context graph by fanning out across the peers
   * that serve it (resolved from the agents-CG phonebook), aggregating their
   * grounded citations, and — crucially — RE-VERIFYING every citation against
   * THIS node's own chain. The asker therefore trusts no serving node's
   * self-reported verdict; a fabricated or tampered citation fails the asker's
   * independent check. The asker need not hold the CG itself.
   */
  async dragAnswerNetwork(
    this: DKGAgent,
    args: {
      question: string;
      contextGraphId: string;
      maxCitations?: number;
      maxKas?: number;
      /** Also answer locally if this node serves the CG (default: auto-detect). */
      includeSelf?: boolean;
      /**
       * Explicit serving peerIds to fan out to, UNION'd with the phonebook
       * discovery. Useful when the caller already knows serving nodes, or when
       * an advertisement has not yet gossiped into this node's agents-CG (the
       * phonebook integrates fresh `dragContextGraphsServed` updates on a heartbeat
       * cadence, so discovery can lag a just-created CG).
       */
      peers?: string[];
    },
  ): Promise<DragNetworkAnswerResult> {
    const keywords = extractKeywords(args.question);
    // Validate the CG id BEFORE it reaches any SPARQL sink (getContextGraphOnChainId
    // interpolates it into an IRI) — mirror the local path's guard so the network
    // method is not a SPARQL-injection entry point.
    const idCheck = validateContextGraphId(args.contextGraphId);
    if (!idCheck.valid) {
      return {
        question: args.question,
        contextGraphId: args.contextGraphId,
        scope: 'network',
        answer: `Invalid context graph id: ${idCheck.reason ?? 'rejected'}.`,
        llm: false,
        citations: [],
        facts: [],
        perNode: [],
        stats: { keywords, servingNodes: 0, nodesAnswered: 0, factsCited: 0, verified: 0, scopeVerified: false, rejected: 0, notEvaluated: 0, peersSkipped: 0 },
      };
    }
    // Cross-node answering is public-only. Re-check the live chain policy on
    // the asking node too: explicit peers and includeSelf must not bypass it.
    if (!(await this.isContextGraphPublicOnChain(args.contextGraphId))) {
      return emptyNetworkResult(args.question, args.contextGraphId, keywords,
        `Context graph "${args.contextGraphId}" is not proven public on-chain; network answering failed closed.`);
    }
    // Bind the answer to the asked CG: only credit a citation whose KA belongs
    // to THIS on-chain CG — defends the cross-CG scope-swap (a peer could
    // otherwise return a genuinely-verifiable fact drawn from a DIFFERENT KA).
    const askedCgIdStr = await this.getContextGraphOnChainId(args.contextGraphId).catch(() => null);
    const askedCgId =
      askedCgIdStr && /^\d+$/.test(askedCgIdStr) && BigInt(askedCgIdStr) > 0n ? BigInt(askedCgIdStr) : null;
    if (askedCgId === null || typeof this.chain.getKAContextGraphId !== 'function') {
      return emptyNetworkResult(args.question, args.contextGraphId, keywords,
        `Could not prove the requested context graph's on-chain identity; network answering failed closed.`);
    }
    const liveChainId = await this.chain.getEvmChainId().catch(() => null);
    if (liveChainId === null) {
      return emptyNetworkResult(args.question, args.contextGraphId, keywords,
        `Could not resolve the live chain identity; network answering failed closed.`);
    }
    const knowledgeAssetsAddress = await (
      this.chain.getDKGKnowledgeAssetsAddress
        ? this.chain.getDKGKnowledgeAssetsAddress()
        : this.chain.getKnowledgeAssetsLifecycleAddress()
    ).catch(() => null);
    if (!knowledgeAssetsAddress || !/^0x[0-9a-fA-F]{40}$/.test(knowledgeAssetsAddress)) {
      return emptyNetworkResult(args.question, args.contextGraphId, keywords,
        `Could not resolve the live Knowledge Assets contract; network answering failed closed.`);
    }

    const discovered = await this.discovery
      .findNodesServingCG(args.contextGraphId)
      .catch((): string[] => []);
    // Caller-supplied known serving nodes are intentional and should not be
    // crowded out by a long/stale discovery list.
    const allPeers = Array.from(new Set([...(args.peers ?? []), ...discovered]));
    const myPeerId = this.peerId ?? 'local';
    const includeSelf = args.includeSelf ?? allPeers.includes(myPeerId);
    // Cap the fan-out so a caller-supplied peer list can't make this node a
    // reflector dialing arbitrary peers; bound concurrency below.
    const remoteAll = allPeers.filter((p) => p !== myPeerId);
    const remotePeers = remoteAll.slice(0, MAX_FANOUT_PEERS);
    const truncatedPeers = remoteAll.length - remotePeers.length;

    type NodeResult = { peerId: string; result?: DragAnswerResult; error?: string };
    const thunks: Array<() => Promise<NodeResult>> = [];
    if (includeSelf) {
      thunks.push(() =>
        // Network answering has one retrieval contract regardless of where a
        // participant runs: bounded keyword only. Do not let includeSelf reuse
        // this node's attached semantic retriever and trigger model/index work.
        this.dragAnswerLocal(args, { forceKeyword: true })
          .then((result) => ({ peerId: myPeerId, result }))
          .catch((e) => ({ peerId: myPeerId, error: e instanceof Error ? e.message : String(e) })),
      );
    }
    for (const peer of remotePeers) {
      thunks.push(() =>
        this.dragAnswerRemote(peer, args)
          .then((result) => ({ peerId: peer, result }))
          .catch((e) => ({ peerId: peer, error: e instanceof Error ? e.message : String(e) })),
      );
    }
    const nodeResults = await runWithConcurrency(thunks, FANOUT_CONCURRENCY);

    // Re-verify against OUR chain (trustless aggregation).
    const chain: CitationChainReads = {
      getLatestMerkleRoot: (kaId) => this.chain.getLatestMerkleRoot!(kaId),
      getMerkleLeafCount: (kaId) => this.chain.getMerkleLeafCount!(kaId),
      getLatestMerkleRootAuthor: (kaId) => this.chain.getLatestMerkleRootAuthor!(kaId),
    };

    const citations: VerifiableCitation[] = [];
    const facts: DragFact[] = [];
    const kaIndex = new Map<string, number>();
    const perNode: DragPerNode[] = [];
    const maxCitations = Math.min(Math.max(args.maxCitations ?? 12, 1), 50);
    // Verdict cache keyed on the FULL proof identity (the merkle siblings/content/
    // leafCount, the on-chain anchor, and the seal ALL change the verdict), so a
    // peer's bad proof can never collide with — and poison — an honest peer's
    // verdict for the same fact.
    const verdictCache = new Map<string, CitationChecks>();
    const kaScopeCache = new Map<string, boolean>(); // kaId -> belongs to asked CG?
    const canonicalUalCache = new Map<string, string>();
    // Only verified citations enter this map; deduplication and the caller's
    // output cap happen after the independent trust checks.
    const byFact = new Map<string, VerifiableCitation>();
    const verifiedByNode = new Array<number>(nodeResults.length).fill(0);
    const evaluatedByNode = new Array<number>(nodeResults.length).fill(0);
    type Candidate = { nodeIndex: number; citation: VerifiableCitation };
    const candidates: Candidate[] = [];

    // Allocate the global verification budget round-robin. Every responding
    // peer gets one candidate considered before any peer gets a second, so an
    // early malicious/stale peer cannot starve a later honest responder.
    candidateRounds:
    for (let round = 0; round < MAX_CITATIONS_PER_PEER; round++) {
      for (let nodeIndex = 0; nodeIndex < nodeResults.length; nodeIndex++) {
        const citation = nodeResults[nodeIndex].result?.citations[round];
        if (!citation) continue;
        if (candidates.length >= MAX_TOTAL_VERIFICATIONS) break candidateRounds;
        candidates.push({ nodeIndex, citation });
        evaluatedByNode[nodeIndex]++;
      }
    }

    let rejected = 0;
    for (const { nodeIndex, citation: c } of candidates) {
      const nr = nodeResults[nodeIndex];
      try {
        const canonicalKaId = BigInt(c.kaId).toString();
        // CG-scope binding — only credit KAs that belong to the asked CG.
        let inScope = kaScopeCache.get(canonicalKaId);
        if (inScope === undefined) {
          const resolvedScope = await this.chain
            .getKAContextGraphId(BigInt(canonicalKaId))
            .then((id) => id === askedCgId)
            .catch(() => false);
          inScope = resolvedScope === true;
          kaScopeCache.set(canonicalKaId, inScope);
        }
        if (!inScope) {
          rejected++;
          continue;
        }

        const proofKey = JSON.stringify({ k: canonicalKaId, t: c.triple, p: c.proof, o: c.onChain, s: c.seal });
        let checks = verdictCache.get(proofKey);
        if (!checks) {
          checks = await verifyVerifiableCitation(c, { chain }).catch(
            (): CitationChecks => ({ merkle: false, onChain: false, authorSig: false, verified: false }),
          );
          verdictCache.set(proofKey, checks);
        }
        if (!checks.verified) {
          rejected++;
          continue;
        }

        let ual = canonicalUalCache.get(canonicalKaId);
        if (!ual) {
          ual = buildKnowledgeAssetUal(this.chain.chainId, knowledgeAssetsAddress, BigInt(canonicalKaId));
          canonicalUalCache.set(canonicalKaId, ual);
        }
        verifiedByNode[nodeIndex]++;

        // A valid proof authenticates the fact/root/author, not peer-carried
        // labels. Rebuild provenance from the asker's chain and requested CG.
        const recited: VerifiableCitation = {
          ...c,
          kaId: canonicalKaId,
          ual,
          contextGraphId: askedCgId.toString(),
          servingNode: nr.peerId,
          onChain: { ...c.onChain, chainId: liveChainId.toString() },
          checks,
        };
        const factKey = `${canonicalKaId}|${c.triple.subject}|${c.triple.predicate}|${c.triple.object}`;
        if (!byFact.has(factKey)) byFact.set(factKey, recited);
      } catch {
        // Skip a single malformed citation — never let it abort the answer.
        rejected++;
      }
    }

    let notEvaluated = 0;
    for (let i = 0; i < nodeResults.length; i++) {
      const nr = nodeResults[i];
      if (nr.error || !nr.result) {
        perNode.push({ peerId: nr.peerId, factsCited: 0, verified: 0, error: nr.error ?? 'no result' });
        continue;
      }
      notEvaluated += Math.max(0, nr.result.citations.length - evaluatedByNode[i]);
      perNode.push({ peerId: nr.peerId, factsCited: nr.result.citations.length, verified: verifiedByNode[i] });
    }

    // Every entry is independently verified; truncate only after fair evaluation
    // and fact deduplication.
    const ranked = [...byFact.values()];
    for (const c of ranked.slice(0, maxCitations)) {
      let idx = kaIndex.get(c.kaId);
      if (idx === undefined) {
        idx = kaIndex.size + 1;
        kaIndex.set(c.kaId, idx);
      }
      citations.push(c);
      facts.push({ subject: c.triple.subject, predicate: c.triple.predicate, object: c.triple.object, source: idx });
    }

    const verified = citations.filter((c) => c.checks.verified).length;
    const nodesAnswered = perNode.filter((p) => !p.error).length;
    const answer = renderNetworkAnswer(args.question, facts, kaIndex, perNode);
    const servingNodes = new Set([...allPeers, ...(includeSelf ? [myPeerId] : [])]).size;

    return {
      question: args.question,
      contextGraphId: args.contextGraphId,
      scope: 'network',
      answer,
      llm: false,
      citations,
      facts,
      perNode,
      stats: {
        keywords, servingNodes, nodesAnswered,
        factsCited: citations.length, verified, scopeVerified: true,
        rejected, notEvaluated,
        peersSkipped: truncatedPeers,
      },
    };
  }
}

function emptyNetworkResult(
  question: string,
  contextGraphId: string,
  keywords: string[],
  answer: string,
): DragNetworkAnswerResult {
  return {
    question, contextGraphId, scope: 'network', answer, llm: false,
    citations: [], facts: [], perNode: [],
    stats: { keywords, servingNodes: 0, nodesAnswered: 0, factsCited: 0, verified: 0, scopeVerified: false, rejected: 0, notEvaluated: 0, peersSkipped: 0 },
  };
}

/** Run thunks with a bounded number in flight; preserves input order. Thunks must not throw. */
async function runWithConcurrency<T>(thunks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(thunks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < thunks.length) {
      const i = next++;
      results[i] = await thunks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(limit, 1), thunks.length) }, () => worker()));
  return results;
}

/** A peer's dRAG reply is usable only if it carries a well-formed citation array. */
function isValidDragAnswerResult(d: unknown): d is DragAnswerResult {
  if (!d || typeof d !== 'object') return false;
  const x = d as Record<string, unknown>;
  return (
    x.scope === 'local' &&
    Array.isArray(x.citations) &&
    x.citations.length <= MAX_CITATIONS_PER_PEER &&
    x.citations.every(isVerifiableCitationShape)
  );
}

/** Render a human-readable, audit-flagged answer (no LLM). */
function renderAnswer(
  question: string,
  facts: DragFact[],
  kaIndex: Map<string, number>,
): string {
  if (facts.length === 0) return `No verifiable facts found for "${question}".`;

  // Group facts by subject, preserving first-seen order.
  const bySubject = new Map<string, DragFact[]>();
  for (const f of facts) {
    const arr = bySubject.get(f.subject) ?? [];
    arr.push(f);
    bySubject.set(f.subject, arr);
  }

  const lines: string[] = [
    `Grounded in ${facts.length} verified fact${facts.length === 1 ? '' : 's'} ` +
      `from ${kaIndex.size} Knowledge Asset${kaIndex.size === 1 ? '' : 's'}.`,
    '',
  ];
  for (const [subject, group] of bySubject) {
    lines.push(`**${subject}**`);
    for (const f of group) {
      lines.push(`- ${shortPredicate(f.predicate)} — ${displayObject(f.object)}  [${f.source}]`);
    }
    lines.push('');
  }

  // Proofs, sources, and node diagnostics stay in their typed fields. Keeping
  // them out of presentation text prevents UI/MCP consumers from parsing
  // markdown sentinels as an accidental wire protocol.
  return lines.join('\n');
}

/** Render a cross-node answer with a per-node trust breakdown (no LLM). */
function renderNetworkAnswer(
  question: string,
  facts: DragFact[],
  kaIndex: Map<string, number>,
  perNode: DragPerNode[],
): string {
  const answered = perNode.filter((p) => !p.error).length;
  if (facts.length === 0) {
    return (
      `No verifiable facts found across the network for "${question}" ` +
      `(${answered}/${perNode.length} serving node${perNode.length === 1 ? '' : 's'} answered).`
    );
  }
  // Per-node and trust/completeness counters are structured response fields;
  // consumers render them without scraping prose.
  return renderAnswer(question, facts, kaIndex);
}
