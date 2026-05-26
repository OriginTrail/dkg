# ADR 0001 — Codebase decision records live in agent memory

- **Status**: Accepted
- **Date**: 2026-05-26

## Context

The docs refresh separates public product documentation from codebase memory. Existing repo-level ADRs are primarily useful to agents and maintainers working in the codebase. They are not part of the initial public docs experience unless a specific decision is needed to help humans or agents understand DKG behavior.

## Decision

Repo-level ADRs and implementation decision records belong in `.ai/adr/`, with `.ai/decisions.md` acting as the index. Public docs should not expose ADRs by default. If a decision is necessary for public understanding, write a user-facing architecture or concept page derived from the decision rather than publishing the raw ADR. Track `.ai/adr/*.md` and `.ai/decisions.md` in git; keep other `.ai/` scratch files ignored unless explicitly promoted.

Migration of existing `docs/adr/*` files is deferred until the ADR set is moved together. During the docs refresh, leave existing ADR files in `docs/adr/` and keep public navigation plus generated agent projections from linking them.

## Consequences

- Current `docs/adr/*` files stay in place until the full ADR migration.
- Internal references to `docs/adr/*` should be updated during that migration.
- Public docs navigation and generated public docs context should exclude `.ai/`.
- Agent context may include `.ai/adr/` when working on the codebase.
- `.gitignore` allows only durable `.ai` decision records by default.
