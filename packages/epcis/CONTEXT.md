# EPCIS

GS1 EPCIS 2.0 capture + query plugin on top of the DKG. Maps EPCIS events to RDF
quads on a context graph, exposes an HTTP capture endpoint and a SPARQL-backed
events query endpoint.

## Language

**EPCIS Document**:
A GS1 EPCIS 2.0 JSON-LD document containing one or more EPCIS events. Carried in
capture requests as `epcisDocument`.

**Capture**:
The act of submitting an **EPCIS Document** for ingestion via `POST /api/epcis/capture`.
Async — returns `202` with a **Capture ID**.

**Capture ID**:
Identifier returned by an async capture, used to poll Lift job state via
`GET /api/epcis/capture/:captureID`. Distinct from the eventual **UAL** of the
published Knowledge Collection.

**Context Graph (CG)**:
The DKG container the document is published into. Required per request — capture
accepts a `contextGraphId` field; query accepts a `contextGraphId` query param.

**Shared Working Memory (SWM)**:
Public partition at `<cg>/_shared_memory`. Pre-finalization staging area. For
private-by-default EPCIS, contains only `dkg:privateDataAnchor "true"` per root
entity. Authoritative for in-flight (not-yet-finalized) state.

**Finalized partition**:
Canonical partition at `<cg>` (no suffix). Authoritative durable view —
populated once a **Capture** completes its publishing cycle and is no longer
in-flight. Implementation detail: backed by on-chain finalization, but callers
should never need to know that.

**Private partition**:
Quads written to `<cg>/_private` (operation-scoped). Holds the actual EPCIS
event payload when the document is captured privately. Locally queryable on the
owning node and on nodes in `allowedPeers`. Joined onto whichever public
partition (**SWM** or **On-chain**) carries the matching root anchor.

**Privacy envelope**:
Shape `{ public, private }` accepted on capture for explicit split. Bare
EPCIS Documents go to **Private partition** by default.

## Relationships

- A **Capture** produces a **Capture ID** synchronously and a **UAL** asynchronously once Lift completes.
- A **Capture** writes to exactly one **Context Graph**, into its **SWM** + **Private partition** by default, or via a **Privacy envelope** for explicit split.
- Events query targets exactly one public partition per request — **SWM** or **Finalized partition** — selected by `?finalized=true|false` (default `true`).
- An event is returned when (a) its full EPCIS triples live in the chosen public partition (fully public event), OR (b) the chosen public partition holds a `dkg:privateDataAnchor` for the root AND `<cg>/_private` holds the matching payload (private event). Orphan private payloads — no anchor in the chosen partition — are excluded.

## Flagged ambiguities

- "private" originally meant "envelope split" in PR 376 (bare doc = public). In
  this context, "private by default" means **whole document → Private partition**.
  Public partition gets only anchors.
