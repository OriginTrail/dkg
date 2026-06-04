---
id: urn:e2e:fixture:single-entity
type: Article
name: Migrate To NPM
description: Trimmed single-root fixture for the WM to SWM to VM e2e.
keywords: [migration, npm]
---

# Migrate To NPM

A deliberately small Markdown document used by the WM -> SWM -> VM
end-to-end test. The deterministic Markdown extractor turns this into
exactly one NAMED root entity (`urn:e2e:fixture:single-entity`) plus a
handful of BLANK-NODE section subjects (`_:dkg-md-section-N`, linked via
`dkg:hasSection`).

The blank nodes are the whole point: promoting this assertion exercises
the WM-cleanup `DELETE` over blank-node-bearing triples, which strict
SPARQL servers (oxigraph-server — the rc.15 fresh-install default) reject
inside `DELETE DATA`. Keep at least one `##` section heading here so the
extractor always emits blank nodes.

## Background

This section becomes a blank-node subject linked from the root via
`dkg:hasSection`, with a `schema:name` of "Background".

## Steps

A second blank-node section so the fixture covers more than one blank
subject. Do not remove these headings.
