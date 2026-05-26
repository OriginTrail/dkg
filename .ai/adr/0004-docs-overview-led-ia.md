# ADR 0004 — Docs overview-led information architecture

- **Status**: Accepted
- **Date**: 2026-05-26

## Context

The DKG docs refresh needs to serve both humans and agents. A pure task-first structure risks giving agents narrow command playbooks without the system model they need to reason about WM/SWM/VM, context graphs, Knowledge Assets, trust, finality, and stale V9 material. A pure architecture-first structure risks burying installation, integration, and troubleshooting intents.

## Decision

The public DKG docs information architecture will be overview-led, task-routed, and architecture-backed. The first visible page is **Overview**: a compact system map that explains DKG and routes readers to install, connect, publish, query, operate, troubleshoot, architecture, and reference material. Agent context packs start from the same overview compressed into operational context, then route into task-specific pages and exact commands.

Top-level public navigation will prefer product/workflow labels, such as **Build with DKG**, **Understand DKG**, **Operate a Node**, **Reference**, **For AI Agents**, and **Archive**, instead of exposing neutral taxonomy labels as the primary surface. **For AI Agents** is a visible top-level section, not only hidden generated endpoints, so humans can inspect the same agent-facing projections that agents consume. Diataxis-style categories stay as internal `doc_type` metadata for generation, retrieval, and review.

## Consequences

- Do not label the public entry point `index`; `index.md` may exist only as a framework implementation detail.
- Do not make the docs task-only. Agents get the map first, then the route, then the exact commands.
- Do not rely on public labels such as `Guides` and `Concepts` as the primary IA if product/workflow labels are available.
- Keep **For AI Agents** visible in top-level navigation.
- Keep `doc_type` metadata for how-to, concept, reference, architecture, invariant, and playbook classification underneath the visible nav.
- Keep the Node Skill as the operational contract, while the docs corpus explains the DKG node as a whole.
- Generate or curate agent projections from the current corpus only; archive material must not pollute default retrieval.
- Move non-V10 docs under versioned archive paths, such as `docs/archive/v9/` or `docs/archive/v8/`, and remove links from current V10 docs to old-version docs.
