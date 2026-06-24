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
import { PROTOCOL_DRAG_ANSWER } from '@origintrail-official/dkg-core';
import type { VerifiableCitation, CitationTriple, CitationChecks } from '@origintrail-official/dkg-core';

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
  stats: { keywords: string[]; kasMatched: number; factsCited: number; verified: number };
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
  stats: { keywords: string[]; servingNodes: number; nodesAnswered: number; factsCited: number; verified: number };
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
  ): Promise<DragAnswerResult> {
    const maxCitations = Math.min(Math.max(args.maxCitations ?? 12, 1), 50);
    const maxKas = Math.min(Math.max(args.maxKas ?? 25, 1), 100);
    const keywords = extractKeywords(args.question);

    const empty = (note: string): DragAnswerResult => ({
      question: args.question,
      contextGraphId: args.contextGraphId,
      scope: 'local',
      answer: note,
      llm: false,
      citations: [],
      facts: [],
      stats: { keywords, kasMatched: 0, factsCited: 0, verified: 0 },
    });

    if (keywords.length === 0) {
      return empty('No searchable keywords in the question.');
    }

    // Resolve the CG's on-chain numeric id (needed by the KA extractor).
    const onChainIdStr = await this.getContextGraphOnChainId(args.contextGraphId).catch(() => null);
    if (!onChainIdStr || !/^\d+$/.test(onChainIdStr) || BigInt(onChainIdStr) === 0n) {
      return empty(
        `Context graph "${args.contextGraphId}" is not registered on-chain — verifiable citations require an anchored CG.`,
      );
    }
    const cgOnChainId = BigInt(onChainIdStr);

    // 1. Find candidate per-KA VM graphs whose public literals match a keyword.
    const vmPrefix = `did:dkg:context-graph:${args.contextGraphId}/_verifiable_memory/`;
    const kwFilter = keywords
      .map((kw) => `CONTAINS(LCASE(STR(?o)), "${kw.replace(/["\\]/g, '')}")`)
      .join(' || ');
    const sparql = `SELECT DISTINCT ?g WHERE {
      GRAPH ?g {
        ?s ?p ?o .
        FILTER(isLiteral(?o))
        FILTER(${kwFilter})
      }
      FILTER(STRSTARTS(STR(?g), "${vmPrefix}"))
    } LIMIT ${maxKas}`;

    const result = await this.store.query(sparql);
    const graphs =
      result.type === 'bindings'
        ? result.bindings.map((b) => (b['g'] ?? '').replace(/^<|>$/g, '')).filter(Boolean)
        : [];

    if (graphs.length === 0) {
      return empty(`No verifiable facts found for: ${keywords.join(', ')}.`);
    }

    // 2. Per candidate KA: prepare once, cite matching canonical triples.
    const chain: CitationChainReads = {
      getLatestMerkleRoot: (kaId) => this.chain.getLatestMerkleRoot!(kaId),
      getMerkleLeafCount: (kaId) => this.chain.getMerkleLeafCount!(kaId),
      getLatestMerkleRootAuthor: (kaId) => this.chain.getLatestMerkleRootAuthor!(kaId),
    };
    const chainId = await this.chain.getEvmChainId().catch(() => 0n);
    const deps = { store: this.store, chain, servingNode: this.peerId ?? 'local', chainId };

    const citations: VerifiableCitation[] = [];
    const facts: DragFact[] = [];
    const kaIndex = new Map<string, number>(); // kaId -> 1-based source index
    let kasMatched = 0;

    for (const g of graphs) {
      if (citations.length >= maxCitations) break;
      const m = g.match(VM_GRAPH_RE);
      if (!m) continue;
      const author = m[1];
      const number = BigInt(m[2]);
      const kaId = (BigInt(author) << 96n) | number;

      let prepared: PreparedKaCitation;
      try {
        prepared = await prepareKaCitation(deps, { contextGraphId: cgOnChainId, kaId });
      } catch {
        continue; // KA not fully synced / not anchored — skip, don't fabricate
      }
      kasMatched++;

      const matched = prepared.triples.filter((t) => objectMatchesKeyword(t.object, keywords));
      for (const triple of matched) {
        if (citations.length >= maxCitations) break;
        let citation: VerifiableCitation;
        try {
          citation = citeTriple(prepared, triple as CitationTriple);
        } catch {
          continue;
        }
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
      stats: { keywords, kasMatched, factsCited: citations.length, verified },
    };
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
    const decoded = JSON.parse(new TextDecoder().decode(sendResult.response)) as
      | DragAnswerResult
      | { error: string };
    if ('error' in decoded) throw new Error(`peer ${peerId.slice(-8)}: ${decoded.error}`);
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
    const discovered = await this.discovery
      .findNodesServingCG(args.contextGraphId)
      .catch((): string[] => []);
    const servingPeers = Array.from(new Set([...discovered, ...(args.peers ?? [])]));
    const myPeerId = this.peerId ?? 'local';
    const includeSelf = args.includeSelf ?? servingPeers.includes(myPeerId);
    const remotePeers = servingPeers.filter((p) => p !== myPeerId);

    type NodeResult = { peerId: string; result?: DragAnswerResult; error?: string };
    const tasks: Promise<NodeResult>[] = [];
    if (includeSelf) {
      tasks.push(
        this.dragAnswerLocal(args)
          .then((result) => ({ peerId: myPeerId, result }))
          .catch((e) => ({ peerId: myPeerId, error: e instanceof Error ? e.message : String(e) })),
      );
    }
    for (const peer of remotePeers) {
      tasks.push(
        this.dragAnswerRemote(peer, args)
          .then((result) => ({ peerId: peer, result }))
          .catch((e) => ({ peerId: peer, error: e instanceof Error ? e.message : String(e) })),
      );
    }
    const nodeResults = await Promise.all(tasks);

    // Re-verify against OUR chain (trustless aggregation).
    const chain: CitationChainReads = {
      getLatestMerkleRoot: (kaId) => this.chain.getLatestMerkleRoot!(kaId),
      getMerkleLeafCount: (kaId) => this.chain.getMerkleLeafCount!(kaId),
      getLatestMerkleRootAuthor: (kaId) => this.chain.getLatestMerkleRootAuthor!(kaId),
    };

    const seen = new Set<string>();
    const citations: VerifiableCitation[] = [];
    const facts: DragFact[] = [];
    const kaIndex = new Map<string, number>();
    const perNode: DragPerNode[] = [];
    const maxCitations = Math.min(Math.max(args.maxCitations ?? 12, 1), 50);
    // Verify each unique citation ONCE (the asker's own chain check); reuse the
    // verdict for the same fact offered by another node, so a corroborating node
    // is credited for verified facts even after the answer-level dedup.
    const verdictCache = new Map<string, CitationChecks>();

    for (const nr of nodeResults) {
      if (nr.error || !nr.result) {
        perNode.push({ peerId: nr.peerId, factsCited: 0, verified: 0, error: nr.error ?? 'no result' });
        continue;
      }
      let nodeVerified = 0;
      for (const c of nr.result.citations) {
        const key = `${c.kaId}|${c.triple.subject}|${c.triple.predicate}|${c.triple.object}`;
        let checks = verdictCache.get(key);
        if (!checks) {
          checks = await verifyVerifiableCitation(c, { chain }).catch(
            (): CitationChecks => ({ merkle: false, onChain: false, authorSig: false, verified: false }),
          );
          verdictCache.set(key, checks);
        }
        if (checks.verified) nodeVerified++;
        if (!seen.has(key) && citations.length < maxCitations) {
          seen.add(key);
          // Stamp the (first) serving node + the asker's independent verdict.
          citations.push({ ...c, servingNode: nr.peerId, checks });
          let idx = kaIndex.get(c.kaId);
          if (idx === undefined) {
            idx = kaIndex.size + 1;
            kaIndex.set(c.kaId, idx);
          }
          facts.push({ subject: c.triple.subject, predicate: c.triple.predicate, object: c.triple.object, source: idx });
        }
      }
      perNode.push({ peerId: nr.peerId, factsCited: nr.result.citations.length, verified: nodeVerified });
    }

    const verified = citations.filter((c) => c.checks.verified).length;
    const nodesAnswered = perNode.filter((p) => !p.error).length;
    const answer = renderNetworkAnswer(args.question, facts, citations, kaIndex, perNode);

    return {
      question: args.question,
      contextGraphId: args.contextGraphId,
      scope: 'network',
      answer,
      llm: false,
      citations,
      facts,
      perNode,
      stats: { keywords, servingNodes: servingPeers.length, nodesAnswered, factsCited: citations.length, verified },
    };
  }
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
  return `${base}\n${lines.join('\n')}`;
}
