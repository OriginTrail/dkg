// SPDX-License-Identifier: Apache-2.0

import {
  DKG_ONTOLOGY,
  SYSTEM_CONTEXT_GRAPHS,
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
} from '@origintrail-official/dkg-core';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import type { TripleStore } from '@origintrail-official/dkg-storage';

import { inferAdapterPublisherAddress } from './dkg-agent-helpers.js';
import { buildAuthoritativePrivateMetaAskQuery } from
  './context-graph-private-meta-proof.js';
import { buildAuthoritativePublicMetaAskQuery } from
  './context-graph-public-meta-proof.js';
import type { ActivePublicContextGraphChainProof } from
  './active-public-context-graph-chain-proof.js';
import { isPublicMetaDurabilityPending } from
  './context-graph-public-meta-repair.js';
import type { ApprovedMemberProof } from './context-graph-member-proof.js';
import type { ApprovedMemberAcceptance } from
  './internal/context-graph-authority/approved-member-acceptance.js';

/**
 * What a confirmation is for.
 *
 * - `read` (the default): the local metadata is authoritative for reads. A
 *   public definition confirms on its own, because public reads never depend
 *   on membership; `rejectUnregisteredPlaceholder` additionally demands a
 *   chain proof before a public definition next to a local placeholder counts.
 * - `approved-member`: join bootstrap completion (#2831 review), judged with
 *   the same `acceptance` the snapshot refresh used. Only the one definition
 *   that acceptance admits confirms, carrying its member proof: the public
 *   definition for a public acceptance, whose authority must still hold now,
 *   and the complete private definition otherwise. Stored triples never
 *   authenticate the policy themselves. Unless this node still holds the
 *   approval the acceptance names, nothing confirms.
 */
export type ConfirmContextGraphMetadataInput =
  | {
      readonly purpose?: 'read';
      readonly rejectUnregisteredPlaceholder?: boolean;
    }
  | {
      readonly purpose: 'approved-member';
      readonly acceptance: ApprovedMemberAcceptance;
    };

export interface ContextGraphMetadataConfirmationDependencies {
  readonly signal?: AbortSignal;
  readonly chain: ChainAdapter;
  readonly resolveActivePublicChainProof: () => Promise<ActivePublicContextGraphChainProof>;
  readonly isPrivateContextGraph: (contextGraphId: string) => Promise<boolean>;
  readonly localApprovedAgentByContextGraph: ReadonlyMap<string, string>;
  readonly peerId: string;
  readonly store: TripleStore;
  readonly subscriptions: ReadonlyMap<string, Readonly<{ pendingMeta?: boolean }>>;
}

export type ContextGraphMetadataConfirmation =
  | { readonly outcome: 'confirmed' | 'unconfirmed' }
  | { readonly outcome: 'unavailable'; readonly source: 'chain-proof';
      readonly proof: Extract<ActivePublicContextGraphChainProof, { state: 'unknown' }> };

/** Legacy boolean presentation preserves its fail-closed chain-proof behavior. */
export function confirmedMetadataBoolean(result: ContextGraphMetadataConfirmation): boolean {
  return result.outcome === 'confirmed';
}

export async function confirmContextGraphMetadataV1(
  dependencies: ContextGraphMetadataConfirmationDependencies,
  contextGraphId: string,
  input: ConfirmContextGraphMetadataInput = {},
): Promise<boolean> {
  return confirmedMetadataBoolean(await resolveContextGraphMetadataConfirmationV1(dependencies, contextGraphId, input));
}

/** Canonical facts shared by bootstrap, gossip, and shared-memory admission. */
export async function resolveContextGraphMetadataConfirmationV1(
  dependencies: ContextGraphMetadataConfirmationDependencies,
  contextGraphId: string,
  input: ConfirmContextGraphMetadataInput = {},
): Promise<ContextGraphMetadataConfirmation> {
  dependencies.signal?.throwIfAborted();
  try {
    return await resolveMetadataConfirmation(dependencies, contextGraphId, input);
  } finally {
    dependencies.signal?.throwIfAborted();
  }
}

/** Canonical authority policy shared by bootstrap, gossip, and shared-memory admission. */
async function resolveMetadataConfirmation(
  dependencies: ContextGraphMetadataConfirmationDependencies,
  contextGraphId: string,
  input: ConfirmContextGraphMetadataInput = {},
): Promise<ContextGraphMetadataConfirmation> {
  dependencies.signal?.throwIfAborted();
  if ((Object.values(SYSTEM_CONTEXT_GRAPHS) as string[]).includes(contextGraphId)) {
    return { outcome: 'confirmed' };
  }
  if (isPublicMetaDurabilityPending(dependencies.store, contextGraphId)) {
    return { outcome: 'unconfirmed' };
  }

  if (input.purpose === 'approved-member') {
    const { proof } = input.acceptance;
    // A lifecycle race or partial rehydration can drop or change the binding;
    // the pre-join definition must not then stand in for the member.
    const stillApproved = () => (
      dependencies.localApprovedAgentByContextGraph.get(contextGraphId)?.toLowerCase()
        === proof.approvedAgentAddress.toLowerCase()
    );
    if (!stillApproved()) return { outcome: 'unconfirmed' };
    const confirmed = await findAuthoritativeDefinition(
      dependencies,
      contextGraphId,
      [{ definition: input.acceptance.admittedDefinition, memberProof: proof }],
      'agent.contextGraph.confirmedMeta.approvedMember',
    ) !== null;
    // Readiness is declared now, so the authority behind the acceptance and
    // this node's approval must both still hold now, after the awaits: a
    // rejection or a new join request can change the binding while they run.
    return { outcome: confirmed && await input.acceptance.stillHolds() && stillApproved() ? 'confirmed' : 'unconfirmed' };
  }

  const memberProof = await resolveApprovedMemberProof(dependencies, contextGraphId);

  const metaGraph = contextGraphMetaGraphUri(contextGraphId);
  const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
  const unregisteredPlaceholderResult = await dependencies.store.query(
    `ASK WHERE {
      GRAPH <${metaGraph}> {
        <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_REGISTRATION_STATUS}> "unregistered" .
      }
    }`,
    { source: 'agent.contextGraph.confirmedMeta.unregisteredPlaceholder', signal: dependencies.signal },
  );
  const hasUnregisteredPlaceholder = unregisteredPlaceholderResult.type === 'boolean'
    && unregisteredPlaceholderResult.value === true;
  let publicProof: ActivePublicContextGraphChainProof | undefined;
  const readPublicProof = async () => {
    let proof: ActivePublicContextGraphChainProof;
    try { proof = await dependencies.resolveActivePublicChainProof(); }
    catch (error) {
      proof = { state: 'unknown', reason: 'rpc-failure',
        detail: error instanceof Error ? error.message : String(error) };
    }
    dependencies.signal?.throwIfAborted();
    return proof;
  };
  const unconfirmed = (): ContextGraphMetadataConfirmation => publicProof?.state === 'unknown'
    ? { outcome: 'unavailable', source: 'chain-proof', proof: publicProof }
    : { outcome: 'unconfirmed' };
  if (
    hasUnregisteredPlaceholder
    && input.rejectUnregisteredPlaceholder === true
  ) {
    publicProof = await readPublicProof();
  }

  const authoritativeDefinition = await findAuthoritativeDefinition(
    dependencies,
    contextGraphId,
    [{ definition: 'private', memberProof }, { definition: 'public' }],
    'agent.contextGraph.confirmedMeta',
  );
  if (authoritativeDefinition === 'private') return { outcome: 'confirmed' };
  if (
    authoritativeDefinition === 'public'
    && (
      !hasUnregisteredPlaceholder
      || input.rejectUnregisteredPlaceholder !== true
      || publicProof?.state === 'public'
    )
  ) {
    return { outcome: 'confirmed' };
  }

  if (publicProof === undefined) {
    publicProof = await readPublicProof();
  }
  if (publicProof?.state === 'public') return { outcome: 'confirmed' };

  if (
    hasUnregisteredPlaceholder
    && (
      dependencies.localApprovedAgentByContextGraph.has(contextGraphId)
      || input.rejectUnregisteredPlaceholder === true
      || dependencies.subscriptions.get(contextGraphId)?.pendingMeta === true
    )
  ) {
    return unconfirmed();
  }

  if (await dependencies.isPrivateContextGraph(contextGraphId)) return unconfirmed();

  const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
  const ontologyResult = await dependencies.store.query(
    `ASK WHERE {
      GRAPH <${ontologyGraph}> {
        <${contextGraphUri}> <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> .
      }
    }`,
    { source: 'agent.contextGraph.confirmedMeta.ontologyDeclaration', signal: dependencies.signal },
  );
  if (ontologyResult.type === 'boolean' && ontologyResult.value === true) return { outcome: 'confirmed' };
  return unconfirmed();
}

/**
 * Whether the local root `_meta` itself declares the graph public: the
 * canonical facts (`rdf:type dkg:ContextGraph`, `dkg:accessPolicy "public"`)
 * with no contradicting policy beside them. This is what a replica must HOLD
 * before it can list, read or write the graph by its definition.
 *
 * `confirmContextGraphMetadataV1` answers a different question: whether the
 * graph is readable now. There an active public chain proof confirms on its
 * own, so a registered public graph is "confirmed" on a replica that holds no
 * declaration at all. A pull that asks whether the declaration is still
 * missing must therefore not take that answer (#3264).
 */
export async function holdsAuthoritativePublicDefinitionV1(
  store: TripleStore,
  contextGraphId: string,
): Promise<boolean> {
  const result = await store.query(buildAuthoritativePublicMetaAskQuery(contextGraphId), {
    source: 'agent.contextGraph.publicDefinition.held',
  });
  return result.type === 'boolean' && result.value === true;
}

/** This node's approved-member proof for the graph, when it holds an approval. */
async function resolveApprovedMemberProof(
  dependencies: ContextGraphMetadataConfirmationDependencies,
  contextGraphId: string,
): Promise<ApprovedMemberProof | undefined> {
  const approvedAgentAddress = dependencies.localApprovedAgentByContextGraph.get(contextGraphId);
  if (!approvedAgentAddress) return undefined;
  let expectedDelegateeOpKey: string | undefined;
  try {
    expectedDelegateeOpKey = await inferAdapterPublisherAddress(dependencies.chain);
  } catch {
    // The libp2p peer binding remains sufficient when no op-key is exposed.
  }
  return {
    approvedAgentAddress,
    expectedDelegateePeerId: dependencies.peerId,
    expectedDelegateeOpKey,
  };
}

/**
 * The canonical stored-definition proofs, shared by every confirmation
 * purpose. Each purpose lists the definitions it admits, in order, with the
 * member proof each must carry. Returns the first definition that matched.
 */
async function findAuthoritativeDefinition(
  dependencies: ContextGraphMetadataConfirmationDependencies,
  contextGraphId: string,
  candidates: ReadonlyArray<{
    readonly definition: 'private' | 'public';
    readonly memberProof?: ApprovedMemberProof;
  }>,
  sourcePrefix: string,
): Promise<'private' | 'public' | null> {
  for (const { definition, memberProof } of candidates) {
    const query = definition === 'private'
      ? buildAuthoritativePrivateMetaAskQuery(contextGraphId, memberProof)
      : buildAuthoritativePublicMetaAskQuery(contextGraphId, memberProof);
    const result = await dependencies.store.query(query, {
      source: `${sourcePrefix}.${definition}Definition`, signal: dependencies.signal,
    });
    if (result.type === 'boolean' && result.value === true) return definition;
  }
  return null;
}
