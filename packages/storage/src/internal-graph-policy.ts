import { ATOMIC_GRAPH_REPLACE_STAGING_PREFIX } from './atomic-graph-replace.js';

/**
 * One policy for the operation-internal RDF graph namespace (#2052 Stack B2).
 *
 * Historically `urn:dkg:internal:atomic-graph-replace:` held ONLY ephemeral
 * per-operation staging graphs named `<prefix><uuid>`, and every enumeration
 * surface hid the whole prefix via `isAtomicGraphReplaceStagingGraph()`.
 *
 * Stack B2 adds the first PERSISTENT graphs under that same prefix. Reusing the
 * prefix is deliberate: every supported predecessor binary already filters it
 * out of `listGraphs()`, `hasGraph()`, the graph-set index, the changelog and
 * the sync responder, so an older node neither enumerates nor serves the new
 * reserved state without any change on its side. That downgrade property is the
 * reason the prefix is not re-namespaced.
 *
 * Reusing it also creates one hazard: "internal" now means two different things
 * with opposite lifetimes. An ephemeral staging graph is garbage the moment its
 * operation fails and MUST be droppable; persistent reserved state is
 * authoritative and must NEVER be dropped by a sweep. This module is the single
 * place that tells them apart, so no caller has to re-derive the distinction
 * from a string prefix.
 *
 * Dependency note: this module is reachable from `index.ts`, which every DKG
 * process loads. It therefore deliberately imports nothing from
 * `@origintrail-official/dkg-core/system-record-v1` — that barrel pulls the
 * whole V1 codec/crypto graph, and B2 must add zero default-off startup cost.
 * The literals below are frozen protocol constants; a unit test imports the
 * barrel and asserts they agree with `SYSTEM_RECORD_KIND_V1`.
 */

/** Sub-namespace owned by system-record V1 persistent state. */
const SYSTEM_RECORD_V1_INTERNAL_PREFIX =
  `${ATOMIC_GRAPH_REPLACE_STAGING_PREFIX}system-record-v1:` as const;

/**
 * Applied state, root claims, reverse bindings, capacity and receipts.
 * Exact name — never a prefix match.
 */
export const SYSTEM_RECORD_V1_STATE_GRAPH =
  `${SYSTEM_RECORD_V1_INTERNAL_PREFIX}state` as const;

/**
 * Pre-activation shadow projection for the `agents` kind. Shadow rows are
 * charged to the same capacity as authoritative rows but never make the legacy
 * lane non-authoritative.
 */
export const SYSTEM_RECORD_V1_SHADOW_AGENTS_GRAPH =
  `${SYSTEM_RECORD_V1_INTERNAL_PREFIX}shadow:agents` as const;

/**
 * Every persistent reserved graph, in a frozen exact-match set. Membership is
 * by identity, not by prefix, so a future `shadow:ontology` (Stack E) must be
 * added here explicitly rather than being matched into existence.
 */
export const RESERVED_INTERNAL_GRAPHS_V1: ReadonlySet<string> = Object.freeze(
  new Set<string>([
    SYSTEM_RECORD_V1_STATE_GRAPH,
    SYSTEM_RECORD_V1_SHADOW_AGENTS_GRAPH,
  ]),
) as ReadonlySet<string>;

/**
 * True for a PERSISTENT reserved internal graph.
 *
 * Fail-closed by construction: this is an exact-name lookup, so an attacker (or
 * a careless caller) cannot craft `…:system-record-v1:state-evil` and have it
 * treated as reserved, nor can a typo silently reserve an unrelated graph.
 */
export function isReservedInternalGraphUriV1(graphUri: string): boolean {
  return RESERVED_INTERNAL_GRAPHS_V1.has(graphUri);
}

/**
 * True for an EPHEMERAL per-operation staging graph — the pre-B2 meaning of the
 * internal prefix.
 *
 * The UUID shape is validated rather than assumed. `buildAtomicGraphReplaceUpdate`
 * and `buildAtomicGraphAndSubjectReplaceUpdate` mint these as
 * `<prefix><randomUUID()>`, and a canonical RFC-4122 UUID contains no `:`, so
 * the persistent names above can never satisfy this predicate. Validating the
 * shape (instead of "prefix and not reserved") means an unrecognised internal
 * name is treated as neither ephemeral nor reserved — it is not sweepable, and
 * it is not writable through the generic API either.
 */
const STAGING_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isEphemeralInternalStagingGraphUriV1(graphUri: string): boolean {
  if (!graphUri.startsWith(ATOMIC_GRAPH_REPLACE_STAGING_PREFIX)) return false;
  const suffix = graphUri.slice(ATOMIC_GRAPH_REPLACE_STAGING_PREFIX.length);
  return STAGING_UUID_PATTERN.test(suffix);
}

/**
 * True for anything inside the operation-internal namespace, persistent or
 * ephemeral.
 *
 * This is the predicate every ENUMERATION surface wants: reserved state must be
 * as invisible to `listGraphs()`, `hasGraph()`, the graph-set index seed and
 * rebuild, the sync responder plan, the oversize sweep and the changelog as a
 * staging graph already is. It is intentionally prefix-wide and therefore
 * identical in behaviour to the predecessor `isAtomicGraphReplaceStagingGraph()`
 * — hiding is the one place where the two lifetimes must NOT be distinguished,
 * because an unrecognised internal name must be hidden too rather than leaking.
 */
export function isInternalGraphUriV1(graphUri: string): boolean {
  return graphUri.startsWith(ATOMIC_GRAPH_REPLACE_STAGING_PREFIX);
}

/**
 * Thrown when a generic store mutation targets persistent reserved state.
 *
 * Reserved state is writable ONLY through the system-record materializer's
 * structured, generation-bound, one-shot command path, which derives its own
 * graph scope. A caller-authored `dropGraph`/`replaceGraph`/`deleteByPattern`
 * against these names would bypass the full-state CAS, the capacity accounting
 * and the materialization epoch, so it is rejected rather than accepted and
 * reconciled afterwards.
 */
export class ReservedInternalGraphWriteError extends Error {
  readonly code = 'RESERVED_INTERNAL_GRAPH_WRITE' as const;

  constructor(
    readonly graphUri: string,
    readonly operation: string,
    readonly storeName: string,
  ) {
    super(
      `${storeName}: ${operation}(<${graphUri}>) targets reserved system-record V1 state, ` +
        'which is not writable through the generic store API.',
    );
    this.name = 'ReservedInternalGraphWriteError';
  }
}

/**
 * Generic-mutation guard. Call before any graph-targeted write.
 *
 * Deliberately NOT gated on whether the system-record lane is enabled: the
 * reserved graphs may hold durable state written by a previous process (or a
 * later re-enable) even while this process has the lane disabled, so a
 * disabled-mode `DROP GRAPH` must still be refused. A hard error is safe
 * precisely because reserved graphs never enumerate — no legitimate
 * iterate-and-drop loop can reach one, only a hardcoded IRI can.
 */
export function assertNotReservedInternalGraphV1(
  graphUri: string,
  operation: string,
  storeName: string,
): void {
  if (isReservedInternalGraphUriV1(graphUri)) {
    throw new ReservedInternalGraphWriteError(graphUri, operation, storeName);
  }
}

/*
 * Deliberately NOT provided: a `excludeInternalGraphsV1(graphs)` filter helper.
 *
 * It existed briefly and had zero production callers, because every
 * enumeration surface already filters through `isAtomicGraphReplaceStagingGraph`
 * — which, being prefix-wide, hides the reserved names correctly today (pinned
 * by a test in `internal-graph-policy.test.ts`). Shipping a second, unused
 * filter would have been dead surface implying a migration that has not
 * happened.
 *
 * When the enumeration sites do migrate to this module, the honest move is to
 * invert the dependency — move the prefix constant here and have
 * `atomic-graph-replace.ts` re-export it — so there is genuinely ONE predicate
 * rather than two that must be kept in agreement.
 */
