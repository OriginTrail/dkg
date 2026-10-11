// SPDX-License-Identifier: Apache-2.0
import type { AssertionHistoryDescriptor, DKGAgent } from './dkg-agent.js';
import {
  admitContextGraphReadCaller,
  contextGraphReadAuthorityDependencyOf,
  type ContextGraphCallerReadAdmission,
  unavailableContextGraphReadAuthorityDecision,
  type ContextGraphReadAuthorityDecision,
} from './context-graph-read-authority.js';

const AGENT_NUMBER_RE = /^0x[0-9a-fA-F]{40}:[0-9]+$/;

/** Read-only compact aliases also remain valid literal names on mutation paths. */
export function classifyKaIdentifier(
  seg: string,
  opts: { includeCompact?: boolean } = {},
): { kind: 'kaId'; kaId: bigint } | { kind: 'name' } {
  if (seg.startsWith('did:dkg:')) {
    const idPart = seg.slice(seg.lastIndexOf('/') + 1);
    if (/^[0-9]+$/.test(idPart)) {
      try {
        const numericId = BigInt(idPart);
        if (numericId <= ((1n << 96n) - 1n)) {
          const withoutId = seg.slice(0, seg.lastIndexOf('/'));
          const authorPart = withoutId.slice(withoutId.lastIndexOf('/') + 1);
          if (/^0x[0-9a-fA-F]{40}$/.test(authorPart)) {
            return { kind: 'kaId', kaId: (BigInt(authorPart) << 96n) | numericId };
          }
        }
        return { kind: 'kaId', kaId: numericId };
      } catch { /* preserve a non-identifier as a literal name */ }
    }
    return { kind: 'name' };
  }
  if ((opts.includeCompact ?? true) && AGENT_NUMBER_RE.test(seg)) {
    const [agentHex, numberStr] = seg.split(':');
    try {
      return { kind: 'kaId', kaId: (BigInt(agentHex) << 96n) | BigInt(numberStr) };
    } catch { /* preserve a non-identifier as a literal name */ }
  }
  return { kind: 'name' };
}

export interface KnowledgeAssetReadTarget {
  readonly kind: 'name' | 'kaId';
  readonly cg: string;
  readonly subGraphName?: string;
  readonly agentAddress?: string;
  readonly name: string;
  readonly descriptor: AssertionHistoryDescriptor | null;
}

/** Literal targets have already been normalized by their owning caller. */
export type KnowledgeAssetReadInput = {
  cg: string;
  name: string;
  subGraphName?: string;
  agentAddress?: string;
  layer?: string;
} & (
  | { kind: 'literal'; lookup: 'none' }
  | { kind: 'identifier'; lookup: 'descriptor' | 'quads' }
);

export interface KnowledgeAssetReadOptions {
  callerAgentAddress?: string;
  signal?: AbortSignal;
  /** Trusted daemon operator access preserves its existing graph-read bypass. */
  nodeOperator?: boolean;
}

export type KnowledgeAssetReadResolution =
  | (Extract<ContextGraphCallerReadAdmission, { outcome: 'admitted' }> & { readonly target: KnowledgeAssetReadTarget })
  | (Exclude<ContextGraphCallerReadAdmission, { outcome: 'admitted' }> & { readonly target: null });

/** KA admission, author lanes and literal-before-alias precedence have one owner. */
export async function resolveKnowledgeAssetRead(
  agent: DKGAgent,
  input: KnowledgeAssetReadInput,
  options: KnowledgeAssetReadOptions,
): Promise<KnowledgeAssetReadResolution> {
  const { callerAgentAddress: caller, signal } = options;
  const { cg, name, subGraphName } = input;
  signal?.throwIfAborted();
  let decision: ContextGraphReadAuthorityDecision = options.nodeOperator
    ? { outcome: 'allowed', source: 'system', reason: 'node-operator-read', grantScope: 'node', metadataBootstrap: 'forbidden' }
    : await agent.resolveContextGraphReadAuthority(cg, { callerAgentAddress: caller, signal });
  signal?.throwIfAborted();
  const identifier = input.kind === 'literal' ? { kind: 'name' as const } : classifyKaIdentifier(name);
  const { agentAddress } = input;
  let literalLookup: Promise<AssertionHistoryDescriptor | null> | undefined;
  const readLiteral = () => literalLookup ??= agent.assertion.history(cg, name, { agentAddress, subGraphName });
  const ownIdentifier = identifier.kind === 'name' || (agentAddress !== undefined
    && (identifier.kaId >> 96n) === BigInt(agentAddress));
  if (decision.outcome === 'allowed' && decision.source === 'legacy-local' && decision.grantScope === 'node'
    && caller !== undefined && agentAddress?.toLowerCase() === caller.toLowerCase()
    && (input.layer === undefined || input.layer === 'wm') && (ownIdentifier || AGENT_NUMBER_RE.test(name))) {
    try {
      const local = await agent.isLocalFirstUnregisteredContextGraph(cg);
      signal?.throwIfAborted();
      if (local) {
        const meta = await agent.getCgMeta(cg, { signal });
        signal?.throwIfAborted();
        const curator = await agent.getContextGraphCurator(cg, { signal });
        signal?.throwIfAborted();
        if (!meta.revokedAgents.some(address => address.toLowerCase() === caller.toLowerCase())
          && agent.curatorDidMatchesChecksumAgent(curator ?? undefined, caller)) {
          // Only an actual caller-lane lifecycle can turn a foreign alias into
          // a literal draft. An explicitly literal target needs no alias lifecycle.
          const literalAdmitted = ownIdentifier || await readLiteral() !== null;
          signal?.throwIfAborted();
          if (literalAdmitted) decision = { ...decision, grantScope: 'caller', reason: 'local-curator-draft' };
        }
      }
    } catch (error) {
      signal?.throwIfAborted();
      return { outcome: 'unavailable', decision: unavailableContextGraphReadAuthorityDecision(
        'legacy-local', 'draft-provenance-unavailable', contextGraphReadAuthorityDependencyOf(error),
      ), target: null };
    }
  }
  const admission = admitContextGraphReadCaller(decision, options.nodeOperator ? undefined : caller);
  if (admission.outcome !== 'admitted') return { ...admission, target: null };
  const target: KnowledgeAssetReadTarget = { kind: identifier.kind, cg, name, subGraphName, agentAddress, descriptor: null };
  if (input.lookup === 'none' || (identifier.kind === 'name' && input.lookup === 'quads')) return { ...admission, target };
  let descriptor: AssertionHistoryDescriptor | null;
  if (identifier.kind === 'kaId') {
    const literal = AGENT_NUMBER_RE.test(name) ? await readLiteral() : null;
    signal?.throwIfAborted();
    descriptor = literal ?? await agent.assertion.resolveByKaId?.(cg, identifier.kaId, { subGraphName }) ?? null;
  } else {
    descriptor = await readLiteral();
  }
  signal?.throwIfAborted();
  return { ...admission, target: { ...target, name: descriptor?.name ?? name, descriptor } };
}
