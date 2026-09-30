// Frozen old 10.0.20/150d1232ff request field allowlist and pipe parser.
// Only method receiver/names and import paths are adapted for a fixture.
import { SYSTEM_CONTEXT_GRAPHS } from '@origintrail-official/dkg-core';
import { SYNC_PAGE_SIZE } from '../../src/dkg-agent-constants.js';
import { normalizeSyncPhase } from '../../src/dkg-agent-helpers.js';
import type { SyncRequestEnvelope } from '../../src/dkg-agent-types.js';
import { normalizeExactAssetUals } from '../../src/sync/exact-assets.js';
import { normalizeByteBudgetPageHint, decodePipeSyncRequestTail } from './sync-pipe-tail-10.0.20.fixture.js';
export function parseOldSyncRequest(data: Uint8Array): SyncRequestEnvelope {
    const text = new TextDecoder().decode(data).trim();
    if (text.startsWith('{')) {
      let parsed: SyncRequestEnvelope;
      try {
        parsed = JSON.parse(text) as SyncRequestEnvelope;
      } catch {
        // Malformed JSON — fall through to pipe-delimited parsing
        return parseOldPipeDelimitedSyncRequest(text);
      }
      return {
        contextGraphId: parsed.contextGraphId,
        offset: parsed.offset ?? 0,
        limit: Math.min(parsed.limit ?? SYNC_PAGE_SIZE, SYNC_PAGE_SIZE),
        includeSharedMemory: parsed.includeSharedMemory ?? false,
        phase: normalizeSyncPhase(parsed.phase),
        snapshotRef: typeof parsed.snapshotRef === 'string' ? parsed.snapshotRef : undefined,
        authPurpose: typeof parsed.authPurpose === 'string' ? parsed.authPurpose : undefined,
        authSelector: typeof parsed.authSelector === 'string' ? parsed.authSelector : undefined,
        ...normalizeByteBudgetPageHint(parsed.pageMode, parsed.pageRowsHint),
        targetPeerId: parsed.targetPeerId,
        requesterPeerId: parsed.requesterPeerId,
        requestId: parsed.requestId,
        issuedAtMs: parsed.issuedAtMs,
        requesterIdentityId: parsed.requesterIdentityId,
        requesterAgentAddress: parsed.requesterAgentAddress,
        requesterSignatureR: parsed.requesterSignatureR,
        requesterSignatureVS: parsed.requesterSignatureVS,
        syncSessionId: typeof parsed.syncSessionId === 'string' ? parsed.syncSessionId : undefined,
        // Phase C: unsigned delta hint. Validated/normalised in the responder.
        sinceBatchId: typeof parsed.sinceBatchId === 'string' ? parsed.sinceBatchId : undefined,
        // Exact-asset filter is narrowing-only. Present-but-invalid must remain
        // an empty filter so the responder serves nothing instead of silently
        // expanding the request into a full Context Graph scan.
        assetUals: normalizeExactAssetUals(parsed.assetUals),
        // R9 (SECURITY): the unsigned member-recovery marker. This is a STRICT
        // FIELD ALLOWLIST — anything not copied here is dropped. If `recovery`
        // were omitted, the responder would never see it, silently fall through
        // to the fail-open participant/peer path, and the members-only gate
        // would be dead code. Coerce to a real boolean so a truthy non-bool
        // can't smuggle through.
        recovery: parsed.recovery === true ? true : undefined,
      };
    }

    return parseOldPipeDelimitedSyncRequest(text);
  }

export function parseOldPipeDelimitedSyncRequest(text: string): SyncRequestEnvelope {
    const parts = text.split('|');
    const ctxGraphPart = parts[0] || '';
    const includeSharedMemory = ctxGraphPart.startsWith('workspace:');
    const contextGraphId = includeSharedMemory ? ctxGraphPart.slice('workspace:'.length) : (ctxGraphPart || SYSTEM_CONTEXT_GRAPHS.AGENTS);
    const phase = normalizeSyncPhase(parts[3]);
    const tail = decodePipeSyncRequestTail(parts);
    return {
      contextGraphId,
      offset: parseInt(parts[1], 10) || 0,
      limit: Math.min(parseInt(parts[2], 10) || SYNC_PAGE_SIZE, SYNC_PAGE_SIZE),
      includeSharedMemory,
      phase,
      snapshotRef: phase === 'snapshot' ? parts[4] : undefined,
      ...tail,
    };
  }

