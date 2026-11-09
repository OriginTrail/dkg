// daemon/routes/shared-memory-host-catchup.ts
//
// POST /api/shared-memory/host-catchup (OT-RFC-38 LU-6), the operator's way to
// confirm what a hosting core holds for a curated graph. Moved out of
// `memory.ts` (a file under the file-size ratchet) when the page size and the
// served-entries report were added; the route body is the same.

import { jsonResponse, readBody, safeParseJson, SMALL_BODY_BYTES } from '../http-utils.js';
import type { RequestContext } from './context.js';

/**
 * Body: { contextGraphId: string, peerId?: string, sinceSeqno?: number, maxRounds?: number,
 *         maxEntriesPerRound?: number, includeEntries?: boolean }
 *
 * `maxEntriesPerRound` sets the page size asked of each host. The agent
 * signs and sends the value capped at the protocol's limit of 1024 entries.
 * `includeEntries` adds, per peer, the seqno and SHA-256 of every envelope
 * that peer served, in order: the evidence of what a host holds.
 *
 * Pulls opaque ciphertext envelopes from cores that have been
 * hosting the curated CG's SWM substrate and re-applies each
 * through the local agent so the existing Sender-Key decrypt
 * path runs verbatim. Distinct from the "fallback" leg embedded
 * in /catchup -- exposed so operators can debug host
 * hosting independently (e.g. to confirm a specific core has
 * stored ciphertext for a CG).
 *
 * Returns false for requests this route does not own.
 */
export async function handleSharedMemoryHostCatchupRoute(ctx: RequestContext): Promise<boolean> {
  const { req, res, agent, path } = ctx;
  if (!(req.method === 'POST' && path === '/api/shared-memory/host-catchup')) return false;

  const body = await readBody(req, SMALL_BODY_BYTES);
  const parsed = safeParseJson(body, res);
  if (!parsed) return true;
  if (typeof parsed.contextGraphId !== 'string' || !parsed.contextGraphId.trim()) {
    jsonResponse(res, 400, { error: 'Missing or invalid "contextGraphId"' });
    return true;
  }
  const cgId = parsed.contextGraphId.trim();
  const peerIdParam = typeof parsed.peerId === 'string' ? parsed.peerId.trim() : undefined;
  const sinceSeqno = typeof parsed.sinceSeqno === 'number' && parsed.sinceSeqno >= 0 ? Math.floor(parsed.sinceSeqno) : 0;
  const maxRounds = typeof parsed.maxRounds === 'number' && parsed.maxRounds > 0 ? Math.min(64, Math.floor(parsed.maxRounds)) : 8;
  // Left undefined unless asked for, so the host's own default page applies.
  const maxEntriesPerRound = typeof parsed.maxEntriesPerRound === 'number' && parsed.maxEntriesPerRound >= 1
    ? Math.floor(parsed.maxEntriesPerRound)
    : undefined;
  const reportEntries = parsed.includeEntries === true;
  if (typeof (agent as any).catchupSwmFromConnectedHosts !== 'function') {
    jsonResponse(res, 501, { error: 'Host-catchup is not supported on this agent build' });
    return true;
  }
  try {
    const peerResults = await (agent as any).catchupSwmFromConnectedHosts(cgId, {
      peers: peerIdParam ? [peerIdParam] : undefined,
      sinceSeqno,
      maxRounds,
      ...(maxEntriesPerRound !== undefined ? { maxEntriesPerRound } : {}),
      ...(reportEntries ? { reportEntries } : {}),
    });
    // Codex PR #610 R2: report triples (`appliedTriples`) as the
    // user-facing total; keep envelope count alongside as
    // `appliedEnvelopes` for diagnostics. Same fix as the
    // `/catchup` fallback leg in memory.ts.
    const appliedTotal = peerResults.reduce((sum: number, r: any) => sum + (r.appliedTriples ?? 0), 0);
    const appliedEnvelopes = peerResults.reduce((sum: number, r: any) => sum + (r.applied ?? 0), 0);
    const fetchedTotal = peerResults.reduce((sum: number, r: any) => sum + (r.fetched ?? 0), 0);
    jsonResponse(res, 200, {
      contextGraphId: cgId,
      peers: peerResults,
      appliedTotal,
      appliedEnvelopes,
      fetchedTotal,
    });
  } catch (err: any) {
    jsonResponse(res, 500, { error: err?.message ?? String(err) });
  }
  return true;
}
