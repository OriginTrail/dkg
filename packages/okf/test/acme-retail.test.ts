import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  importBundle,
  exportBundle,
  loadBundleDir,
  quadsToNQuads,
  validateBundle,
  parseDocument,
  isStale,
  RDF_TYPE,
  RDF_JSON,
  SCHEMA_NS,
  SCHEMA_NAME,
  PROV_WAS_DERIVED_FROM,
  OKF_TRUST_TIER,
  OKF_STATUS,
  OKF_SOURCE,
  OKF_RESOURCE,
  OKF_USAGE_COUNT,
  OKF_USAGE_WINDOW_FROM,
  OKF_PARAMETER,
  OKF_EXECUTOR_RESOURCE,
  OKF_EXECUTOR_RECEIPT,
  OKF_ATTESTER_RESOURCE,
  OKF_CLASS_SOURCE,
  DKG_HAS_SECTION,
  SECTION_GENID_INFIX,
  GENID_TAGS,
  XSD_INTEGER,
} from '../src/index.js';
import type { BundleImport, Quad } from '../src/index.js';

const files = loadBundleDir(fileURLToPath(new URL('./fixtures/acme_retail', import.meta.url)));

const concept = (r: BundleImport, id: string) => {
  const c = r.concepts.find((x) => x.conceptId === id);
  if (!c) throw new Error(`no concept ${id}`);
  return c;
};
const objs = (quads: Quad[], subject: string, predicate: string) =>
  quads.filter((q) => q.subject === subject && q.predicate === predicate).map((q) => q.object);

/** Everything but the presentational section structure (see roundtrip.test.ts). */
function semantic(quads: Quad[]): string {
  const sectionNode = SECTION_GENID_INFIX + GENID_TAGS.section;
  return quadsToNQuads(quads.filter((q) => !q.subject.includes(sectionNode) && q.predicate !== DKG_HAS_SECTION));
}

describe("acme_retail golden import (Google's OKF v0.2 reference bundle)", () => {
  const r = importBundle(files);

  it('mints 9 Knowledge Assets and skips the 8 reserved files (7 index.md + log.md)', () => {
    expect(r.concepts.map((c) => c.conceptId).sort()).toEqual([
      'computations/gross-margin-period',
      'computations/revenue-ytd',
      'metrics/gross-margin',
      'metrics/gross-margin-legacy',
      'metrics/revenue',
      'policies/margin-standard',
      'policies/revenue-recognition',
      'skills/run-on-bq',
      'tables/orders',
    ]);
    expect(r.reservedSkipped).toHaveLength(8);
    expect(r.reservedSkipped).toContain('log.md');
    // the upstream bundle does not declare okf_version in its root index.md
    expect(r.okfVersion).toBeNull();
  });

  it('imports with no diagnostics; validation only flags the frontmatter on the upstream log.md', () => {
    expect(r.warnings).toEqual([]);
    const report = validateBundle(files);
    expect(report.conformant).toBe(true);
    expect(report.warnings).toEqual(['reserved file log.md carries frontmatter (§8/§9 expect none)']);
  });

  it('derives the trust / lifecycle summary per concept exactly as §5 prescribes', () => {
    expect(concept(r, 'metrics/revenue').trust).toEqual({
      tier: 'human-reviewed',
      status: 'stable',
      staleAfter: '2026-12-31T00:00:00Z',
      generatedBy: 'reference_agent/gemini-2.5-pro',
      generatedAt: '2026-06-30T14:00:00Z',
      verifications: 1,
      sources: 1,
      derivedFromConcepts: ['policies/revenue-recognition'],
      attestedComputation: false,
    });
    expect(concept(r, 'metrics/gross-margin-legacy').trust).toMatchObject({ tier: 'human-reviewed', status: 'deprecated', staleAfter: null });
    expect(concept(r, 'skills/run-on-bq').trust).toMatchObject({ tier: 'unverified', verifications: 0, generatedBy: 'human:kliu@acme' });
    expect(r.concepts.filter((c) => c.trust.attestedComputation).map((c) => c.conceptId)).toEqual([
      'computations/gross-margin-period',
      'computations/revenue-ytd',
    ]);
    expect(r.concepts.filter((c) => c.trust.tier === 'human-reviewed')).toHaveLength(8);
  });

  it('materialises the tier, status and lineage edges as queryable triples', () => {
    const rev = concept(r, 'computations/revenue-ytd');
    expect(objs(rev.quads, rev.iri, OKF_TRUST_TIER)).toEqual(['"human-reviewed"']);
    expect(objs(rev.quads, rev.iri, OKF_STATUS)).toEqual(['"stable"']);
    expect(objs(rev.quads, rev.iri, PROV_WAS_DERIVED_FROM).sort()).toEqual([
      'urn:okf:policies/revenue-recognition',
      'urn:okf:tables/orders',
    ]);
    expect(rev.trust.derivedFromConcepts).toEqual(['policies/revenue-recognition', 'tables/orders']);
    // the legacy metric is deprecated and derives from nothing
    const legacy = concept(r, 'metrics/gross-margin-legacy');
    expect(objs(legacy.quads, legacy.iri, OKF_STATUS)).toEqual(['"deprecated"']);
    expect(objs(legacy.quads, legacy.iri, PROV_WAS_DERIVED_FROM)).toEqual([]);
  });

  it('maps the Attested Computation contract: executor skill as a typed edge, attester code as a literal path', () => {
    const rev = concept(r, 'computations/revenue-ytd');
    expect(objs(rev.quads, rev.iri, RDF_TYPE)).toEqual([SCHEMA_NS + 'AttestedComputation']);
    expect(objs(rev.quads, rev.iri, OKF_EXECUTOR_RESOURCE)).toEqual(['urn:okf:skills/run-on-bq']);
    expect(objs(rev.quads, rev.iri, OKF_EXECUTOR_RECEIPT).sort()).toEqual(['"executed_sql"', '"job_id"', '"result"']);
    expect(objs(rev.quads, rev.iri, OKF_ATTESTER_RESOURCE)).toEqual(['"attesters/sql_equality.py"']);
    const gm = concept(r, 'computations/gross-margin-period');
    const params = objs(gm.quads, gm.iri, OKF_PARAMETER);
    expect(params).toHaveLength(2);
    expect(params.map((p) => objs(gm.quads, p, SCHEMA_NAME)[0])).toEqual(['"period_start"', '"period_end"']);
  });

  it('carries the credibility signals on okf:Source nodes (usage_count, usage_window, resolved policy)', () => {
    const orders = concept(r, 'tables/orders');
    const sources = objs(orders.quads, orders.iri, OKF_SOURCE);
    expect(sources).toHaveLength(2);
    expect(objs(orders.quads, sources[0], RDF_TYPE)).toEqual([OKF_CLASS_SOURCE]);
    expect(objs(orders.quads, sources[0], OKF_RESOURCE)).toEqual(['https://wiki.acme.internal/data/warehouse/schemas/sales']);
    expect(objs(orders.quads, sources[0], OKF_USAGE_COUNT)).toEqual([`"1240"^^<${XSD_INTEGER}>`]);
    expect(objs(orders.quads, sources[1], OKF_RESOURCE)).toEqual(['urn:okf:policies/revenue-recognition']);
    expect(objs(orders.quads, orders.iri, OKF_USAGE_WINDOW_FROM)).toHaveLength(1);
  });

  it('preserves the producer-defined `not:` extension as rdf:JSON', () => {
    const gm = concept(r, 'metrics/gross-margin');
    const not = objs(gm.quads, gm.iri, SCHEMA_NS + 'not');
    expect(not).toHaveLength(1);
    expect(not[0].endsWith(`^^<${RDF_JSON}>`)).toBe(true);
  });

  it('is byte-identical across runs', () => {
    expect(quadsToNQuads(importBundle(files).quads)).toBe(quadsToNQuads(r.quads));
  });

  it('staleness is a consumer-side instant comparison (every dated concept turns stale on 2027-01-01)', () => {
    const now = new Date('2026-10-13T00:00:00Z');
    expect(r.concepts.filter((c) => isStale(c.trust.staleAfter, now))).toHaveLength(0);
    const later = new Date('2027-01-01T00:00:00Z');
    expect(r.concepts.filter((c) => isStale(c.trust.staleAfter, later)).map((c) => c.conceptId).sort()).toEqual([
      'computations/gross-margin-period',
      'computations/revenue-ytd',
      'metrics/gross-margin',
      'metrics/revenue',
      'policies/margin-standard',
      'policies/revenue-recognition',
      'tables/orders',
    ]);
  });
});

describe('acme_retail round-trip: import → export → import', () => {
  const first = importBundle(files);
  const exported = exportBundle(first);
  const second = importBundle(exported);

  it('reproduces an equivalent semantic graph, family nodes included', () => {
    expect(semantic(second.quads)).toBe(semantic(first.quads));
  });

  it('writes a conformant v0.2 bundle whose trust summaries match the original', () => {
    expect(validateBundle(exported).conformant).toBe(true);
    expect(second.okfVersion).toBe('0.2');
    for (const c of first.concepts) expect(concept(second, c.conceptId).trust).toEqual(c.trust);
  });

  it('restores the spec spelling of the Attested Computation type and the §5 families', () => {
    const file = exported.find((f) => f.path === 'computations/revenue-ytd.md')!;
    const fm = parseDocument(file.path, file.content).frontmatter;
    expect(fm.type).toBe('Attested Computation');
    expect(fm.generated).toEqual({ by: 'reference_agent/gemini-2.5-pro', at: '2026-06-30T14:00:00Z' });
    expect(fm.verified).toEqual([{ by: 'human:jsmith@acme', at: '2026-07-01T09:00:00Z' }]);
    expect(fm.stale_after).toBe('2026-12-31T00:00:00Z');
    expect(fm.executor).toEqual({ resource: '/skills/run-on-bq.md', receipt: ['executed_sql', 'job_id', 'result'] });
    expect(fm.attester).toEqual({ resource: 'attesters/sql_equality.py' });
    expect((fm.sources as unknown[]).length).toBe(2);
  });
});
