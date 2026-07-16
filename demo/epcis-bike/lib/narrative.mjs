// Story content for the demo's paced human mode. Concise — one short
// paragraph per phase, plus ASCII diagrams for the conceptually dense
// phases (1 and 3). JSON mode skips all of this — that channel is for
// agents.

export const OPENING = {
  title: 'EPCIS-on-DKG — Acme Bikes Assembly Line W18',
  body: [
    'Acme Bikes (a fictional manufacturer used here for illustration) makes road bikes. On their Assembly Line W18, each bicycle passes through 7 stations — frame welding, painting, wheel assembly, drivetrain installation, paint inspection, functional test, packing — before shipping. Every station emits a structured event (which item, where, when, status). That data is GS1 EPCIS 2.0.',
    'Acme wants to record those events on shared infrastructure: regulators get proof events happened, partners (e.g. a research lab) get controlled access to operational detail, competitors see nothing, Acme keeps the canonical record.',
    'EPCIS-on-DKG splits each capture into a public anchor (proof of existence) and a private payload (full event body, owner-readable, optionally granted via allowList). This demo follows ONE bicycle through Assembly Line W18 — 7 synthesized events from May-12-2026 — and shows what each party can see at every step.',
  ],
};

const LINE_DIAGRAM = `
  Assembly Line W18 (Acme Bikes) — 7 stations, item BIKE-2026-W18-0001 traverses in ~2 hours:

      [IN]
       │
       ▶  FrameWelding              ─┐
       ▶  Painting                   │  Frame fabrication
       │                              ┘
       │
       ▶  WheelAssembly             ─┐
       ▶  DrivetrainInstallation     │  Component assembly
       │                              ┘
       │
       ▶  PaintInspection           ─┐
       ▶  FunctionalTest             │  Quality assurance
       │                              ┘
       │
       ▶  Packing                       Final
       │
      [OUT]

  Each ▶ = one EPCIS ObjectEvent (epcList, bizStep, disposition, readPoint).
`;

const PRIVACY_DIAGRAM = `
  One capture writes to TWO partitions:

  PUBLIC  ─ <cg>/<sub>/_shared_memory ──────────────┐
                                                     │
    <event> dkg:privateDataAnchor  "true"            │  ← anyone sees this
                                                     │
  ────────────────────────────────────────────────────┘

  PRIVATE ─ <cg>/<sub>/_private ────────────────────┐
                                                     │
    <event> a              epcis:ObjectEvent         │
            epcis:eventTime   "2026-05-12T..."       │  ← owner sees this.
            epcis:bizStep  <cbv:inspecting>          │     allowList peers
            epcis:epcList     "urn:acme:bike:..."    │     also see it.
            epcis:disposition <cbv:in_progress>      │     external peers
            epcis:readPoint   <urn:acme:bike:...>    │     do NOT.
                                                     │
  ────────────────────────────────────────────────────┘
`;

export const PHASE_INTROS = {
  0: {
    title: 'Phase 0 — Setup',
    body: [
      'Verify the daemon, then make sure the CG exists, is registered on-chain, and has the `bike-line` sub-graph.',
      'Three things are required before any EPCIS capture can succeed: (1) the CG must exist over P2P (`context-graph create`); (2) the CG must be registered on-chain so the V10 publisher can mint a numeric ID for it (`context-graph register`); (3) the target sub-graph must be pre-registered (`context-graph create-sub-graph`). Skipping any of these surfaces later as a confusing publisher error.',
    ],
  },
  1: {
    title: 'Phase 1 — Capture every station event',
    body: [
      LINE_DIAGRAM,
      'We send 7 EPCIS documents to the daemon, one per station event, in chronological order. Each capture is async — the plugin returns 202 + a captureID immediately. Bare docs default to private — the public partition gets only a `dkg:privateDataAnchor` triple per event; the full payload lands in the private partition.',
    ],
  },
  2: {
    title: 'Phase 2 — Poll status until UALs appear',
    body: [
      'Capture is async; the publisher is now lifting each event onto the chain. We poll `GET /api/epcis/capture/<id>` to show the lifecycle. The publisher walks each job through `accepted → claimed → validated → broadcast → included → finalized` (success) — or `failed` (terminal error). Anything pre-`finalized` is still in flight.',
    ],
  },
  3: {
    title: 'Phase 3 — Two views of the same data',
    body: [
      PRIVACY_DIAGRAM,
      'The central beat. We run TWO queries against the in-flight data:  (3.A) raw SPARQL targeting only the public partition — what an external peer sees;  (3.B) the composite EPCIS query — what the owner sees, because their daemon merges the private partition. Same data, two visibilities.',
    ],
  },
  4: {
    title: 'Phase 4 — Query finalized partition',
    body: [
      'Once async lift completes, anchors move from `_shared_memory` into the canonical finalized partition (`<cg>/<sub>`). Same a/b contrast against the durable view. On a stuck devnet, this is empty — Phase 5 below queries `_shared_memory` instead.',
    ],
  },
  5: {
    title: 'Phase 5 — Filter examples',
    body: [
      'Five filters showing how to query EPCIS data: by EPC (one item\'s lifecycle), by bizStep (every QA event), by time window, with `--all` pagination, by event type. All target `--finalized=false` since that\'s where bare-doc captures live until lift completes.',
    ],
  },
  6: {
    title: 'Phase 6 — AllowList grant (research lab)',
    body: [
      'Capture one synthetic "batch summary" event with `--access-policy allowList --allowed-peer <peerId>`. The access handler matches the grant against the caller\'s **bare libp2p peer ID** (e.g. `12D3KooW...`), so production grants must use that form — `run.mjs` looks up node2\'s real peer ID via `/api/identity` at startup and threads it into `ALLOWED_PEER` for that purpose. The `urn:peerId:research-lab-demo` value is a synthetic placeholder used ONLY when no second node is reachable (so the demo can exercise the write side without crashing); a real libp2p node would never authorize against it. After lift, the grant is durably stored as `<kc> dkg:allowedPeer "<peerId>"` triples in `<cg>/_meta` (verifiable in `packages/publisher/src/metadata.ts:82-106`). From a second node with the granted peer ID, the EPCIS read path returns the full payload. Cross-node verification needs that second node — out of scope here.',
    ],
  },
  7: {
    title: 'Phase 7 — Cross-node verification + visibility summary',
    body: [
      'Until now the demo proved the WRITE side of the visibility model: anchors land in the public partition, payloads in the private partition, and grants are durably stored as `<kc> dkg:allowedPeer "<peer>"` triples in `<cg>/_meta`. This phase verifies the READ side from a SECOND devnet node — the "Anyone/Competitor" perspective — and finishes with a visibility table annotated with verification status.',
      'Three sub-steps: (7.A) confirm node2 sees public anchors; (7.B) confirm node2\'s local store has zero private triples (the negative case for non-grantees); (7.C) call out the one path the demo cannot drive end-to-end yet — the libp2p access-protocol fetch that would let an allowed peer pull the private payload over the wire. The Phase 6 grant uses node2\'s real libp2p peerId, so the durable triple actually corresponds to a real peer.',
    ],
  },
};

export const CLOSING = {
  title: 'Demo complete',
  body: [
    'You\'ve seen the EPCIS plugin\'s end-to-end story on synthesized Acme Bikes data. For agent integration: `node run.mjs --json`. For unattended: `--no-pause`.',
  ],
};
