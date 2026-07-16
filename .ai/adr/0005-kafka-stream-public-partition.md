# ADR 0005 — KafkaStream KAs publish to the public data partition

- **Status:** Superseded by ADR 0006
- **Date:** 2026-05-24
- **Superseded:** 2026-06-02
- **Deciders:** DKG core maintainers (kafka-plugin slice reviewer +
  authors, after a reviewer-blocking finding in the previous run)
- **Affected modules:** `packages/kafka-plugin/src/handler.ts`,
  `packages/kafka-plugin/src/discovery.ts`,
  `packages/kafka-plugin/CONTEXT.md` → **Stream Registration**

## Context

This ADR is preserved as historical context because it explains why the
first kafka-plugin implementation forced the `{ public }` envelope. The
decision no longer holds for customer-facing deployments where stream
registration metadata can reveal private project, tenant, site, or data
product information. ADR 0006 replaces it with a private-by-default rule.

The kafka-plugin handler calls `ctx.agent.publishAsync(cgId, content,
opts)`. The agent's default `jsonLdToQuads` invocation inside
`publishAsync` (`packages/agent/src/dkg-agent.ts:6113`) passes
`defaultVisibility: 'private'`, which routes a bare JSON-LD body to
the **private** data partition. The discovery endpoints the plugin
exposes (`GET {basePath}` listing and `GET {basePath}/:ual` single-fetch)
query the SWM **public** partition (`<cg>/_shared_memory`) — they
have to, because cross-fork discovery is the whole point of a Stream
Registration and the public partition is the partition that
cross-syncs.

The first revision of the plugin (committed in the previous run as
issue 0003) called `publishAsync(cgId, ka, ...)` with bare JSON-LD.
The KA landed in the private partition. The list and by-UAL endpoints
queried the public partition. Both returned empty for every freshly
published stream — a silent loss of every operator's data from the
caller's perspective. The reviewer caught the regression; commit
`fb2615f0` on branch `orch/kafka-plugin-mvp/0003` wrapped the KA in
the `{ public }` envelope before `publishAsync` and the discovery
endpoints started working.

## Decision

The handler **always wraps the final KA in the `{ public }` envelope**
before calling `agent.publishAsync`:

```ts
const publishContent = { public: ka };
await ctx.agent.publishAsync(cgId, publishContent, opts.publishOptions);
```

This is the documented opt-in for the public data partition — the
same mechanism EPCIS uses for its explicit-public flow
(`packages/epcis/src/handlers.ts`). Stream Registrations are
public-by-design: the KA describes how to find a Kafka stream so that
cross-fork consumers can connect. The Kafka cluster's own auth (SASL,
mTLS, etc.) gates actual stream consumption — not the KA's visibility.

Forks that need gated KA visibility (rare; the use case is "private
internal stream catalogue") cannot use this plugin's bare
`createKafkaPlugin()` — they go Path C (a fork-owned RoutePlugin that
wraps `agent.publishAsync` with their own envelope choice). The Slice
2 PRD documents this in "Deferred surfaces".

## Alternatives considered

### 1. `{ private }` envelope — KA lands in the private partition

Reject. Cross-fork discovery would silently fail for every published
stream — exactly the regression the previous run's reviewer caught.
Private-partition KAs need explicit ACL-aware fetch via the publisher
agent's `requestPrivateData` flow; the simple HTTP `GET {basePath}/:ual`
SPARQL discovery path the plugin advertises cannot reach them.

### 2. Anchor-based EPCIS-style split — public anchor + private body

Reject. EPCIS uses an anchor-only public partition because its bodies
are large (full EPCIS documents, often kilobytes of event payload).
KafkaStream KAs are small (a dozen fields, mostly short strings) — the
anchor-split machinery (`syntheticPrivateAnchor: true` in
`jsonLdToQuads`, the `_shared_memory` anchor triple, the
`_private` lookup) buys nothing here and would actively block
cross-fork discovery the same way option 1 does. The simple
`{ public }` wrap is the right tool for a small public KA.

### 3. Factory-option visibility flag (`createKafkaPlugin({ visibility: 'public' | 'private' })`)

Reject as a v1 surface. Visibility is not a per-instance configuration
knob — it's a per-use-case architectural choice. A fork that needs
private gating is doing something fundamentally different from a fork
publishing a public registration, and the per-request consequences
(discovery silently breaking on the private side) are not the kind of
trade-off a config flag should hide. The Path C escape hatch
(fork-owned RoutePlugin) is the right level of abstraction for the
rare private-registration case; bringing the flag into the public
factory API would invite the silent-breakage class of bug.

### 4. Publish to BOTH partitions

Reject. Double-publish doubles on-chain cost and chain-event volume
for no caller benefit — every fork would pay for a private copy nobody
reads. Also makes the audit story confusing: which copy is canonical
when they diverge after a future update?

## Consequences

### Positive

- `GET {basePath}` and `GET {basePath}/:ual` always return the KAs the
  POST registered, with no per-fork configuration gymnastics.
- The contract is explicit: Stream Registrations are public artefacts;
  Kafka auth gates the stream itself.
- Forks needing private visibility are pointed at Path C (custom
  RoutePlugin) — the same escape hatch ADR 0001 already advertises for
  "I need something the plugin doesn't model" cases.

### Negative / accepted trade-offs

- Private-by-default forks must use Path C; the bare factory does not
  serve them. Documented in CONTEXT.md and the Slice 2 PRD's deferred-
  surfaces section.
- The handler's `{ public }` wrap is invisible to the caller. A fork
  developer reading the kafka-plugin source must trace from
  `handler.ts:handlePostRegister` to find the wrap, and the inline
  comment there is the single point of documentation. Acceptable —
  this ADR is the second point.
- Regression class is well-defined: if any future change drops the
  `{ public }` wrap, the live-daemon E2E
  (`packages/kafka-plugin/test/kafka-plugin-api.e2e.test.ts` →
  "GET /api/kafka/streams returns the registered KA (public-partition
  regression)") fails immediately.

### Future work

- A `dkg-streams:visibility` annotation on the KA itself, if a future
  use case justifies fine-grained per-stream visibility distinct from
  the publish partition (currently YAGNI).
- An ACL-aware variant of the plugin (separate npm package, separate
  factory) for forks running internal-only stream catalogues — only if
  a real consumer needs it.

## References

- PRD: `.orchestrator/runs/design-1779556342637217000/prd.md` (Slice 2)
- Reviewer finding: previous run's slice 0003 reviewer rejection;
  fix landed as commit `fb2615f0` on branch
  `orch/kafka-plugin-mvp/0003` ("fix(kafka-plugin): publish KAs to
  public partition so discovery can find them")
- Source: `packages/kafka-plugin/src/handler.ts` — `handlePostRegister`
  (the `{ public }` envelope wrap)
- Regression guard: `packages/kafka-plugin/test/kafka-plugin-api.e2e.test.ts`
- Glossary: `packages/kafka-plugin/CONTEXT.md` → **Stream Registration**
- Sibling decisions: `docs/adr/0001-daemon-route-plugins.md`,
  `docs/adr/0002-kafka-plugin-extension-pattern.md`,
  `docs/adr/0003-dkg-streams-ontology-uri.md`,
  `docs/adr/0004-kafka-plugin-always-invariant-baseline.md`
