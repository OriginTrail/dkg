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
  type CitationChainReads,
  type PreparedKaCitation,
} from './drag/citation.js';
import type { VerifiableCitation, CitationTriple } from '@origintrail-official/dkg-core';

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
