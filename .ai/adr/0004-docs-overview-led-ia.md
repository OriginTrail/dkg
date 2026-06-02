# ADR 0004 — Docs overview-led information architecture

- **Status**: Accepted
- **Date**: 2026-05-26

## Context

The DKG docs refresh needs to serve both humans and agents. A pure task-first structure risks giving agents narrow command playbooks without the system model they need to reason about WM/SWM/VM, context graphs, Knowledge Assets, trust, finality, and stale V9 material. A pure architecture-first structure risks burying installation, integration, and troubleshooting intents.

This decision was later aligned to `OriginTrail/dkgv10-spec#119`: the public IA uses one root page plus `how-dkg-works`, `use-dkg`, `reference`, and `agent-context`. The rejected intermediate split (`build`, `operate`, `understand`, `architecture`, `for-ai-agents`) is not the accepted public structure.

## Decision

The public DKG docs information architecture will be overview-led, task-routed, and architecture-backed. The first visible page is `docs/README.md`: a compact DKG V10 system map that describes DKG as a decentralized knowledge network/protocol and the DKG node as the local gateway into that network.

Top-level public navigation is the accepted #119 structure:

- `docs/how-dkg-works/` for the system model and implementation architecture.
- `docs/use-dkg/` for installation, connection, publishing/querying, operation, and troubleshooting workflows.
- `docs/references/` for exact lookup pointers to package-owned contracts.
- `docs/agent-context/` for agent projections derived from the current corpus.

Diataxis-style categories stay as internal `doc_type` metadata for generation, retrieval, and review.

## Consequences

- Do not label the public entry point `index`; `index.md` may exist only as a framework implementation detail.
- Do not make the docs task-only. Agents get the map first, then the route, then the exact commands.
- Do not recreate the intermediate `docs/build`, `docs/operate`, `docs/understand`, or `docs/architecture` split.
- Treat `docs/agent-context` as a projection of the current corpus, not as a competing public-docs alternative.
- Keep `doc_type` metadata for how-to, concept, reference, architecture, invariant, and playbook classification underneath the visible nav.
- Keep the Node Skill as the operational contract, while the docs corpus explains the DKG node as a whole.
- Generate or curate agent projections from the current corpus only; archive material must not pollute default retrieval.
- Move non-V10 docs under versioned archive paths, such as `docs/archive/v9/` or `docs/archive/v8/`, and remove links from current V10 docs to old-version docs.
