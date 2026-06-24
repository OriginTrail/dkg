// daemon/routes/drag.ts
//
// dRAG routes (OT-RFC-55). P2 ships the single-node grounded+cited answer:
//
//   POST /api/answer { question, contextGraphId, maxCitations?, maxKas? }
//     -> agent.dragAnswerLocal -> { answer, citations[], facts[], stats }
//
// Each citation in the response is independently auditable against the chain
// (V10 Merkle inclusion + on-chain root + EIP-712 author seal). No LLM is
// required — retrieval is keyword/structural (the demoable baseline).

import type { RequestContext } from './context.js';
import { jsonResponse, readBody } from '../http-utils.js';

export async function handleDragRoutes(ctx: RequestContext): Promise<void> {
  const { req, res, agent, path } = ctx;

  // POST /api/answer — single-node grounded, cited answer.
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
    try {
      const result = await agent.dragAnswerLocal({
        question,
        contextGraphId,
        maxCitations: typeof parsed.maxCitations === 'number' ? parsed.maxCitations : undefined,
        maxKas: typeof parsed.maxKas === 'number' ? parsed.maxKas : undefined,
      });
      jsonResponse(res, 200, result);
    } catch (e) {
      jsonResponse(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
    return;
  }
}
