# ADR 0001 — Codebase decision records live in agent memory

- **Status**: Accepted
- **Date**: 2026-05-26

## Context

The docs refresh separates public product documentation from codebase memory. Existing repo-level ADRs are primarily useful to agents and maintainers working in the codebase. They are not part of the initial public docs experience unless a specific decision is needed to help humans or agents understand DKG behavior.

## Decision

Repo-level ADRs and implementation decision records belong in `.ai/adr/`, with `.ai/decisions.md` acting as the index. Public docs should not expose ADRs by default. If a decision is necessary for public understanding, write a user-facing architecture or concept page derived from the decision rather than publishing the raw ADR. Track `.ai/adr/*.md` and `.ai/decisions.md` in git; keep other `.ai/` scratch files ignored unless explicitly promoted.

Existing repo-level ADRs were moved from `docs/adr/*` and package-local `docs/adr/*` paths into `.ai/adr/` during the docs refresh follow-up. Public navigation plus generated agent projections must not link raw ADRs.

## Consequences

- ADR files under public `docs/adr/` paths are invalid; add new decision records under `.ai/adr/`.
- Internal references to old `docs/adr/*` paths should be updated to `.ai/adr/*`.
- Public docs navigation and generated public docs context should exclude `.ai/`.
- Agent context may include `.ai/adr/` when working on the codebase.
- `.gitignore` allows only durable `.ai` decision records by default.
