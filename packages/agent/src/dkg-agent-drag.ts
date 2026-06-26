/**
 * dRAG answer methods (OT-RFC-55 P2 — single-node `dkg_answer`).
 *
 * `dragAnswerLocal` turns a natural-language question into a grounded, CITED
 * answer over the verifiable-memory of one Context Graph held on THIS node:
 *
 *   question → keyword retrieval over per-KA VM graphs → canonical triples →
 *   a {@link VerifiableCitation} per cited fact (Merkle + on-chain + author seal).
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
import { PROTOCOL_DRAG_ANSWER, validateContextGraphId } from '@origintrail-official/dkg-core';
import type { VerifiableCitation, CitationTriple, CitationChecks } from '@origintrail-official/dkg-core';
import type { EntityRetriever, RetrievedAnchor } from './drag/retriever.js';

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
  /** Index (1-based) of the source KA in the answer's Sources list. */
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
    /** End-to-end answer latency in ms (set by the route for observability). */
    latencyMs?: number;
  };
}

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

function shortKa(kaId: string): string {
  // kaId = (author<<96)|number — show author tail + number.
  try {
    const v = BigInt(kaId);
    const author = '0x' + (v >> 96n).toString(16).padStart(40, '0');
    const number = (v & ((1n << 96n) - 1n)).toString();
    return `${author.slice(0, 6)}…${author.slice(-4)}/${number}`;
  } catch {
    return kaId.slice(0, 12);
  }
}

function shortHex(h: string): string {
  return h.length > 14 ? `${h.slice(0, 8)}…${h.slice(-4)}` : h;
}

function flag(v: boolean | null): string {
  if (v === true) return '✓';
  if (v === false) return '✗';
  return '~'; // null = trusted-via-chain but not independently re-derived
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
      const anchors = await retriever
        .retrieve(args.question, args.contextGraphId, maxKas)
        .catch((): RetrievedAnchor[] => []);
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
        if (retriever.degraded === true) {
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
      const sparql = `SELECT DISTINCT ?g WHERE {
        GRAPH ?g { ?s ?p ?o . FILTER(isLiteral(?o)) FILTER(${kwFilter}) }
        FILTER(STRSTARTS(STR(?g), "${vmPrefix}"))
      } LIMIT ${maxKas}`;
      const result = await this.store.query(sparql);
      const graphs =
        result.type === 'bindings'
          ? result.bindings.map((b) => (b['g'] ?? '').replace(/^<|>$/g, '')).filter(Boolean)
          : [];
      if (graphs.length === 0) return empty(`No verifiable facts found for: ${keywords.join(', ')}.`, retrieval);
      selections = graphs.map((g) => ({ sourceGraph: g }));
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
        ? prepared.triples.filter((t) => t.subject === sel.entityUri && isLiteralObject(t.object))
        : prepared.triples.filter((t) => objectMatchesKeyword(t.object, keywords));
      for (const triple of chosen) {
        if (citations.length >= maxCitations) break;
        const fk = `${kaKey}|${triple.subject}|${triple.predicate}|${triple.object}`;
        if (seenFact.has(fk)) continue;
        let citation: VerifiableCitation;
        try {
          citation = citeTriple(prepared, triple as CitationTriple);
        } catch {
          continue;
        }
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
    const answer = renderAnswer(args.question, facts, citations, kaIndex);

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
    const sendResult = await this.messenger.sendReliable(peerId, PROTOCOL_DRAG_ANSWER, payload);
    if (!sendResult.delivered) {
      throw new Error(`dRAG remote to ${peerId.slice(-8)} not delivered (queued): ${sendResult.error ?? 'unknown'}`);
    }
    const decoded: unknown = JSON.parse(new TextDecoder().decode(sendResult.response));
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
       * phonebook integrates fresh `contextGraphsServed` updates on a heartbeat
       * cadence, so discovery can lag a just-created CG).
       */
      peers?: string[];
    },
  ): Promise<DragNetworkAnswerResult> {
    const keywords = extractKeywords(args.question);
    // Bind the answer to the asked CG: only credit a citation whose KA belongs
    // to THIS on-chain CG — defends the cross-CG scope-swap (a peer could
    // otherwise return a genuinely-verifiable fact drawn from a DIFFERENT KA).
    const askedCgIdStr = await this.getContextGraphOnChainId(args.contextGraphId).catch(() => null);
    const askedCgId =
      askedCgIdStr && /^\d+$/.test(askedCgIdStr) && BigInt(askedCgIdStr) > 0n ? BigInt(askedCgIdStr) : null;

    const discovered = await this.discovery
      .findNodesServingCG(args.contextGraphId)
      .catch((): string[] => []);
    const allPeers = Array.from(new Set([...discovered, ...(args.peers ?? [])]));
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
        this.dragAnswerLocal(args)
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
    const factIndex = new Map<string, number>(); // factKey -> index into `citations`
    const perNode: DragPerNode[] = [];
    const maxCitations = Math.min(Math.max(args.maxCitations ?? 12, 1), 50);
    // Verdict cache keyed on the PROOF (not just the fact), so distinct proofs for
    // the same fact are each verified — a bad proof can't poison an honest one.
    const verdictCache = new Map<string, CitationChecks>();
    const kaScopeCache = new Map<string, boolean>(); // kaId -> belongs to asked CG?
    let droppedOffScope = 0;

    for (const nr of nodeResults) {
      if (nr.error || !nr.result) {
        perNode.push({ peerId: nr.peerId, factsCited: 0, verified: 0, error: nr.error ?? 'no result' });
        continue;
      }
      let nodeVerified = 0;
      let processed = 0;
      for (const c of nr.result.citations) {
        // Cap per-peer work so one peer's large response can't exhaust the
        // asker's chain-RPC budget before the dedup gate.
        if (processed >= MAX_CITATIONS_PER_PEER) break;
        processed++;
        try {
          // CG-scope binding — only credit KAs that belong to the asked CG.
          if (askedCgId !== null && typeof this.chain.getKAContextGraphId === 'function') {
            let inScope = kaScopeCache.get(c.kaId);
            if (inScope === undefined) {
              inScope = await this.chain
                .getKAContextGraphId(BigInt(c.kaId))
                .then((id) => id === askedCgId)
                .catch(() => false);
              kaScopeCache.set(c.kaId, inScope);
            }
            if (!inScope) {
              droppedOffScope++;
              continue;
            }
          }

          const proofKey = `${c.kaId}|${c.triple.subject}|${c.triple.predicate}|${c.triple.object}|${c.proof.leaf}|${c.proof.chunkId}`;
          let checks = verdictCache.get(proofKey);
          if (!checks) {
            checks = await verifyVerifiableCitation(c, { chain }).catch(
              (): CitationChecks => ({ merkle: false, onChain: false, authorSig: false, verified: false }),
            );
            verdictCache.set(proofKey, checks);
          }
          if (checks.verified) nodeVerified++;

          // Never trust the remote's contextGraphId/ual for scope — stamp the
          // asker-derived CG + the asker's own verdict.
          const recited: VerifiableCitation = {
            ...c,
            contextGraphId: askedCgId !== null ? askedCgId.toString() : c.contextGraphId,
            servingNode: nr.peerId,
            checks,
          };
          const factKey = `${c.kaId}|${c.triple.subject}|${c.triple.predicate}|${c.triple.object}`;
          const existingIdx = factIndex.get(factKey);
          if (existingIdx === undefined) {
            if (citations.length < maxCitations) {
              factIndex.set(factKey, citations.length);
              citations.push(recited);
              let idx = kaIndex.get(c.kaId);
              if (idx === undefined) {
                idx = kaIndex.size + 1;
                kaIndex.set(c.kaId, idx);
              }
              facts.push({ subject: c.triple.subject, predicate: c.triple.predicate, object: c.triple.object, source: idx });
            }
          } else if (!citations[existingIdx].checks.verified && checks.verified) {
            // Upgrade a previously-unverified fact to a verified corroboration.
            citations[existingIdx] = recited;
          }
        } catch {
          // Skip a single malformed citation — never let it abort the answer.
          continue;
        }
      }
      perNode.push({ peerId: nr.peerId, factsCited: nr.result.citations.length, verified: nodeVerified });
    }

    const verified = citations.filter((c) => c.checks.verified).length;
    const nodesAnswered = perNode.filter((p) => !p.error).length;
    const answer = renderNetworkAnswer(args.question, facts, citations, kaIndex, perNode, {
      truncatedPeers,
      droppedOffScope,
      // Scope is enforced only when the asker can resolve the CG's on-chain id
      // (synced network-wide via the ontology system CG). If it cannot, the
      // facts are still cryptographically verified but their CG provenance is
      // unconfirmed — surface that rather than failing open silently.
      scopeEnforced: askedCgId !== null,
    });

    return {
      question: args.question,
      contextGraphId: args.contextGraphId,
      scope: 'network',
      answer,
      llm: false,
      citations,
      facts,
      perNode,
      stats: { keywords, servingNodes: allPeers.length, nodesAnswered, factsCited: citations.length, verified },
    };
  }
}

const MAX_FANOUT_PEERS = 24;
const MAX_CITATIONS_PER_PEER = 64;
const FANOUT_CONCURRENCY = 8;

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

function isValidCitation(c: unknown): c is VerifiableCitation {
  if (!c || typeof c !== 'object') return false;
  const x = c as Record<string, unknown>;
  const t = x.triple as Record<string, unknown> | undefined;
  const p = x.proof as Record<string, unknown> | undefined;
  const oc = x.onChain as Record<string, unknown> | undefined;
  return (
    typeof x.kaId === 'string' &&
    !!t && typeof t.subject === 'string' && typeof t.predicate === 'string' && typeof t.object === 'string' &&
    !!p && typeof p.content === 'string' && typeof p.leaf === 'string' && Array.isArray(p.siblings) &&
    typeof p.chunkId === 'number' && typeof p.leafCount === 'number' &&
    !!oc && typeof oc.merkleRoot === 'string' && typeof oc.author === 'string' &&
    !!x.checks && typeof x.checks === 'object'
  );
}

/** A peer's dRAG reply is usable only if it carries a well-formed citation array. */
function isValidDragAnswerResult(d: unknown): d is DragAnswerResult {
  if (!d || typeof d !== 'object') return false;
  const x = d as Record<string, unknown>;
  return Array.isArray(x.citations) && x.citations.every(isValidCitation);
}

/** Render a human-readable, audit-flagged answer (no LLM). */
function renderAnswer(
  question: string,
  facts: DragFact[],
  citations: VerifiableCitation[],
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

  const lines: string[] = [];
  lines.push(
    `## Answer\n\nGrounded in ${facts.length} verifiable fact${facts.length === 1 ? '' : 's'} ` +
      `from ${kaIndex.size} source${kaIndex.size === 1 ? '' : 's'} on this node.\n`,
  );
  for (const [subject, group] of bySubject) {
    lines.push(`**${subject}**`);
    for (const f of group) {
      lines.push(`- ${shortPredicate(f.predicate)} — ${displayObject(f.object)}  [${f.source}]`);
    }
    lines.push('');
  }

  // One Sources entry per cited KA (citations of the same KA share verdict).
  lines.push('## Sources');
  const seenKa = new Set<string>();
  for (const c of citations) {
    if (seenKa.has(c.kaId)) continue;
    seenKa.add(c.kaId);
    const idx = kaIndex.get(c.kaId);
    const ch = c.checks;
    lines.push(
      `[${idx}] KA ${shortKa(c.kaId)} · cg ${c.contextGraphId} · @${c.servingNode.slice(0, 12)}` +
        `  ${flag(ch.authorSig)} author-sig  ${flag(ch.merkle)} merkle  ${flag(ch.onChain)} on-chain`,
    );
    lines.push(`     UAL: ${c.ual}`);
    lines.push(`     root: ${shortHex(c.onChain.merkleRoot)}  author: ${c.onChain.author}`);
  }
  return lines.join('\n');
}

/** Render a cross-node answer with a per-node trust breakdown (no LLM). */
function renderNetworkAnswer(
  question: string,
  facts: DragFact[],
  citations: VerifiableCitation[],
  kaIndex: Map<string, number>,
  perNode: DragPerNode[],
  notes: { truncatedPeers: number; droppedOffScope: number; scopeEnforced: boolean } = {
    truncatedPeers: 0,
    droppedOffScope: 0,
    scopeEnforced: true,
  },
): string {
  const answered = perNode.filter((p) => !p.error).length;
  if (facts.length === 0) {
    return (
      `No verifiable facts found across the network for "${question}" ` +
      `(${answered}/${perNode.length} serving node${perNode.length === 1 ? '' : 's'} answered).`
    );
  }
  const base = renderAnswer(question, facts, citations, kaIndex);
  const lines: string[] = ['', '## Network'];
  lines.push(
    `Assembled across ${answered} of ${perNode.length} serving node${perNode.length === 1 ? '' : 's'}; ` +
      `every citation re-verified independently against the chain by this node.`,
  );
  for (const p of perNode) {
    lines.push(
      p.error
        ? `- @${p.peerId.slice(0, 12)} — error: ${p.error}`
        : `- @${p.peerId.slice(0, 12)} — ${p.factsCited} fact${p.factsCited === 1 ? '' : 's'} offered, ${p.verified} verified`,
    );
  }
  if (notes.droppedOffScope > 0) {
    lines.push(`(${notes.droppedOffScope} citation${notes.droppedOffScope === 1 ? '' : 's'} dropped: KA not in the requested context graph)`);
  }
  if (notes.truncatedPeers > 0) {
    lines.push(`(fan-out capped at ${MAX_FANOUT_PEERS} peers; ${notes.truncatedPeers} additional serving node${notes.truncatedPeers === 1 ? '' : 's'} not queried)`);
  }
  if (!notes.scopeEnforced) {
    lines.push('(⚠ context-graph scope NOT enforced: could not resolve the CG on-chain id — facts are cryptographically verified but their CG provenance is unconfirmed)');
  }
  return `${base}\n${lines.join('\n')}`;
}
