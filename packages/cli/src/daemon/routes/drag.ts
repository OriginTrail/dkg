// daemon/routes/drag.ts
//
// dRAG routes (OT-RFC-55).
//
//   POST /api/answer { question, contextGraphId, scope?, peers?, maxCitations?, maxKas?, simulatePrice? }
//     -> agent.dragAnswerLocal | dragAnswerNetwork
//     -> { answer, citations[], facts[], stats, perNode?, settlement? }
//
// Each citation in the response is independently auditable against the chain
// (V10 Merkle inclusion + on-chain root + EIP-712 author seal). No LLM is
// required — retrieval is keyword/structural (the demoable baseline).
//
// PAYMENT (OT-RFC-55 §5.4): public CGs are FREE in V1. The x402 wire format +
// pluggable PaymentVerifier are wired here so monetization is one swap away.
// `simulatePrice` (e.g. "0.01 USDC") is a demo/test knob that exercises the
// full 402 -> X-PAYMENT -> 200+receipt flow with the MockPaymentVerifier;
// real per-CG pricing + the live facilitator are deferred (see PR notes).

import { randomUUID } from 'node:crypto';
import type { RequestContext } from './context.js';
import { jsonResponse, readBody } from '../http-utils.js';
import {
  MockPaymentVerifier,
  parsePrice,
  resolvePayment,
  build402Body,
  type PaymentVerifier,
  type SettlementReceipt,
} from '../payment.js';

// V1 default verifier. The real Coinbase/USDC facilitator drops in behind this
// same interface (config-gated) without touching the route.
const dragPaymentVerifier: PaymentVerifier = new MockPaymentVerifier();

export async function handleDragRoutes(ctx: RequestContext): Promise<void> {
  const { req, res, agent, path, opWallets } = ctx;

  // POST /api/answer — grounded, cited answer (local or network).
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

    // ── payment gate (localized; default free) ──────────────────────────────
    const priceStr = typeof parsed.simulatePrice === 'string' ? parsed.simulatePrice : undefined;
    let settlement: SettlementReceipt | undefined;
    if (priceStr) {
      const price = parsePrice(priceStr);
      if (!price) {
        jsonResponse(res, 400, { error: `invalid simulatePrice "${priceStr}" — expected e.g. "0.01 USDC"` });
        return;
      }
      const payTo =
        opWallets?.adminWallet?.address ??
        opWallets?.wallets?.[0]?.address ??
        '0x000000000000000000000000000000000000dEaD';
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
        jsonResponse(res, 402, {
          ...build402Body(pay.required),
          ...(pay.reason ? { reason: pay.reason } : {}),
        });
        return;
      }
      if (pay.kind === 'paid') settlement = pay.receipt;
    }

    // ── answer ──────────────────────────────────────────────────────────────
    const scope = parsed.scope === 'network' ? 'network' : 'local';
    const common = {
      question,
      contextGraphId,
      maxCitations: typeof parsed.maxCitations === 'number' ? parsed.maxCitations : undefined,
      maxKas: typeof parsed.maxKas === 'number' ? parsed.maxKas : undefined,
    };
    const peers = Array.isArray(parsed.peers)
      ? parsed.peers.filter((p): p is string => typeof p === 'string')
      : undefined;
    try {
      const result =
        scope === 'network'
          ? await agent.dragAnswerNetwork({ ...common, peers })
          : await agent.dragAnswerLocal(common);
      jsonResponse(res, 200, settlement ? { ...result, settlement } : result);
    } catch (e) {
      jsonResponse(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
    return;
  }
}
