# ADR 0003 — `dkg-streams:` ontology URI for KafkaStream KAs

- **Status:** Accepted
- **Date:** 2026-05-24
- **Deciders:** DKG core maintainers (kafka-plugin slice authors)
- **Affected modules:** `packages/kafka-plugin/src/{ka-builder,schema,discovery}.ts`,
  `packages/kafka-plugin/CONTEXT.md` → **KafkaStream**

## Context

The kafka-plugin publishes one Knowledge Asset per registered Kafka
stream. The KA carries `@type` and a handful of `*:kafkaBootstrapUrl` /
`*:kafkaTopicName` / etc. properties. The choice of namespace prefix
becomes the wire contract every fork's adapter — and every cross-fork
consumer's SPARQL query — must agree on.

Three constraints bound the choice:

1. **Cross-fork discoverability.** A federated consumer must be able to
   run a single SPARQL query (`?s a <ontology>KafkaStream`) across every
   fork's KAs and get a unified result. That demands a single,
   canonical namespace IRI baked into the plugin.
2. **Future protocol expansion.** The partner draft was scoped to
   Kafka, but MQTT / WebSocket / AMQP / NATS stream registrations are
   plausible siblings under the same plugin family. Whatever namespace
   we lock for Kafka should not paint future siblings into a corner.
3. **Ownership.** The IRI must point at a domain we control —
   otherwise a future ontology drift on the owner's side breaks every
   fork's discovery query.

## Decision

Pick `https://ontology.dkg.io/streams#` with prefix `dkg-streams:`.

- `@type` is `dkg-streams:KafkaStream`.
- Core wire fields (`kafkaBootstrapUrl`, `kafkaTopicName`,
  `kafkaAuthMethod`, `kafkaSaslMechanism`, `dataFormat`) map to
  `dkg-streams:*` literal property names. (`messageSchema` was deferred
  post-MVP — see `packages/kafka-plugin/CONTEXT.md` → Deferred
  surfaces.)
- `dkg-streams:protocol = "kafka"` is server-set on every KA to
  disambiguate from future `dkg-streams:MqttStream` / `WebSocketStream`
  siblings sharing the namespace.
- `name` and `description` deliberately land under `schema:`
  (schema.org) rather than `dkg-streams:` so off-the-shelf JSON-LD
  tooling renders human-readable labels without custom ontology
  understanding.
- The namespace is **owned by OriginTrail**; OriginTrail mints
  subclasses (`MqttStream`, `WebSocketStream`, ...). Forks adding their
  own ontology terms do so under their own namespace and add them as
  secondary `@type` via the JSON-LD multi-type idiom (see ADR 0002 →
  extension pattern).
- The IRI is **frozen once the first KA publishes.** A future namespace
  break would invalidate every existing KA's `@type` and silently break
  every cross-fork SPARQL query.

## Alternatives considered

### 1. `https://ontology.dkg.io/kafka#` with prefix `dkg-kafka:`

Reject. Locking the IRI to Kafka leaves no room for future protocol
siblings without minting a NEW namespace (`mqtt#`, `websocket#`,
`amqp#`) and asking cross-fork consumers to learn N namespaces instead
of one. The shared `streams#` namespace lets a consumer query
`?s a ?type FILTER (STRSTARTS(STR(?type), "https://ontology.dkg.io/streams#"))`
and get every protocol's registrations in one go. The protocol
discriminator stays as a `dkg-streams:protocol` literal on each KA.

### 2. `https://github.com/origintrail/...` — link to a GitHub-hosted vocabulary

Reject. GitHub URLs are version-fragile (a repo rename, a branch
deletion, an org move silently breaks every KA's `@type` resolution
for tools that actually fetch the IRI). `ontology.dkg.io` is a
DNS-stable domain we control. The semantic web convention is to use a
domain you can guarantee, not a forge URL.

### 3. `dmaast:StreamingDatasource` (partner-draft namespace)

Reject as the **primary** type. The partner draft proposed re-typing
every asset under `dmaast:*` and dropping `dkg-streams:*` entirely.
This locks every cross-fork query to a single fork's vocabulary —
fork B querying for streams would need to know fork A's `dmaast:*`
shape exists. The locked rule (see ADR 0004 — always-invariant
baseline) keeps `dkg-streams:KafkaStream` as the primary `@type` on
every KA; partner forks add `dmaast:StreamingDatasource` as a
SECONDARY type via the extension's augment fragment without losing
cross-fork discoverability.

### 4. No namespace prefix — bare URI `https://ontology.dkg.io/streams/KafkaStream`

Reject. Bare URIs in JSON-LD `@type` work, but every JSON-LD consumer
re-implements the namespace splitting. Using a `@context` map with a
`dkg-streams:` prefix is the standard JSON-LD compaction; it makes the
KA human-readable in the daemon's API responses and renders cleanly in
node-ui.

## Consequences

### Positive

- One namespace covers Kafka today and every future stream-registration
  protocol the plugin family ships, while one literal property
  (`dkg-streams:protocol`) keeps them queryably distinct.
- The IRI ownership story is unambiguous: OriginTrail mints, forks
  extend via their own namespaces.
- Cross-fork federation is one query: `?s a <https://ontology.dkg.io/streams#KafkaStream>`.

### Negative / accepted trade-offs

- Once the first KA publishes, the IRI is locked. A future namespace
  reshuffle would require a migration plan we don't have. Acceptable
  for v1 because the IRI was picked with explicit room for protocol
  siblings.
- Forks layering their own `@type` (e.g. `dmaast:StreamingDatasource`)
  must use JSON-LD multi-type; some downstream tooling that picks the
  "first" `@type` may not recognise the secondary type. Documented in
  ADR 0004's partner-draft reconciliation.

## References

- PRD: `.orchestrator/runs/design-1779556342637217000/prd.md` —
  "Implementation Decisions" → "Ontology URI"
- Source: `packages/kafka-plugin/src/ka-builder.ts` (the `@context`
  block + `@type` literal)
- Glossary: `packages/kafka-plugin/CONTEXT.md` → **KafkaStream**
- Sibling decision: `docs/adr/0004-kafka-plugin-always-invariant-baseline.md`
