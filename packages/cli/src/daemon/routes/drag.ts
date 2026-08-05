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
// inclusion + live on-chain root/author, with an EIP-712 seal when available).
// Retrieval is `keyword`
// (substring) or `semantic` (embedding ANN over the CG's entities); `default`
// uses the node's configured embedder (config.drag.embedder).
//
// `retrieval` applies to scope:"local". Network responders use a bounded
// keyword path so unauthenticated peers cannot trigger model/index work.
//
// PAYMENT (§5.4) is OFF by default (answers are free); enable with
// config.drag.payments.enabled. V1's bundled verifier returns synthetic receipts
// for integration testing; production settlement needs a real facilitator.
//
// Dev/test knobs (`embedder`, `simulatePrice`) are honoured ONLY when
// config.drag.experimentalOverrides is set — they are kept out of the public
// answer contract.

import { createHash } from 'node:crypto';
import type { RequestContext } from './context.js';
import type { EntityRetriever } from '@origintrail-official/dkg-agent';
import { jsonResponse, readBody } from '../http-utils.js';
import {
  MockPaymentVerifier,
  InMemoryPaymentChallengeStore,
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
import { DragReasoner, DRAG_RULE_PREDICATE, DRAG_RULE_STATUS, type ReasoningResult } from '../drag-reasoner.js';
import { validateContextGraphId, type VerifiableCitation, type CitationTriple } from '@origintrail-official/dkg-core';

// Development verifier only: exercises the request-bound x402 challenge flow
// but never settles funds.
const dragPaymentVerifier: PaymentVerifier = new MockPaymentVerifier();
const dragPaymentChallenges = new InMemoryPaymentChallengeStore();
const dragReasoner = new DragReasoner();
const MAX_ANSWER_BODY_BYTES = 96 * 1024;
const MAX_QUESTION_CHARS = 2_000;

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
 * Resolve the N3 rules to apply, from VERIFIABLE rule-KAs in the CG (a rule is a
 * verified fact `<rule> drag:ruleN3 "<n3>"`, typically published into a `rules`
 * sub-graph) — so the rules are themselves chain-proven — then append any
 * request-supplied `rules`. Rules are MANAGED and resolution is ORDER-INDEPENDENT
 * (facts arrive in implementation-defined store-enumeration order, which differs
 * across nodes and restarts — nothing here may depend on it):
 * - (governance) when `ruleAuthors` is set, bodies from non-allow-listed authors
 *   never compete; a rule body without a provable on-chain author never fires.
 * - A subject carrying bodies from more than one distinct (surviving) author is
 *   CONTESTED and dropped entirely — deterministic on every node, and with an
 *   allowlist a squatter cannot contest a trusted author's rule (they are
 *   filtered before the contest check). Without an allowlist a contested rule
 *   is silently absent; on public CGs set `reasoningRuleAuthors`.
 * - Within one author, the highest kaId (their newest rule KA) wins.
 * - A `drag:ruleStatus "disabled"` fact only counts from the resolved rule's own
 *   author or an allow-listed author — an arbitrary publisher cannot switch off
 *   someone else's rule.
 */
const MAX_RULES = 50;
const MAX_RULES_BYTES = 64 * 1024;
function resolveRules(
  facts: Array<{ triple: CitationTriple; citation: VerifiableCitation }>,
  requestRules?: string,
  ruleAuthors?: string[],
): { rulesN3: string; ruleCitations: VerifiableCitation[] } {
  const allow = ruleAuthors && ruleAuthors.length ? new Set(ruleAuthors.map((a) => a.toLowerCase())) : null;
  const authorOf = (c: VerifiableCitation): string => String(c.onChain?.author ?? '').toLowerCase();
  const isAllowListed = (c: VerifiableCitation): boolean => allow !== null && allow.has(authorOf(c));
  const kaNumOf = (c: VerifiableCitation): bigint => {
    try { return BigInt(String(c.kaId ?? '')); } catch { return -1n; }
  };
  // Collect every surviving candidate body per subject; the resolution below
  // must stay order-independent (see docstring).
  const candidates = new Map<string, Array<{ n3: string; citation: VerifiableCitation }>>();
  const statusFacts: Array<{ subject: string; citation: VerifiableCitation }> = [];
  for (const f of facts) {
    if (f.triple.predicate === DRAG_RULE_PREDICATE) {
      const n3 = unquoteLiteral(f.triple.object);
      if (!n3) continue;
      if (authorOf(f.citation) === '') continue; // ungovernable: no provable author
      if (allow && !isAllowListed(f.citation)) continue; // governance: never competes
      const list = candidates.get(f.triple.subject);
      if (list) list.push({ n3, citation: f.citation });
      else candidates.set(f.triple.subject, [{ n3, citation: f.citation }]);
    } else if (f.triple.predicate === DRAG_RULE_STATUS && unquoteLiteral(f.triple.object) === 'disabled') {
      statusFacts.push({ subject: f.triple.subject, citation: f.citation });
    }
  }
  // One body per subject: contested subjects (bodies from >1 distinct surviving
  // author) are dropped; within one author the newest KA wins, with the
  // lexicographically greatest n3 as a total-order tiebreak for equal kaIds.
  const bodies = new Map<string, { n3: string; citation: VerifiableCitation }>();
  for (const [subject, list] of candidates) {
    const authors = new Set(list.map((b) => authorOf(b.citation)));
    if (authors.size > 1) continue; // contested — no enumeration-order winner
    let winner = list[0];
    for (const b of list.slice(1)) {
      const d = kaNumOf(b.citation) - kaNumOf(winner.citation);
      if (d > 0n || (d === 0n && b.n3 > winner.n3)) winner = b;
    }
    bodies.set(subject, winner);
  }
  // Status facts are themselves governed: only the resolved rule's own author —
  // or, when an allowlist is configured, an allow-listed author — can disable a
  // rule. Anyone else's `drag:ruleStatus "disabled"` fact is ignored (otherwise
  // any public-CG publisher could switch off trusted rules).
  const disabled = new Set<string>();
  for (const s of statusFacts) {
    const statusAuthor = authorOf(s.citation);
    const body = bodies.get(s.subject);
    const isRuleAuthor = statusAuthor !== '' && body !== undefined && statusAuthor === authorOf(body.citation);
    if (isRuleAuthor || isAllowListed(s.citation)) disabled.add(s.subject);
  }
  // Bound rule count + total size. NOTE: caps do NOT bound an adversarial rule's
  // RUNTIME — EYE runs in-process and an in-process timeout can't interrupt the
  // blocking WASM (worker-thread isolation is the planned hardening). On public
  // CGs, set `reasoningRuleAuthors` (governance) and/or `reasoning:false`.
  const parts: string[] = [];
  const ruleCitations: VerifiableCitation[] = [];
  let bytes = 0;
  // Sorted subjects so the caps cut the same rules on every node (allowlist
  // filtering already happened at intake).
  for (const subject of [...bodies.keys()].sort()) {
    const { n3, citation } = bodies.get(subject)!;
    if (parts.length >= MAX_RULES || bytes >= MAX_RULES_BYTES) break;
    if (disabled.has(subject)) continue; // managed: a disabled rule never fires
    const room = MAX_RULES_BYTES - bytes;
    if (room <= 0) break;
    const bounded = n3.slice(0, room);
    parts.push(bounded);
    bytes += bounded.length;
    ruleCitations.push(citation);
  }
  if (requestRules && requestRules.trim() && bytes < MAX_RULES_BYTES) parts.push(requestRules.slice(0, MAX_RULES_BYTES - bytes));
  return { rulesN3: parts.join('\n'), ruleCitations };
}

// Cache within one daemon/vector store. A process-global model-only map could
// accidentally reuse another daemon's triple store or a same-named provider.
const retrieverCache = new WeakMap<object, Map<string, VectorEntityRetriever>>();

function retrieverFor(embedder: EmbeddingProvider | null, ctx: RequestContext): EntityRetriever | undefined {
  if (!embedder) return undefined;
  let daemonCache = retrieverCache.get(ctx.vectorStore);
  if (!daemonCache) {
    daemonCache = new Map<string, VectorEntityRetriever>();
    retrieverCache.set(ctx.vectorStore, daemonCache);
  }
  const providerKey = embedder.cacheKey ?? `${embedder.constructor.name}:${embedder.model}:${embedder.dimensions}`;
  let r = daemonCache.get(providerKey);
  if (!r) {
    r = new VectorEntityRetriever(ctx.vectorStore, embedder, ctx.agent.store);
    daemonCache.set(providerKey, r);
  }
  return r;
}

export async function handleDragRoutes(ctx: RequestContext): Promise<void> {
  const { req, res, agent, path, opWallets, config, requestAgentAddress } = ctx;

  // GET /api/answer/metrics — dRAG observability counters.
  if (req.method === 'GET' && path === '/api/answer/metrics') {
    jsonResponse(res, 200, getDragMetrics());
    return;
  }

  if (req.method === 'POST' && path === '/api/answer') {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(await readBody(req, MAX_ANSWER_BODY_BYTES));
    } catch {
      jsonResponse(res, 400, { error: 'invalid JSON body' });
      return;
    }
    const question = parsed.question;
    const contextGraphId = (parsed.contextGraphId ?? parsed.projectId) as unknown;
    if (typeof question !== 'string' || !question.trim() || question.length > MAX_QUESTION_CHARS) {
      jsonResponse(res, 400, { error: `"question" must be a non-empty string no longer than ${MAX_QUESTION_CHARS} characters` });
      return;
    }
    if (typeof contextGraphId !== 'string' || !contextGraphId) {
      jsonResponse(res, 400, { error: 'Missing "contextGraphId" (or "projectId")' });
      return;
    }
    const contextGraphIdCheck = validateContextGraphId(contextGraphId);
    if (!contextGraphIdCheck.valid) {
      jsonResponse(res, 400, { error: `Invalid context graph id: ${contextGraphIdCheck.reason ?? 'rejected'}` });
      return;
    }

    const scopeValue = parsed.scope ?? 'local';
    if (scopeValue !== 'local' && scopeValue !== 'network') {
      jsonResponse(res, 400, { error: '"scope" must be "local" or "network"' });
      return;
    }
    const scope: 'local' | 'network' = scopeValue;
    const experimental = config.drag?.experimentalOverrides === true;
    const paymentsEnabled = config.drag?.payments?.enabled === true;
    if (parsed.reason !== undefined && typeof parsed.reason !== 'boolean') {
      jsonResponse(res, 400, { error: '"reason" must be a boolean' });
      return;
    }
    if (parsed.synthesize !== undefined && typeof parsed.synthesize !== 'boolean') {
      jsonResponse(res, 400, { error: '"synthesize" must be a boolean' });
      return;
    }
    if (parsed.rules !== undefined && parsed.reason !== true) {
      jsonResponse(res, 400, { error: '"rules" requires "reason": true' });
      return;
    }
    if (parsed.embedder !== undefined && !experimental) {
      jsonResponse(res, 400, { error: 'per-request "embedder" requires config.drag.experimentalOverrides=true' });
      return;
    }
    if (parsed.simulatePrice !== undefined && (!experimental || !paymentsEnabled)) {
      jsonResponse(res, 400, {
        error: '"simulatePrice" requires experimental overrides and dRAG payments to be enabled',
      });
      return;
    }
    if (parsed.simulatePrice !== undefined && typeof parsed.simulatePrice !== 'string') {
      jsonResponse(res, 400, { error: '"simulatePrice" must be a price string such as "0.01 USDC"' });
      return;
    }
    const retrievalValue = parsed.retrieval ?? 'default';
    if (!['default', 'keyword', 'semantic'].includes(String(retrievalValue))) {
      jsonResponse(res, 400, { error: '"retrieval" must be "default", "keyword", or "semantic"' });
      return;
    }
    if (scope === 'network' && retrievalValue !== 'default') {
      jsonResponse(res, 400, { error: '"retrieval" applies only to local scope; network responders use bounded keyword retrieval' });
      return;
    }
    if (scope === 'network' && (parsed.reason === true || parsed.synthesize === true || parsed.rules !== undefined)) {
      jsonResponse(res, 400, { error: 'reasoning, rules, and synthesis currently require local scope' });
      return;
    }
    const boundedInteger = (value: unknown, max: number): number | undefined | 'invalid' => {
      if (value === undefined) return undefined;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) return 'invalid';
      return value;
    };
    const requestedMaxCitations = boundedInteger(parsed.maxCitations, 50);
    const requestedMaxKas = boundedInteger(parsed.maxKas, 100);
    if (requestedMaxCitations === 'invalid' || requestedMaxKas === 'invalid') {
      jsonResponse(res, 400, { error: '"maxCitations" must be 1..50 and "maxKas" must be 1..100' });
      return;
    }
    let peers: string[] | undefined;
    if (parsed.peers !== undefined) {
      if (scope !== 'network' || !Array.isArray(parsed.peers) || parsed.peers.length > 24 ||
          parsed.peers.some((p) => typeof p !== 'string' || !p.trim() || p.length > 256)) {
        jsonResponse(res, 400, { error: '"peers" must be an array of at most 24 bounded peer IDs in network scope' });
        return;
      }
      peers = [...new Set((parsed.peers as string[]).map((peer) => peer.trim()))];
    }
    if (parsed.rules !== undefined && (typeof parsed.rules !== 'string' || parsed.rules.length > MAX_RULES_BYTES)) {
      jsonResponse(res, 400, { error: `"rules" must be a string no larger than ${MAX_RULES_BYTES} bytes` });
      return;
    }
    if (
      experimental && parsed.embedder !== undefined &&
      (typeof parsed.embedder !== 'string' || !['keyword', 'hashing', 'local', 'openai'].includes(parsed.embedder))
    ) {
      jsonResponse(res, 400, { error: 'experimental "embedder" must be "keyword", "hashing", "local", or "openai"' });
      return;
    }

    // dRAG reads the same private VM graphs as query. Enforce the caller's CG
    // membership before retrieval, model calls, reasoning, or payment.
    const canRead = await agent.canReadContextGraph(contextGraphId, {
      callerAgentAddress: requestAgentAddress || undefined,
    }).catch(() => false);
    if (!canRead) {
      jsonResponse(res, 403, { error: `Not authorized to read context graph "${contextGraphId}"` });
      return;
    }
    const privateContextGraph = scope === 'local'
      ? await agent.isPrivateContextGraph(contextGraphId).catch(() => true)
      : false;
    if (
      privateContextGraph &&
      config.drag?.allowPrivateModelCalls !== true &&
      (retrievalValue === 'semantic' || parsed.synthesize === true ||
        (experimental && typeof parsed.embedder === 'string' && !['keyword', 'hashing'].includes(parsed.embedder)))
    ) {
      jsonResponse(res, 400, {
        error: 'private context graph model calls are disabled; use keyword retrieval or set config.drag.allowPrivateModelCalls=true',
      });
      return;
    }

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
      const resourceDigest = createHash('sha256')
        .update(JSON.stringify({
          callerAgentAddress: requestAgentAddress,
          question,
          contextGraphId,
          scope,
          retrieval: retrievalValue,
          peers,
          maxCitations: requestedMaxCitations,
          maxKas: requestedMaxKas,
          synthesize: parsed.synthesize === true,
          reason: parsed.reason === true,
          rules: typeof parsed.rules === 'string' ? parsed.rules : undefined,
          embedder: experimental && typeof parsed.embedder === 'string' ? parsed.embedder : undefined,
        }))
        .digest('hex');
      const pay = await resolvePayment({
        price,
        network: 'base-sepolia',
        payTo,
        resource: `/api/answer#${resourceDigest}`,
        xPaymentHeader: req.headers['x-payment'],
        verifier: dragPaymentVerifier,
        challengeStore: dragPaymentChallenges,
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
    const retrievalMode = retrievalValue as 'default' | 'keyword' | 'semantic';
    const rawEmbedder = experimental && typeof parsed.embedder === 'string' ? (parsed.embedder as EmbedderKind) : undefined;
    let retriever: EntityRetriever | undefined;
    let forceKeyword = false;
    if (rawEmbedder === 'keyword' || retrievalMode === 'keyword') {
      forceKeyword = true;
    } else if (rawEmbedder) {
      const explicit = buildEmbedder(rawEmbedder, config);
      if (!explicit) {
        // An EXPLICIT override must never silently answer with the node default —
        // in an A/B run that would silently attribute default results to the
        // requested provider.
        jsonResponse(res, 400, {
          error: `experimental embedder "${rawEmbedder}" is not available on this node (missing credentials or baseURL)`,
        });
        return;
      }
      retriever = retrieverFor(explicit, ctx);
    } else if (retrievalMode === 'semantic') {
      retriever = retrieverFor(resolveSemanticEmbedder(config), ctx);
    } // else "default"/undefined → the agent's attached default (config.drag.embedder)
    // A private CG with default retrieval must not inherit a node-wide hosted
    // embedder unless the operator explicitly enabled private model calls.
    if (privateContextGraph && config.drag?.allowPrivateModelCalls !== true) {
      retriever = undefined;
      forceKeyword = true;
    }

    // ── answer ──
    const common = {
      question,
      contextGraphId,
      maxCitations: requestedMaxCitations ?? config.drag?.maxCitations,
      maxKas: requestedMaxKas ?? config.drag?.maxKas,
    };
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
        const verifiedFacts = result.citations
          .map((citation, index) => ({ citation, index }))
          .filter(({ citation }) => citation.checks.verified === true)
          .map(({ citation, index }) => ({ ...citation.triple, source: result.facts[index]?.source ?? index + 1 }));
        const prose = await synthesizeAnswer(question, verifiedFacts, config.llm);
        if (prose) {
          result.answer = prose;
          result.llm = true;
          synthesized = true;
        }
      }

      // ── REASON (opt-in; local scope) — EYE over the CG's VERIFIED facts ──
      // derive conclusions with verified supporting evidence (negation,
      // transitivity, policy logic).
      // Kept SEPARATE from result.facts/citations: derived ≠ published.
      let reasoning: ReasoningResult | undefined;
      if (parsed.reason === true && scope === 'local') {
        if (config.drag?.reasoning !== true) {
          reasoning = { engine: 'eye-js', derived: [], note: 'reasoning is disabled; set config.drag.reasoning=true to opt in' };
        } else {
          const gathered = await agent.gatherVerifiedFacts(contextGraphId, { cap: config.drag?.reasoningMaxKas });
          if (!gathered.complete) {
            reasoning = {
              engine: 'eye-js', derived: [],
              note: `reasoning refused: verified fact set is incomplete (${gathered.graphsSkipped} skipped, truncated=${gathered.truncated})`,
            };
          } else {
            const { rulesN3, ruleCitations } = resolveRules(
              gathered.facts,
              typeof parsed.rules === 'string' ? parsed.rules : undefined,
              config.drag?.reasoningRuleAuthors,
            );
            if (rulesN3) {
              reasoning = await dragReasoner.reason(gathered.facts, rulesN3);
              if (ruleCitations.length) reasoning.rules = ruleCitations;
            } else {
              reasoning = { engine: 'eye-js', derived: [], note: 'no rules found — publish a rule KA (predicate ' + DRAG_RULE_PREDICATE + ') or pass `rules` N3' };
            }
          }
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
