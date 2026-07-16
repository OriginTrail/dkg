# ADR 0004 — kafka-plugin "always-invariant baseline" namespace rule

- **Status:** Accepted
- **Date:** 2026-05-24
- **Deciders:** DKG core maintainers (kafka-plugin slice authors,
  partner-draft reconcilers)
- **Affected modules:** `packages/kafka-plugin/src/{schema,ka-builder,extension}.ts`,
  `packages/kafka-plugin/test/extension-merge.test.ts`,
  `packages/kafka-plugin/CONTEXT.md`

## Context

A partner draft (shared during the design-phase grilling) typed every
asset as `dmaast:StreamingDatasource` and re-namespaced every core
field under `dmaast:*`. Doing the same in this plugin would break the
PRD's headline guarantee: a single SPARQL query across forks finds
every registered Kafka stream regardless of which fork published it.
If fork A publishes `dmaast:kafkaBootstrapUrl` and fork B publishes
`acme:kafkaBootstrapUrl`, no query touches both.

The choice is whether the plugin's contract is:

- **(a)** "core fields are advisory — forks may rename, replace, or
  re-type at will", which produces fork-specific KA shapes and a
  cross-fork query nightmare; or
- **(b)** "core fields and the `@type` invariant are mandatory — forks
  layer additions ON TOP, never AROUND, the baseline."

## Decision

Lock the **always-invariant baseline**. The plugin contract guarantees,
for every KA it publishes:

1. `@type` array always contains `dkg-streams:KafkaStream` as the
   primary type (see ADR 0003 for namespace rationale).
2. Core fields land under `dkg-streams:*` (their literal property
   names — `kafkaBootstrapUrl`, `kafkaTopicName`, ...) and `schema:*`
   (for `name` / `description`). Server-set, not extension-overridable.
3. `dkg-streams:protocol = "kafka"` is server-set as a literal.
4. Extensions can add **additional** `@type` entries (JSON-LD
   multi-type) and **additional** properties under their own
   namespace prefix. They cannot remove, rename, or re-namespace
   anything in (1) – (3).

Enforced at two layers:

- **Boot-time:** `validateExtensionAgainstCore` rejects any extension
  whose schema redeclares a core field name. The fail-soft loader logs
  + skips; daemon keeps booting.
- **Runtime:** `mergeAugmentFragment` drops any extension fragment key
  that collides with a core KA key (core wins), with one log-once
  `console.warn` per unique colliding key so operators see the
  misconfiguration at least once without log spam.

## Alternatives considered

### 1. Partner draft — re-namespace everything under the fork's prefix

Reject. This was the proposal that triggered the ADR. Re-namespacing
core fields under `dmaast:*` (or any fork prefix) destroys cross-fork
SPARQL discovery: a consumer indexing all known streams would need to
learn every fork's namespace mapping, defeating the entire reason the
plugin exists. The partner can keep `dmaast:StreamingDatasource` as a
SECONDARY `@type` and add aliased `dmaast:kafkaBootstrapUrl` properties
via the extension's augment fragment without losing the baseline.

### 2. "Soft" baseline — recommend `dkg-streams:*` but allow extensions to override

Reject. "Recommend" without enforcement is "ignored within one fork
generation". The PRD's user-story #10 ("my registered streams are
discoverable cross-fork via a single SPARQL query") and the
collision-rules section of the Implementation Decisions explicitly
state both layers of enforcement; relaxing them would invalidate
those guarantees.

### 3. Allow extensions to add fields under `dkg-streams:` (sibling fields)

Reject. The `dkg-streams:` namespace is owned by OriginTrail (ADR 0003).
Letting forks publish ad-hoc `dkg-streams:*` properties would erode the
"OriginTrail mints subclasses" rule and create de facto squatting on
the namespace by whichever fork wired their fields first. Forks add
under their own namespace, full stop.

### 4. Late-binding type via SHACL shape

Reject (deferred). A SHACL shape would let consumers validate
fork-published KAs against the baseline at consume-time. Useful, but
orthogonal to the publish-side invariant — the publisher should not
emit a KA missing the baseline in the first place. SHACL shapes are
future work once a real cross-fork registry exists.

## Consequences

### Positive

- Cross-fork queries always succeed against the baseline shape — the
  invariant means consumers write one SPARQL query, not N per-fork
  variants.
- The partner's `dmaast:` namespace lives as a SECONDARY type alongside
  `dkg-streams:KafkaStream` — their existing tooling keeps working;
  cross-fork tooling sees the baseline.
- The two-layer enforcement (boot-time schema, runtime augment) gives
  fork authors fast feedback at load time on structural mistakes and
  a clear log path for runtime drift.

### Negative / accepted trade-offs

- Forks cannot use the literal field name `kafkaBootstrapUrl` for a
  fork-private interpretation. They must alias under their own
  namespace (`dmaast:kafkaBootstrapUrl`). Documented in the partner-
  draft reconciliation section of the PRD; not a real cost since the
  baseline `dkg-streams:kafkaBootstrapUrl` is already present in the
  KA for fork consumers.
- The runtime drop is silent after the first warn per unique key. A
  dynamic `augment` that produces an unlucky colliding key on some
  requests would log once and then silently drop on subsequent ones.
  Acceptable — see ADR 0002's "Consequences → Negative" for the
  matching trade-off discussion.

### Future work

- Optional SHACL shape published alongside the ontology to let
  consumers validate KAs against the baseline at consume-time.
- A `dkg-streams:protocol` enumeration document published once a
  second protocol (MQTT, WebSocket, ...) ships under the same
  namespace.

## References

- PRD: `.orchestrator/runs/design-1779556342637217000/prd.md` —
  "Implementation Decisions" → "Published KA shape" + "Collision rules"
- Source: `packages/kafka-plugin/src/extension.ts` (boot-time guard),
  `packages/kafka-plugin/src/ka-builder.ts` (runtime augment merge)
- Tests: `packages/kafka-plugin/test/extension-merge.test.ts`
- Sibling decisions: `docs/adr/0002-kafka-plugin-extension-pattern.md`,
  `docs/adr/0003-dkg-streams-ontology-uri.md`
- Partner-draft reconciliation: PRD § "Further Notes → Partner-draft
  reconciliation"
