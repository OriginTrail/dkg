# ADR 0005 — Versioned documentation archive

- **Status**: Accepted
- **Date**: 2026-05-26

## Context

The current docs tree mixes V10 release-candidate material with V9-era setup guides, specs, onboarding pages, plans, and historical reports. That creates a direct retrieval risk: agents can answer from stale docs that look current because they live near supported V10 material.

## Decision

All non-V10 docs will be moved under versioned archive folders, such as `docs/archive/v9/` or `docs/archive/v8/`. Current V10 docs must not link to old-version docs, and generated agent context must exclude the archive by default. The V10 docs themselves must be updated to reflect current supported behavior rather than depending on old pages as transitional references.

## Consequences

- Metadata alone is not enough for stale docs; path-level separation is required.
- Current docs navigation and generated agent packs exclude version archives.
- V10 pages need current replacements for any old setup, concept, architecture, or reference pages they previously linked to.
- Archive material remains available for historical inspection but is not part of the current documentation graph.
