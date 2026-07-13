import { RateLimiter, validateContextGraphId } from '@origintrail-official/dkg-core';

export interface DragRemoteRequest {
  question: string;
  contextGraphId: string;
  maxCitations?: number;
  maxKas?: number;
}

export interface DragRemoteHandlerDeps {
  isContextGraphPublic(contextGraphId: string): Promise<boolean>;
  answerLocal(
    request: DragRemoteRequest,
    opts: { forceKeyword: true },
  ): Promise<unknown>;
}

export interface DragRemoteHandlerOptions {
  maxKas?: number;
  maxCitations?: number;
  maxQuestionChars?: number;
  maxPayloadBytes?: number;
  maxPerPeerPerMinute?: number;
  maxGlobalPerMinute?: number;
  maxConcurrent?: number;
}

/**
 * Build the unauthenticated public-CG dRAG responder.
 *
 * Network serving is operator opt-in. Even then, the handler has both per-peer
 * and node-wide budgets and forces keyword retrieval: a remote caller must not
 * trigger whole-CG vector indexing, hosted embedding calls, or a brute-force
 * vector scan. The response remains proof-carrying, so askers can independently
 * re-verify every fact.
 */
export function createDragRemoteHandler(
  deps: DragRemoteHandlerDeps,
  options: DragRemoteHandlerOptions = {},
): (data: Uint8Array, peerId: string) => Promise<Uint8Array> {
  const maxKas = options.maxKas ?? 15;
  const maxCitations = options.maxCitations ?? 15;
  const maxQuestionChars = options.maxQuestionChars ?? 2_000;
  const maxPayloadBytes = options.maxPayloadBytes ?? 16 * 1024;
  const maxConcurrent = options.maxConcurrent ?? 2;
  const perPeer = new RateLimiter({
    maxPerWindow: options.maxPerPeerPerMinute ?? 30,
    windowMs: 60_000,
  });
  const global = new RateLimiter({
    maxPerWindow: options.maxGlobalPerMinute ?? 120,
    windowMs: 60_000,
  });
  let inFlight = 0;

  const encode = (obj: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(obj));
  const clamp = (value: unknown, ceiling: number): number =>
    typeof value === 'number' && Number.isInteger(value) && value > 0
      ? Math.min(value, ceiling)
      : ceiling;

  return async (data: Uint8Array, peerId: string): Promise<Uint8Array> => {
    if (data.byteLength > maxPayloadBytes) return encode({ error: 'dRAG: request payload too large' });
    if (!perPeer.allow(peerId || 'unknown')) return encode({ error: 'dRAG: peer rate limited' });
    if (!global.allow('all')) return encode({ error: 'dRAG: node rate limited' });
    if (inFlight >= maxConcurrent) return encode({ error: 'dRAG: responder busy' });

    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder().decode(data));
    } catch {
      return encode({ error: 'invalid dRAG request payload' });
    }
    if (!raw || typeof raw !== 'object') return encode({ error: 'invalid dRAG request payload' });
    const req = raw as Record<string, unknown>;
    const question = req.question;
    const contextGraphId = req.contextGraphId;
    if (
      typeof question !== 'string' ||
      !question.trim() ||
      question.length > maxQuestionChars ||
      typeof contextGraphId !== 'string' ||
      !contextGraphId
    ) {
      return encode({ error: 'dRAG request requires a bounded question + contextGraphId' });
    }
    const idCheck = validateContextGraphId(contextGraphId);
    if (!idCheck.valid) {
      return encode({ error: `dRAG: invalid contextGraphId — ${idCheck.reason ?? 'rejected'}` });
    }

    inFlight++;
    try {
      if (!(await deps.isContextGraphPublic(contextGraphId))) {
        return encode({ error: `context graph "${contextGraphId}" is not public — dRAG fan-out is public-only` });
      }
      const result = await deps.answerLocal(
        {
          question,
          contextGraphId,
          maxCitations: clamp(req.maxCitations, maxCitations),
          maxKas: clamp(req.maxKas, maxKas),
        },
        { forceKeyword: true },
      );
      return encode(result);
    } catch (error) {
      return encode({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      inFlight--;
    }
  };
}
