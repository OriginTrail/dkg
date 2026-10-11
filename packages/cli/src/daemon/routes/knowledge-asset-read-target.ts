// SPDX-License-Identifier: Apache-2.0
import type { KnowledgeAssetDraftReadAuthorityResolution } from '@origintrail-official/dkg-agent/dist/context-graph-read-authority.js';
type AssertionHistoryDescriptor = NonNullable<KnowledgeAssetDraftReadAuthorityResolution['literalDescriptor']>;
import { requireKnowledgeAssetDraftReadAuthority } from './context-graph-read-authority.js';
import type { RequestContext } from './context.js';

/**
 * OT-RFC-43 B3 — classify the leading path segment as a KA identifier:
 *   (a) `did:dkg:.../<id>`        → the trailing `/<id>` is the packed kaId
 *   (b) `0x<agent>:<number>`      → (agent, number), but only on read paths
 *   (c) anything else             → a plain assertion NAME (current behavior)
 * The compact form stays enabled for GET/read compatibility. Create/mutation
 * call sites pass `includeCompact: false` so historically-valid literal names
 * like `0xabc...:7` remain creatable and mutable.
 */
const AGENT_NUMBER_RE = /^0x[0-9a-fA-F]{40}:[0-9]+$/;

export function classifyKaIdentifier(
  seg: string,
  opts: { includeCompact?: boolean } = {},
): { kind: "kaId"; kaId: bigint } | { kind: "name" } {
  const includeCompact = opts.includeCompact ?? true;
  if (seg.startsWith("did:dkg:")) {
    // Rootless V2 uses the author-scoped identity
    //   did:dkg:<chain>/<author>/<per-author-number>
    // while the legacy/canonical on-chain form carries an already-packed id
    // in the last segment. Reconstruct the packed id for the rootless form so
    // resolveByKaId can recover the lifecycle author after a cross-node sync.
    // A value larger than the 96-bit per-author range is already packed and
    // must remain byte-for-byte unchanged.
    const idPart = seg.slice(seg.lastIndexOf("/") + 1);
    if (/^[0-9]+$/.test(idPart)) {
      try {
        const numericId = BigInt(idPart);
        if (numericId <= ((1n << 96n) - 1n)) {
          const withoutId = seg.slice(0, seg.lastIndexOf("/"));
          const authorPart = withoutId.slice(withoutId.lastIndexOf("/") + 1);
          if (/^0x[0-9a-fA-F]{40}$/.test(authorPart)) {
            return { kind: "kaId", kaId: (BigInt(authorPart) << 96n) | numericId };
          }
        }
        return { kind: "kaId", kaId: numericId };
      } catch {
        /* fall through to name */
      }
    }
    return { kind: "name" };
  }
  if (includeCompact && AGENT_NUMBER_RE.test(seg)) {
    const [agentHex, numberStr] = seg.split(":");
    try {
      const kaId = (BigInt(agentHex) << 96n) | BigInt(numberStr);
      return { kind: "kaId", kaId };
    } catch {
      return { kind: "name" };
    }
  }
  return { kind: "name" };
}


export interface KnowledgeAssetReadTarget {
  readonly kind: 'name' | 'kaId';
  readonly cg: string;
  readonly subGraphName?: string;
  readonly agentAddress?: string;
  readonly name: string;
  readonly descriptor: AssertionHistoryDescriptor | null;
}

/** Admission and identifier precedence share the same caller-lane resource evidence. */
export async function resolveKnowledgeAssetReadTarget(
  ctx: RequestContext,
  input: Omit<KnowledgeAssetReadTarget, 'descriptor' | 'kind'> & {
    layer?: string;
    read: 'descriptor' | 'quads' | 'extraction-status';
  },
): Promise<KnowledgeAssetReadTarget | null> {
  const { cg, name, agentAddress, subGraphName } = input;
  const identifier = classifyKaIdentifier(name);
  const ownDraftIdentifier = identifier.kind === 'name' || (agentAddress !== undefined
    && (identifier.kaId >> 96n) === BigInt(agentAddress));
  // A compact spelling can still be a literal name in this author's lane.
  // The draft authority owner verifies its lifecycle after resolving authority.
  const draft = (input.layer === undefined || input.layer === 'wm') && agentAddress !== undefined
    && (ownDraftIdentifier || AGENT_NUMBER_RE.test(name))
    ? { agentAddress, ...(ownDraftIdentifier ? {} : { literalName: name, subGraphName }) } : undefined;
  const evidence = await requireKnowledgeAssetDraftReadAuthority(ctx, cg, draft);
  if (evidence === null) return null;
  const target = { kind: identifier.kind, cg, name, subGraphName, agentAddress, descriptor: evidence.literalDescriptor ?? null };
  // Extraction metadata retains the request actor's lane and literal key. A
  // plain-name quads read remains valid without a lifecycle descriptor.
  if (input.read === 'extraction-status' || (identifier.kind === 'name' && input.read === 'quads')) return target;
  let descriptor: AssertionHistoryDescriptor | null;
  if (identifier.kind === 'kaId') {
    // Compact identifiers are also historical literal names. Reuse any
    // admitted lookup (including a miss) before falling back to the packed id.
    let literal = evidence.literalDescriptor;
    if (AGENT_NUMBER_RE.test(name) && literal === undefined) {
      literal = await ctx.agent.assertion.history(cg, name, { agentAddress, subGraphName });
    }
    descriptor = literal ?? await ctx.agent.assertion.resolveByKaId?.(cg, identifier.kaId, { subGraphName }) ?? null;
  } else {
    // Explicit inspection author lanes are separate from extraction actor lanes.
    descriptor = await ctx.agent.assertion.history(cg, name, { subGraphName, ...(agentAddress ? { agentAddress } : {}) });
  }
  return { ...target, name: descriptor?.name ?? name, descriptor };
}
