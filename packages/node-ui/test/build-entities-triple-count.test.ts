import { describe, expect, it } from 'vitest';
import { buildEntities, type LayeredTriple } from '../src/ui/hooks/useMemoryEntities.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

const triple = (
  subject: string,
  predicate: string,
  object: string,
): LayeredTriple => ({ subject, predicate, object, layer: 'working' });

describe('buildEntities — MemoryEntity.tripleCount', () => {
  // The Triples tab on the entity-detail page derives its row count
  // from `allTriples.filter(t => t.subject === uri || t.object === uri)`,
  // so `tripleCount` must match. Pre-fix the entity-row badge derived
  // from `connections.length + properties.size` and undercounted in
  // three independent ways: missing types, multi-value literal collapse,
  // and incoming triples not tracked. Cases below pin each.

  it('counts subject-side IRI connections (1 per triple, dedup is for display only)', () => {
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
    expect(a.tripleCount + b.tripleCount).toBeGreaterThan(1);
  });
});
