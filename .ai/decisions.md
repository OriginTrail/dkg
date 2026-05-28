# Decisions

## 2026-05-26 — Docs IA Is Overview-Led

The DKG docs refresh uses an overview-led, task-routed, architecture-backed
information architecture aligned to `OriginTrail/dkgv10-spec#119`. Public docs
start with `docs/README.md`, not a visible `index.md`; the root describes DKG
V10 as a decentralized knowledge network/protocol and the DKG node as the local
gateway. Public navigation is `how-dkg-works`, `use-dkg`, `reference`, and
`agent-context`; the old `build`, `operate`, `understand`, `architecture`, and
`for-ai-agents` split is rejected. Agent context packs are projections of the
current corpus before task routing and exact commands.

See `.ai/adr/0004-docs-overview-led-ia.md`.

## 2026-05-26 — Non-V10 Docs Move To Versioned Archive

All non-V10 docs should be moved under versioned archive folders such as
`docs/archive/v9/` or `docs/archive/v8/`. Current V10 docs should not link to
old-version docs, and replacement V10 docs must be updated to current behavior.

See `.ai/adr/0005-versioned-docs-archive.md`.

## 2026-05-26 — Repo-Level ADRs Live In `.ai/adr/`

Repo-level ADRs and implementation decision records are codebase memory for
maintainers and coding agents. They live outside public docs under
`.ai/adr/`, with public docs getting derived architecture explainers only when a
decision is necessary for initial product understanding.

Public docs navigation and generated agent projections must not expose raw ADRs.

See `.ai/adr/0001-codebase-decision-records.md`.
