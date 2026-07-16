import { describe, expect, it } from 'vitest';
import {
  buildEntities,
  canonicalEntityUri,
  isFirstClassEntity,
  type LayeredTriple,
  type TrustLevel,
} from '../src/ui/hooks/useMemoryEntities.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

const triple = (
  subject: string,
  predicate: string,
  object: string,
  layer: TrustLevel = 'working',
): LayeredTriple => ({ subject, predicate, object, layer });

describe('buildEntities — MemoryEntity.tripleCount', () => {
  // `tripleCount` must match the entity-row badge ↔ layer-page Triples
  // tab. The tab is fed `dedupeTriplesBySpo(...)` on layer pages
  // (`ProjectView.tsx`), so this count is distinct (s,p,o) across
  // input layered triples. Pre-fix the entity-row badge derived from
  // `connections.length + properties.size` and undercounted in three
  // independent ways: missing types, multi-value literal collapse,
  // and incoming triples not tracked. Cases below pin each + the
  // SPO dedup, self-link, and rdf:type-target edge cases.

  it('counts subject-side IRI connections (1 per distinct triple)', () => {
    const entities = buildEntities([
      triple('urn:e:a', 'urn:p:linksTo', 'urn:e:b'),
      triple('urn:e:a', 'urn:p:relates', 'urn:e:c'),
    ]);
    expect(entities.get('urn:e:a')?.tripleCount).toBe(2);
  });

  it('counts every literal value, not just distinct predicates (cause #2)', () => {
    // Two `description` literals on the same subject. `properties.size`
    // collapses both into one map entry — Triples tab shows 2 rows.
    const entities = buildEntities([
      triple('urn:e:x', 'urn:p:description', '"Sample EPCIS event"'),
      triple('urn:e:x', 'urn:p:description', '"Warehouse handling node"'),
    ]);
    expect(entities.get('urn:e:x')?.tripleCount).toBe(2);
  });

  it('counts rdf:type triples (cause #1)', () => {
    // Type triples are routed into `entity.types` and were never
    // counted by the pre-fix formula. Triples tab shows them as rows
    // (e.g. the "type → ObjectEvent" row in the ObjectEvent example).
    const entities = buildEntities([
      triple('urn:e:t', RDF_TYPE, 'urn:type:Thing'),
      triple('urn:e:t', 'urn:p:name', '"Hello"'),
    ]);
    expect(entities.get('urn:e:t')?.tripleCount).toBe(2);
  });

  it('counts incoming triples — entity as object (cause #3)', () => {
    // `(other, p, target)` shows in `target`'s Triples tab too; pre-fix
    // `target.tripleCount` ignored it entirely (no MemoryEntity field
    // tracked incoming references). This is the WM A260527 case.
    const entities = buildEntities([
      triple('urn:e:other', 'urn:p:isPartOf', 'urn:e:target'),
    ]);
    expect(entities.get('urn:e:other')?.tripleCount).toBe(1);
    expect(entities.get('urn:e:target')?.tripleCount).toBe(1);
  });

  it('combined: type + multi-value literal + connection + incoming sums correctly', () => {
    // Mirrors the SWM ObjectEvent sub-001 shape: 1 type, 1 name (literal),
    // 2 description literals (same predicate, different objects), 4 IRI
    // connections out, plus 1 incoming reference. Triples tab shows
    // 1+1+2+4+1 = 9 rows; pre-fix badge would have been 4+2 = 6.
    const sub = 'urn:e:sub';
    const entities = buildEntities([
      triple(sub, RDF_TYPE, 'urn:type:ObjectEvent'),
      triple(sub, 'urn:p:name', '"Inbound pallet receipt"'),
      triple(sub, 'urn:p:description', '"Sample EPCIS event"'),
      triple(sub, 'urn:p:description', '"Warehouse handling"'),
      triple(sub, 'urn:p:containsPlace', 'urn:e:warehouse'),
      triple(sub, 'urn:p:knowsAbout', 'urn:e:product'),
      triple(sub, 'urn:p:relatedLink', 'urn:e:distribution'),
      triple(sub, 'urn:p:relatedLink', 'urn:e:receipt'),
      triple('urn:e:parent', 'urn:p:hasPart', sub),
    ]);
    expect(entities.get(sub)?.tripleCount).toBe(9);
  });

  it('self-referential triples count once, not twice (`(A, p, A)`)', () => {
    // Regression: subject-side + object-side bumps are both `A`, so
    // a naive double-bump would yield 2 — but the Triples-tab filter
    // `s===uri || o===uri` matches the row once and shows 1. The
    // object-side bump must skip when `targetUri === entity.uri`.
    const entities = buildEntities([
      triple('urn:e:loop', 'urn:p:knows', 'urn:e:loop'),
    ]);
    expect(entities.get('urn:e:loop')?.tripleCount).toBe(1);
  });

  it('dedupes by SPO across multiple layered entries (matches layer-page tab)', () => {
    // The same `(s,p,o)` can appear in multiple named graphs — e.g. an
    // SWM entity promoted into a sub-graph lives in both
    // `<cg>/_shared_memory` and `<cg>/<sg>/_shared_memory`. The layer
    // page's Triples tab `dedupeTriplesBySpo`s before render
    // (`ProjectView.tsx`), so `tripleCount` must dedupe too — otherwise
    // the badge over-counts what the user sees in the tab.
    const entities = buildEntities([
      triple('urn:e:p', 'urn:p:knows', 'urn:e:q'),
      triple('urn:e:p', 'urn:p:knows', 'urn:e:q'),    // exact duplicate (different graph in reality)
      triple('urn:e:p', 'urn:p:knows', 'urn:e:other'), // distinct, still counts
    ]);
    // p sees 2 distinct outgoing triples; q sees 1 distinct incoming.
    expect(entities.get('urn:e:p')?.tripleCount).toBe(2);
    expect(entities.get('urn:e:q')?.tripleCount).toBe(1);
  });

  it('rdf:type bumps the type entity only when it has its own triples (Codex condition)', () => {
    // Two-tier behavior:
    //  • `schema:Thing` is a pure vocabulary URI with no own triples
    //    — never appears as an entity, so its incoming `rdf:type` rows
    //    are not tracked anywhere (matches pre-fix: it's invisible).
    //    Critically we must NOT create it as an entity (would break
    //    `useLayerTriples` residue filter by giving it a default
    //    `working` trustLevel — see inline note in `useMemoryEntities`).
    //  • `urn:type:Custom` has its own metadata triple, so it IS an
    //    entity. Its `tripleCount` must include incoming `rdf:type`
    //    rows so the badge matches the Triples tab.
    const entities = buildEntities([
      triple('urn:e:i1', RDF_TYPE, 'http://schema.org/Thing'),
      triple('urn:e:i2', RDF_TYPE, 'http://schema.org/Thing'),
      triple('urn:e:i3', RDF_TYPE, 'urn:type:Custom'),
      triple('urn:e:i4', RDF_TYPE, 'urn:type:Custom'),
      // Custom's own metadata — makes it a first-class entity.
      triple('urn:type:Custom', 'http://schema.org/label', '"Custom Class"'),
    ]);
    // Pure vocabulary class — not promoted to an entity.
    expect(entities.has('http://schema.org/Thing')).toBe(false);
    // Class with its own metadata — entity exists, count includes
    // own triples (1: label) + incoming rdf:type rows (2: from i3, i4).
    expect(entities.get('urn:type:Custom')?.tripleCount).toBe(3);
    // Instances unchanged: 1 distinct triple each.
    expect(entities.get('urn:e:i1')?.tripleCount).toBe(1);
    expect(entities.get('urn:e:i3')?.tripleCount).toBe(1);
  });

  it('rdf:type self-link counts once, not twice (defensive)', () => {
    // `(A, rdf:type, A)` is nonsense but the self-link guard in the
    // rdf:type branch must mirror the IRI-object branch — and the
    // class-target bump would otherwise be self-applied.
    const entities = buildEntities([
      triple('urn:e:weird', RDF_TYPE, 'urn:e:weird'),
    ]);
    expect(entities.get('urn:e:weird')?.tripleCount).toBe(1);
  });

  it('an IRI-object triple bumps BOTH endpoints (per-entity metric, summing overcounts)', () => {
    // Guardrail: this is the invariant that makes the field safe for
    // per-entity questions but unsafe for layer totals. Calling it out
    // explicitly so a future refactor that "optimises" the loop can't
    // silently drop the object-side bump.
    const entities = buildEntities([
      triple('urn:e:a', 'urn:p:linksTo', 'urn:e:b'),
    ]);
    const a = entities.get('urn:e:a')!;
    const b = entities.get('urn:e:b')!;
    expect(a.tripleCount).toBe(1);
    expect(b.tripleCount).toBe(1);
    // Sum (2) > input triples (1) — per-entity metric, not a layer aggregate.
    expect((a.tripleCount ?? 0) + (b.tripleCount ?? 0)).toBeGreaterThan(1);
  });

  it('promoted-entity residue: tripleCount reflects canonical-layer count only, not cross-layer total', () => {
    // Codex regression: a promoted SWM entity with WM-only draft residue
    // would have a badge that includes the WM rows, but the SWM-tab
    // detail view filters those out via `useLayerTriples`. Per-layer
    // SPO-deduped count finalised to canonical-layer slice fixes this.
    //
    // Scenario: `urn:e:promoted` has been promoted to SWM. Its current
    // SWM triples are 2 distinct rows; the daemon also leaves 1 WM
    // draft-residue triple on disk that the SWM tab would never show.
    const entities = buildEntities([
      // WM residue (pre-promote draft) — shows on no tab for the
      // promoted entity (`useLayerTriples` drops via residue filter).
      triple('urn:e:promoted', 'urn:p:draft', '"draft content"', 'working'),
      // Current SWM triples — what the SWM tab actually shows.
      triple('urn:e:promoted', 'urn:p:label', '"Promoted"', 'shared'),
      triple('urn:e:promoted', 'urn:p:status', '"published"', 'shared'),
    ]);
    const promoted = entities.get('urn:e:promoted')!;
    expect(promoted.trustLevel).toBe('shared');
    // Pre-fix this would be 3 (sum across layers). With per-layer
    // dedup + canonical-layer finalisation, it's 2 — what the SWM
    // tab actually shows.
    expect(promoted.tripleCount).toBe(2);
  });

  it('cross-layer resource→resource edges are dropped from per-layer count (matches useLayerTriples residue filter)', () => {
    // Codex regression: a WM-layer triple `(wm-a, p, swm-b)` is shown
    // on the WM Triples tab only if both endpoints are in WM
    // (`helpers.ts:444-448`). Since swm-b's canonical layer is `shared`,
    // useLayerTriples drops the row from WM view. The per-layer count
    // for wm-a must mirror this — otherwise badge over-counts vs tab.
    const entities = buildEntities([
      // Establish swm-b's canonical layer as `shared` via its own SWM triple.
      triple('urn:e:swm-b', 'urn:p:label', '"B"', 'shared'),
      // The cross-layer edge in WM — should NOT bump wm-a's WM count.
      triple('urn:e:wm-a', 'urn:p:references', 'urn:e:swm-b', 'working'),
      // A same-layer WM edge for comparison — SHOULD bump wm-a's WM count.
      triple('urn:e:wm-a', 'urn:p:knows', 'urn:e:wm-c', 'working'),
    ]);
    const wmA = entities.get('urn:e:wm-a')!;
    expect(wmA.trustLevel).toBe('working');
    // Only the wm-a→wm-c edge counts; the cross-layer edge is dropped.
    expect(wmA.tripleCount).toBe(1);
    // swm-b's canonical-layer count includes its own label only — the
    // cross-layer incoming edge from wm-a does NOT bump swm-b in WM
    // (it would, pre-fix, contribute to swm-b.counts.working, but
    // tripleCount = counts.shared which excludes WM bumps).
    expect(entities.get('urn:e:swm-b')?.tripleCount).toBe(1);
  });

  it('residue-filter does not over-drop: literal-object triples on a residue-layer pass', () => {
    // Subtle complement of the cross-layer-drop case. `useLayerTriples`
    // only checks subject.trustLevel for residue (line 426-427) and
    // ONLY checks the object trust level if the object is a resource
    // (line 444). A WM-layer LITERAL triple on a promoted SWM entity
    // still gets dropped by the subject-check, but the object-check
    // doesn't apply to literals — so for a SAME-layer literal edge on
    // a same-layer entity, nothing drops.
    const entities = buildEntities([
      triple('urn:e:e', 'urn:p:label', '"L"', 'working'),
    ]);
    expect(entities.get('urn:e:e')?.tripleCount).toBe(1);
  });

  it('cross-layer same-SPO does NOT collapse (each layer is its own dedup scope)', () => {
    // Edge of the dedup design: if the same (s,p,o) appears in two
    // DIFFERENT layers (e.g. as residue + current), each layer's count
    // includes it once. They contribute independently to per-layer
    // tabs and therefore must NOT cross-collapse.
    const entities = buildEntities([
      triple('urn:e:dual', 'urn:p:label', '"X"', 'working'),
      triple('urn:e:dual', 'urn:p:label', '"X"', 'shared'),
    ]);
    const dual = entities.get('urn:e:dual')!;
    expect(dual.trustLevel).toBe('shared');
    // Canonical-layer = 'shared' has 1 distinct triple. WM residue
    // is the same (s,p,o) but lives in its own per-layer count
    // (which we don't surface via `tripleCount` for an SWM-canonical
    // entity).
    expect(dual.tripleCount).toBe(1);
  });

  it('keeps skolemized child resources inspectable without rewriting marker literals', () => {
    const root = 'urn:doc:markdown';
    const section = `${root}/.well-known/genid/section-1-intro`;
    const literal = '"see /.well-known/genid/a"';

    expect(canonicalEntityUri(section)).toBe(section);
    expect(canonicalEntityUri(literal)).toBe(literal);

    const entities = buildEntities([
      triple(root, 'http://dkg.io/ontology/hasSection', section, 'shared'),
      triple(section, 'http://schema.org/name', '"Intro"', 'shared'),
      triple(section, 'http://schema.org/description', literal, 'shared'),
    ]);

    const rootEntity = entities.get(root);
    const sectionEntity = entities.get(section);
    expect(rootEntity).toBeDefined();
    expect(sectionEntity).toBeDefined();
    expect(isFirstClassEntity(rootEntity!)).toBe(true);
    expect(isFirstClassEntity(sectionEntity!)).toBe(true);
    expect(sectionEntity?.properties.get('http://schema.org/description')).toEqual(['see /.well-known/genid/a']);
  });
});
