// daemon/routes/drag.ts
//
// dRAG routes (OT-RFC-55).
//
//   POST /api/answer
//     { question, contextGraphId, scope?: "local"|"network",
//       retrieval?: "default"|"keyword"|"semantic", peers?, maxCitations?, maxKas? }
//     -> { answer, citations[], facts[], stats, perNode?, settlement? }
//
// Every citation is independently auditable against the chain (V10 Merkle
// inclusion + on-chain root + EIP-712 author seal). Retrieval is `keyword`
// (substring) or `semantic` (embedding ANN over the CG's entities); `default`
// uses the node's configured embedder (config.drag.embedder).
//
// `retrieval` applies to scope:"local". For scope:"network" each serving peer
// answers with its OWN configured retrieval (a peer can't be forced to load a
// model), so the caller's `retrieval` choice is not propagated over the wire.
//
// PAYMENT (§5.4) is OFF by default (answers are free); enable with
// config.drag.payments.enabled. The x402 wire format + a pluggable
// PaymentVerifier are wired so monetization is one swap away.
//
// Dev/test knobs (`embedder`, `simulatePrice`) are honoured ONLY when
// config.drag.experimentalOverrides is set — they are kept out of the public
// answer contract.

import { randomUUID } from 'node:crypto';
import type { RequestContext } from './context.js';
import type { EntityRetriever } from '@origintrail-official/dkg-agent';
import { jsonResponse, readBody } from '../http-utils.js';
import {
  MockPaymentVerifier,
  parsePrice,
  resolvePayment,
  build402Body,
  type PaymentVerifier,
  type SettlementReceipt,
} from '../payment.js';
import type { EmbeddingProvider } from '../../vector-store.js';
import { VectorEntityRetriever } from '../drag-retriever.js';
import { buildEmbedder, resolveSemanticEmbedder, type EmbedderKind } from '../drag-embedder.js';
import { synthesizeAnswer } from '../drag-synthesize.js';
import { DragReasoner, DRAG_RULE_PREDICATE, type ReasoningResult } from '../drag-reasoner.js';
import type { VerifiableCitation, CitationTriple } from '@origintrail-official/dkg-core';

// V1 default verifier. The real Coinbase/USDC facilitator drops in behind this
// same interface (config-gated) without touching the route.
const dragPaymentVerifier: PaymentVerifier = new MockPaymentVerifier();
const dragReasoner = new DragReasoner();

// ── observability: lightweight in-process counters (GET /api/answer/metrics) ──
const dragMetrics = {
  answersServed: 0,
  byMode: { keyword: 0, semantic: 0, network: 0 },
  citationsVerified: 0,
  retrievalDegraded: 0,
  synthesized: 0,
  reasoned: 0,
};
export function getDragMetrics(): typeof dragMetrics {
  return JSON.parse(JSON.stringify(dragMetrics));
}

/** Unescape an N-Triples literal object back to its raw text (rule N3 carried in a KA). */
function unquoteLiteral(o: string): string | null {
  const m = o.match(/^"((?:[^"\\]|\\.)*)"/);
  if (!m) return null;
  return m[1].replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
}

/**
 * Resolve the N3 rules to apply: auto-discover VERIFIABLE rule-KAs (verified
 * facts whose predicate is DRAG_RULE_PREDICATE — so the rules are themselves
 * chain-proven), then append any request-supplied `rules` N3.
 */
const MAX_RULES = 50;
const MAX_RULES_BYTES = 64 * 1024;
function resolveRules(
  facts: Array<{ triple: CitationTriple; citation: VerifiableCitation }>,
  requestRules?: string,
): { rulesN3: string; ruleCitations: VerifiableCitation[] } {
  // Bound rule count + total size. Auto-discovered rule-KAs are AUTHOR-untrusted
  // (any publisher to a public CG can plant one) — these caps blunt a planted
  // many-rule / huge-rule blowup. NOTE: they do NOT bound an adversarial rule's
  // RUNTIME; EYE runs in-process and an in-process timeout cannot interrupt the
  // blocking WASM (worker-thread isolation is the planned hardening — see the
  // dRAG guide). Operators exposing the API beyond loopback, or reasoning over
  // untrusted public CGs, should set `config.drag.reasoning: false`.
  const parts: string[] = [];
  const ruleCitations: VerifiableCitation[] = [];
  let bytes = 0;
  for (const f of facts) {
    if (parts.length >= MAX_RULES || bytes >= MAX_RULES_BYTES) break;
    if (f.triple.predicate === DRAG_RULE_PREDICATE) {
      const n3 = unquoteLiteral(f.triple.object);
      if (n3) {
        parts.push(n3);
        bytes += n3.length;
        ruleCitations.push(f.citation);
      }
    }
  }
  if (requestRules && requestRules.trim() && bytes < MAX_RULES_BYTES) parts.push(requestRules.slice(0, MAX_RULES_BYTES - bytes));
  return { rulesN3: parts.join('\n'), ruleCitations };
}

// Cache retrievers by embedder model so a model (esp. the local one) loads once.
const retrieverCache = new Map<string, VectorEntityRetriever>();

function retrieverFor(embedder: EmbeddingProvider | null, ctx: RequestContext): EntityRetriever | undefined {
  if (!embedder) return undefined;
  let r = retrieverCache.get(embedder.model);
  if (!r) {
    r = new VectorEntityRetriever(ctx.vectorStore, embedder, ctx.agent.store);
    retrieverCache.set(embedder.model, r);
  }
  return r;
}

export async function handleDragRoutes(ctx: RequestContext): Promise<void> {
  const { req, res, agent, path, opWallets, config } = ctx;

  // GET /api/answer/metrics — dRAG observability counters.
  if (req.method === 'GET' && path === '/api/answer/metrics') {
    jsonResponse(res, 200, getDragMetrics());
    return;
  }

  if (req.method === 'POST' && path === '/api/answer') {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(await readBody(req));
    } catch {
      jsonResponse(res, 400, { error: 'invalid JSON body' });
      return;
    }
    const question = parsed.question;
    const contextGraphId = (parsed.contextGraphId ?? parsed.projectId) as unknown;
    if (typeof question !== 'string' || !question.trim()) {
      jsonResponse(res, 400, { error: 'Missing "question"' });
      return;
    }
    if (typeof contextGraphId !== 'string' || !contextGraphId) {
      jsonResponse(res, 400, { error: 'Missing "contextGraphId" (or "projectId")' });
      return;
    }

    const experimental = config.drag?.experimentalOverrides === true;
    const paymentsEnabled = config.drag?.payments?.enabled === true;

    // ── payment gate — OFF by default. `simulatePrice` is an experimental knob;
    // real per-CG pricing is deferred, so payment only triggers when both
    // payments AND experimental overrides are enabled. ──
    let settlement: SettlementReceipt | undefined;
    const priceStr =
      experimental && paymentsEnabled && typeof parsed.simulatePrice === 'string'
        ? parsed.simulatePrice
        : undefined;
    if (priceStr) {
      const price = parsePrice(priceStr);
      if (!price) {
        jsonResponse(res, 400, { error: `invalid simulatePrice "${priceStr}" — expected e.g. "0.01 USDC"` });
        return;
      }
      const payTo =
        opWallets?.adminWallet?.address ?? opWallets?.wallets?.[0]?.address ?? '0x000000000000000000000000000000000000dEaD';
      const pay = await resolvePayment({
        price,
        network: 'base-sepolia',
        payTo,
        resource: '/api/answer',
        nonce: randomUUID(),
        xPaymentHeader: req.headers['x-payment'],
        verifier: dragPaymentVerifier,
      });
      if (pay.kind === 'challenge') {
        jsonResponse(res, 402, { ...build402Body(pay.required), ...(pay.reason ? { reason: pay.reason } : {}) });
        return;
      }
      if (pay.kind === 'paid') settlement = pay.receipt;
    }

    // ── retrieval selection ──
    // Public: retrieval = "default" | "keyword" | "semantic".
    // Experimental (gated): raw `embedder` = "keyword"|"hashing"|"local"|"openai".
    const retrievalMode = typeof parsed.retrieval === 'string' ? parsed.retrieval : undefined;
    const rawEmbedder = experimental && typeof parsed.embedder === 'string' ? (parsed.embedder as EmbedderKind) : undefined;
    let retriever: EntityRetriever | undefined;
    let forceKeyword = false;
    if (rawEmbedder === 'keyword' || retrievalMode === 'keyword') {
      forceKeyword = true;
    } else if (rawEmbedder) {
      retriever = retrieverFor(buildEmbedder(rawEmbedder, config), ctx);
    } else if (retrievalMode === 'semantic') {
      retriever = retrieverFor(resolveSemanticEmbedder(config), ctx);
    } // else "default"/undefined → the agent's attached default (config.drag.embedder)

    // ── answer ──
    const common = {
      question,
      contextGraphId,
      maxCitations: typeof parsed.maxCitations === 'number' ? parsed.maxCitations : config.drag?.maxCitations,
      maxKas: typeof parsed.maxKas === 'number' ? parsed.maxKas : config.drag?.maxKas,
    };
    const scope = parsed.scope === 'network' ? 'network' : 'local';
    const peers = Array.isArray(parsed.peers) ? parsed.peers.filter((p): p is string => typeof p === 'string') : undefined;
    const t0 = Date.now();
    try {
      const result =
        scope === 'network'
          ? await agent.dragAnswerNetwork({ ...common, peers })
          : await agent.dragAnswerLocal(common, { retriever, forceKeyword });

      // Optional grounded prose synthesis (opt-in; local scope; LLM configured).
      // NEVER mutates facts/citations — those stay the authoritative answer.
      let synthesized = false;
      if (parsed.synthesize === true && scope === 'local' && config.llm && result.facts.length > 0) {
        const prose = await synthesizeAnswer(question, result.facts, config.llm);
        if (prose) {
          result.answer = prose;
          result.llm = true;
          synthesized = true;
        }
      }

      // ── REASON (opt-in; local scope) — EYE over the CG's VERIFIED facts ──
      // derive proof-carrying conclusions (negation, transitivity, policy logic).
      // Kept SEPARATE from result.facts/citations: derived ≠ published.
      let reasoning: ReasoningResult | undefined;
      if (parsed.reason === true && scope === 'local' && config.drag?.reasoning !== false) {
        const facts = await agent.gatherVerifiedFacts(contextGraphId, { cap: config.drag?.reasoningMaxKas });
        const { rulesN3, ruleCitations } = resolveRules(facts, typeof parsed.rules === 'string' ? parsed.rules : undefined);
        if (rulesN3) {
          reasoning = await dragReasoner.reason(facts, rulesN3);
          if (ruleCitations.length) reasoning.rules = ruleCitations;
        } else {
          reasoning = { engine: 'eye-js', derived: [], note: 'no rules found — publish a rule KA (predicate ' + DRAG_RULE_PREDICATE + ') or pass `rules` N3' };
        }
        dragMetrics.reasoned++;
      }

      result.stats.latencyMs = Date.now() - t0;

      // observability counters
      dragMetrics.answersServed++;
      if (scope === 'network') dragMetrics.byMode.network++;
      else if ('retrieval' in result.stats && String(result.stats.retrieval).startsWith('vector:')) dragMetrics.byMode.semantic++;
      else dragMetrics.byMode.keyword++;
      dragMetrics.citationsVerified += result.stats.verified ?? 0;
      if ('retrievalDegraded' in result.stats && result.stats.retrievalDegraded) dragMetrics.retrievalDegraded++;
      if (synthesized) dragMetrics.synthesized++;

      jsonResponse(res, 200, {
        ...result,
        ...(reasoning ? { reasoning } : {}),
        ...(settlement ? { settlement } : {}),
      });
    } catch (e) {
      jsonResponse(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
    return;
  }
}
