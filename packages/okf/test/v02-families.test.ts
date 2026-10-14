import { describe, it, expect } from 'vitest';
import {
  exportBundle,
  familyDiagnostics,
  familyQuads,
  importBundle,
  isSafeIri,
  okfExtensionKey,
  okfExtensionPredicate,
  parseBody,
  parseDocument,
  quadsToNQuads,
  summarizeTrust,
  validateBundle,
  GENID_TAGS,
  OKF_ATTESTER_RESOURCE,
  OKF_AUTHOR,
  OKF_CLASS_PARAMETER,
  OKF_CLASS_SOURCE,
  OKF_CLASS_VERIFICATION,
  OKF_COMPUTATION,
  OKF_EXECUTOR_RECEIPT,
  OKF_EXECUTOR_RESOURCE,
  OKF_GENERATED_BY,
  OKF_NS,
  OKF_PARAMETER,
  OKF_PARAMETER_TYPE,
  OKF_REQUIRED,
  OKF_RESOURCE,
  OKF_RUNTIME,
  OKF_SOURCE,
  OKF_STALE_AFTER,
  OKF_STATUS,
  OKF_TRUST_TIER,
  OKF_USAGE_COUNT,
  OKF_USAGE_WINDOW_FROM,
  OKF_USAGE_WINDOW_TO,
  OKF_VERIFICATION,
  OKF_VERIFIED_AT,
  OKF_VERIFIED_BY,
  PROV_WAS_DERIVED_FROM,
  RDF_TYPE,
  SCHEMA_DATE_MODIFIED,
  SCHEMA_IDENTIFIER,
  SCHEMA_NAME,
  RDF_JSON,
  SCHEMA_NS,
  V02_FAMILY_KEYS,
  XSD_BOOLEAN,
  XSD_INTEGER,
} from '../src/index.js';
import * as okfPublic from '../src/index.js';
import { decodeFamilies, prepareFamily, resolveReferences, FAMILY_SPECS, FAMILY_BY_KEY, VERIFIED } from '../src/families/index.js';
import type { Quad } from '../src/index.js';
import { DT, IDX_V02, objs, node, bundle, conceptOf, exportedFrontmatter, semantic } from './helpers/okf-v02-fixtures.js';

describe('§5.2 generated / legacy timestamp', () => {
  it('maps generated.by → okf:generatedBy and generated.at → schema:dateModified (canonical lexical)', () => {
    const { c } = conceptOf(bundle('type: Metric\ngenerated: { by: reference_agent/gemini-2.5-pro, at: 2026-06-30T14:00:00Z }'));
    expect(objs(c.quads, OKF_GENERATED_BY)).toEqual(['"reference_agent/gemini-2.5-pro"']);
    expect(objs(c.quads, SCHEMA_DATE_MODIFIED)).toEqual([DT('2026-06-30T14:00:00Z')]);
    expect(c.trust.generatedBy).toBe('reference_agent/gemini-2.5-pro');
    expect(c.trust.generatedAt).toBe('2026-06-30T14:00:00Z');
  });
  it('falls back to the v0.1 timestamp when generated is absent (§13.1)', () => {
    const { c } = conceptOf(bundle("type: Metric\ntimestamp: '2026-05-28T22:44:47+00:00'"));
    expect(objs(c.quads, SCHEMA_DATE_MODIFIED)).toEqual([DT('2026-05-28T22:44:47+00:00')]);
    expect(objs(c.quads, OKF_GENERATED_BY)).toEqual([]);
    expect(c.trust.generatedAt).toBe('2026-05-28T22:44:47+00:00');
  });
  it('lets generated.at win over a leftover timestamp, preserving the latter as a producer key', () => {
    const { c } = conceptOf(
      bundle("type: Metric\ntimestamp: '2026-01-01T00:00:00Z'\ngenerated: { by: human:a, at: 2026-06-30T14:00:00Z }"),
    );
    expect(objs(c.quads, SCHEMA_DATE_MODIFIED)).toEqual([DT('2026-06-30T14:00:00Z')]);
    expect(objs(c.quads, SCHEMA_NS + 'timestamp')).toEqual(['"2026-01-01T00:00:00Z"']);
  });
  it('preserves producer keys nested inside generated under the okf:generated.<key> extension predicate', () => {
    const { c } = conceptOf(bundle('type: Metric\ngenerated: { by: human:a, at: 2026-06-30T14:00:00Z, model: gemini-2.5-pro }'));
    expect(objs(c.quads, OKF_NS + 'generated.model')).toEqual(['"gemini-2.5-pro"']);
    expect(exportedFrontmatter(bundle('type: Metric\ngenerated: { by: human:a, at: 2026-06-30T14:00:00Z, model: gemini-2.5-pro }')).generated).toEqual({
      by: 'human:a',
      at: '2026-06-30T14:00:00Z',
      model: 'gemini-2.5-pro',
    });
  });
  it('keeps a non-mapping generated verbatim (schema:generated) and reports it', () => {
    const { c, r } = conceptOf(bundle('type: Metric\ngenerated: 2026-06-30T14:00:00Z'));
    expect(objs(c.quads, SCHEMA_NS + 'generated')).toEqual([DT('2026-06-30T14:00:00Z')]);
    expect(r.warnings.some((w) => w.code === 'malformed-family' && /`generated` must be/.test(w.message))).toBe(true);
    expect(validateBundle(bundle('type: Metric\ngenerated: 2026-06-30T14:00:00Z')).conformant).toBe(true);
  });
  it('reports a generated block without by', () => {
    const d = familyDiagnostics({ type: 'Metric', generated: { at: '2026-06-30T14:00:00Z' } });
    expect(d.map((x) => x.message).join(' ')).toMatch(/generated\.by` is required/);
  });
});

describe('§5.2 / §5.3 verified and trust tiers', () => {
  it('treats a bare mapping as one event and derives human-reviewed', () => {
    const { c } = conceptOf(bundle('type: Metric\nverified: { by: human:ahormati, at: 2026-06-25T09:00:00Z }'));
    expect(objs(c.quads, OKF_VERIFICATION)).toEqual([node(GENID_TAGS.verification, 0)]);
    const v = node(GENID_TAGS.verification, 0);
    expect(objs(c.quads, RDF_TYPE, v)).toEqual([OKF_CLASS_VERIFICATION]);
    expect(objs(c.quads, OKF_VERIFIED_BY, v)).toEqual(['"human:ahormati"']);
    expect(objs(c.quads, OKF_VERIFIED_AT, v)).toEqual([DT('2026-06-25T09:00:00Z')]);
    expect(objs(c.quads, OKF_TRUST_TIER)).toEqual(['"human-reviewed"']);
    expect(c.trust).toMatchObject({ tier: 'human-reviewed', verifications: 1 });
  });
  it('mints one node per list entry (index in the IRI) and derives machine-confirmed for non-human actors', () => {
    const { c } = conceptOf(
      bundle('type: Metric\nverified:\n  - { by: process:finance-nightly, at: 2026-06-26T02:00:00Z }\n  - { by: reference_agent/gemini-2.5-pro, at: 2026-06-27T02:00:00Z, note: re-run }'),
    );
    expect(objs(c.quads, OKF_VERIFICATION)).toEqual([node(GENID_TAGS.verification, 0), node(GENID_TAGS.verification, 1)]);
    expect(objs(c.quads, OKF_TRUST_TIER)).toEqual(['"machine-confirmed"']);
    expect(objs(c.quads, okfExtensionPredicate('verified', 'note'), node(GENID_TAGS.verification, 1))).toEqual(['"re-run"']);
  });
  it('emits no tier for an empty list and skips entries without a verifier (reported, never fatal)', () => {
    const { c, r } = conceptOf(bundle('type: Metric\nverified:\n  - { at: 2026-06-26T02:00:00Z }\n  - nope'));
    expect(objs(c.quads, OKF_VERIFICATION)).toEqual([]);
    expect(objs(c.quads, OKF_TRUST_TIER)).toEqual([]);
    expect(c.trust.tier).toBe('unverified');
    const msgs = r.warnings.filter((w) => w.code === 'malformed-family').map((w) => w.message).join('\n');
    expect(msgs).toMatch(/verified\[0\]\.by` is missing/);
    expect(msgs).toMatch(/verified\[1\]` is not a/);
    const empty = conceptOf(bundle('type: Metric\nverified: []')).c;
    expect(objs(empty.quads, OKF_TRUST_TIER)).toEqual([]);
  });
  it('keeps a scalar verified verbatim and reports it', () => {
    const { c, r } = conceptOf(bundle('type: Metric\nverified: true'));
    expect(objs(c.quads, SCHEMA_NS + 'verified')).toEqual([`"true"^^<${XSD_BOOLEAN}>`]);
    expect(r.warnings.some((w) => /`verified` must be/.test(w.message))).toBe(true);
  });
  it('round-trips verified events in order through export', () => {
    const fm = exportedFrontmatter(
      bundle('type: Metric\nverified:\n  - { by: process:nightly, at: 2026-06-26T02:00:00Z }\n  - { by: human:ahormati, at: 2026-06-25T09:00:00Z, note: ok }'),
    );
    expect(fm.verified).toEqual([
      { by: 'process:nightly', at: '2026-06-26T02:00:00Z' },
      { by: 'human:ahormati', at: '2026-06-25T09:00:00Z', note: 'ok' },
    ]);
  });
});

describe('§5.4 / §5.5 status and stale_after', () => {
  it('maps status and stale_after flat on the concept', () => {
    const { c } = conceptOf(bundle('type: Metric\nstatus: deprecated\nstale_after: 2026-12-31T00:00:00Z'));
    expect(objs(c.quads, OKF_STATUS)).toEqual(['"deprecated"']);
    expect(objs(c.quads, OKF_STALE_AFTER)).toEqual([DT('2026-12-31T00:00:00Z')]);
    expect(c.trust).toMatchObject({ status: 'deprecated', staleAfter: '2026-12-31T00:00:00Z' });
    expect(exportedFrontmatter(bundle('type: Metric\nstatus: deprecated\nstale_after: 2026-12-31T00:00:00Z'))).toMatchObject({
      status: 'deprecated',
      stale_after: '2026-12-31T00:00:00Z',
    });
  });
  it('never materialises the stable default', () => {
    const { c } = conceptOf(bundle('type: Metric'));
    expect(objs(c.quads, OKF_STATUS)).toEqual([]);
    expect(c.trust.status).toBe('stable');
  });
  it('tolerates an unknown status with a warning, and keeps an unparseable stale_after as a plain literal', () => {
    const files = bundle("type: Metric\nstatus: retired\nstale_after: 'next quarter'");
    const { c, r } = conceptOf(files);
    expect(objs(c.quads, OKF_STATUS)).toEqual(['"retired"']);
    expect(objs(c.quads, OKF_STALE_AFTER)).toEqual(['"next quarter"']);
    const msgs = r.warnings.map((w) => w.message).join('\n');
    expect(msgs).toMatch(/"retired" is not one of draft \| stable \| deprecated/);
    expect(msgs).toMatch(/stale_after` "next quarter" is not a valid ISO 8601 datetime/);
    const report = validateBundle(files);
    expect(report.conformant).toBe(true);
    expect(report.warnings.join('\n')).toMatch(/retired/);
  });
  it('keeps an impossible calendar value as a plain literal with a warning (never a bogus xsd:dateTime)', () => {
    const files = bundle("type: Metric\nstale_after: '2026-02-30T00:00:00Z'");
    const { c, r } = conceptOf(files);
    expect(objs(c.quads, OKF_STALE_AFTER)).toEqual(['"2026-02-30T00:00:00Z"']);
    expect(r.warnings.map((w) => w.message).join('\n')).toMatch(/stale_after` "2026-02-30T00:00:00Z" is not a valid ISO 8601 datetime/);
    expect(validateBundle(files).warnings.join('\n')).toMatch(/2026-02-30/);
    // a well-formed value is typed, and the same instant is not reported stale by an impossible one
    const ok = conceptOf(bundle("type: Metric\nstale_after: '2026-02-28T00:00:00Z'")).c;
    expect(objs(ok.quads, OKF_STALE_AFTER)).toEqual([DT('2026-02-28T00:00:00Z')]);
    // an out-of-range offset is just as invalid: plain literal plus the warning
    const offset = conceptOf(bundle("type: Metric\nstale_after: '2026-12-31T00:00:00+15:00'"));
    expect(objs(offset.c.quads, OKF_STALE_AFTER)).toEqual(['"2026-12-31T00:00:00+15:00"']);
    expect(offset.r.warnings.map((w) => w.message).join('\n')).toMatch(/"2026-12-31T00:00:00\+15:00" is not a valid ISO 8601 datetime/);
  });
  it('names a usage_window bound like every other field, at concept and source level', () => {
    const { r } = conceptOf(
      bundle("type: Metric\nusage_window: { from: soon, to: 2026-06-30T00:00:00Z }\nsources:\n  - { id: s, resource: https://x.example/s, usage_window: { from: '2026-13-01T00:00:00Z' } }"),
    );
    const messages = r.warnings.map((w) => w.message);
    expect(messages).toContain('`usage_window.from` "soon" is not a valid ISO 8601 datetime (§5); kept as a plain literal');
    expect(messages).toContain('`sources[0].usage_window.from` "2026-13-01T00:00:00Z" is not a valid ISO 8601 datetime (§5); kept as a plain literal');
  });
  it('warns when a timestamp lacks the explicit UTC offset OKF requires', () => {
    const { r } = conceptOf(bundle("type: Metric\nstale_after: '2026-12-31T00:00:00'"));
    expect(r.warnings.map((w) => w.message).join('\n')).toMatch(/has no explicit UTC offset/);
  });
});

describe('§5.1 sources and provenance', () => {
  const SOURCES = [
    'type: Metric',
    'sources:',
    '  - id: ga4-schema',
    '    resource: https://developers.google.com/analytics/bigquery/export-schema',
    '    title: GA4 BigQuery Export schema',
    '    author: team:ga4-docs',
    '    usage_count: 5000',
    '    last_modified: 2026-05-30T00:00:00Z',
    '    usage_window: { from: 2026-05-01T00:00:00Z, to: 2026-05-31T00:00:00Z }',
    '  - id: rev-policy',
    '    resource: policies/revenue-recognition.md',
    '    author: human:jsmith@acme',
    '  - resource: all queries in BigQuery project X',
    '    usage_count: 12',
    '  - id: rel',
    '    resource: ../policies/revenue-recognition.md',
    '  - id: abs',
    '    resource: /policies/revenue-recognition.md',
    '  - id: ghost',
    '    resource: /policies/does-not-exist.md',
    'usage_window: { from: 2026-06-01T00:00:00Z, to: 2026-06-30T00:00:00Z }',
  ].join('\n');

  it('mints one okf:Source node per entry carrying the credibility signals', () => {
    const { c } = conceptOf(bundle(SOURCES));
    const s0 = node(GENID_TAGS.source, 0);
    expect(objs(c.quads, OKF_SOURCE)).toEqual([0, 1, 2, 3, 4, 5].map((i) => node(GENID_TAGS.source, i)));
    expect(objs(c.quads, RDF_TYPE, s0)).toEqual([OKF_CLASS_SOURCE]);
    expect(objs(c.quads, SCHEMA_IDENTIFIER, s0)).toEqual(['"ga4-schema"']);
    expect(objs(c.quads, SCHEMA_NAME, s0)).toEqual(['"GA4 BigQuery Export schema"']);
    expect(objs(c.quads, OKF_RESOURCE, s0)).toEqual(['https://developers.google.com/analytics/bigquery/export-schema']);
    expect(objs(c.quads, OKF_AUTHOR, s0)).toEqual(['"team:ga4-docs"']);
    expect(objs(c.quads, OKF_USAGE_COUNT, s0)).toEqual([`"5000"^^<${XSD_INTEGER}>`]);
    expect(objs(c.quads, SCHEMA_DATE_MODIFIED, s0)).toEqual([DT('2026-05-30T00:00:00Z')]);
    expect(objs(c.quads, OKF_USAGE_WINDOW_FROM, s0)).toEqual([DT('2026-05-01T00:00:00Z')]);
    expect(objs(c.quads, OKF_USAGE_WINDOW_TO, s0)).toEqual([DT('2026-05-31T00:00:00Z')]);
    // the concept-level sibling window lands on the concept
    expect(objs(c.quads, OKF_USAGE_WINDOW_FROM)).toEqual([DT('2026-06-01T00:00:00Z')]);
    expect(objs(c.quads, OKF_USAGE_WINDOW_TO)).toEqual([DT('2026-06-30T00:00:00Z')]);
    expect(c.trust.sources).toBe(6);
  });

  it('resolves bundle paths in every spelling to the concept and adds a prov:wasDerivedFrom lineage edge', () => {
    const { c } = conceptOf(bundle(SOURCES));
    const policy = 'urn:okf:policies/revenue-recognition';
    // root-relative without slash (the reference bundles' convention), file-relative, and absolute
    for (const i of [1, 3, 4]) expect(objs(c.quads, OKF_RESOURCE, node(GENID_TAGS.source, i))).toEqual([policy]);
    // derivation edges: the policy concept ONCE (three sources name it) + the external URL;
    // the scope descriptor gets none. The store holds a set, so a repeat would never verify.
    expect(objs(c.quads, PROV_WAS_DERIVED_FROM).sort()).toEqual(
      ['https://developers.google.com/analytics/bigquery/export-schema', policy].sort(),
    );
    expect(c.trust.derivedFromConcepts).toEqual(['policies/revenue-recognition']);
  });

  it('keeps a scope descriptor as a literal and warns on a .md path that resolves to nothing', () => {
    const { c, r } = conceptOf(bundle(SOURCES));
    expect(objs(c.quads, OKF_RESOURCE, node(GENID_TAGS.source, 2))).toEqual(['"all queries in BigQuery project X"']);
    expect(objs(c.quads, OKF_RESOURCE, node(GENID_TAGS.source, 5))).toEqual(['"/policies/does-not-exist.md"']);
    expect(r.warnings.some((w) => w.code === 'broken-link' && /sources\[5\]\.resource/.test(w.message))).toBe(true);
    expect(r.warnings.some((w) => w.code === 'broken-link' && /sources\[2\]/.test(w.message))).toBe(false);
  });

  it('reports an entry without resource and a non-integer usage_count (warnings only)', () => {
    const d = familyDiagnostics({ type: 'T', sources: [{ id: 'x' }, { resource: 'r', usage_count: 'many' }, 'nope'] });
    const msgs = d.map((x) => x.message).join('\n');
    expect(msgs).toMatch(/sources\[0\]\.resource` is required/);
    expect(msgs).toMatch(/sources\[1\]\.usage_count` should be an integer/);
    expect(msgs).toMatch(/sources\[2\]` is not a mapping/);
  });

  it('round-trips sources through export: concept paths come back as absolute bundle paths, literals verbatim', () => {
    const fm = exportedFrontmatter(bundle(SOURCES));
    expect(fm.sources).toEqual([
      {
        id: 'ga4-schema',
        resource: 'https://developers.google.com/analytics/bigquery/export-schema',
        title: 'GA4 BigQuery Export schema',
        author: 'team:ga4-docs',
        usage_count: 5000,
        last_modified: '2026-05-30T00:00:00Z',
        usage_window: { from: '2026-05-01T00:00:00Z', to: '2026-05-31T00:00:00Z' },
      },
      { id: 'rev-policy', resource: '/policies/revenue-recognition.md', author: 'human:jsmith@acme' },
      { resource: 'all queries in BigQuery project X', usage_count: 12 },
      { id: 'rel', resource: '/policies/revenue-recognition.md' },
      { id: 'abs', resource: '/policies/revenue-recognition.md' },
      { id: 'ghost', resource: '/policies/does-not-exist.md' },
    ]);
    expect(fm.usage_window).toEqual({ from: '2026-06-01T00:00:00Z', to: '2026-06-30T00:00:00Z' });
  });

  it('per-claim footnotes must join a sources[].id (§5.1); v0.1-style footnotes are left alone', () => {
    const body = 'Sharded daily.[^ga4-schema] Also see this.[^missing]\n\n[^ga4-schema]: GA4 schema\n[^missing]: nothing\n';
    expect(parseBody(body).footnoteRefs).toEqual(['ga4-schema', 'missing']);
    const { r } = conceptOf(bundle('type: Metric\nsources:\n  - id: ga4-schema\n    resource: https://x.example/s', body));
    const fn = r.warnings.filter((w) => w.code === 'unknown-footnote');
    expect(fn.map((w) => w.message)).toEqual(['footnote [^missing] does not match any sources[].id (§5.1 per-claim attribution)']);
    const noSources = conceptOf(bundle('type: Metric', body)).r;
    expect(noSources.warnings.some((w) => w.code === 'unknown-footnote')).toBe(false);
  });
});

describe('§6.2 a source path names one concept, and keeps naming it through a round trip', () => {
  const metric = { path: 'metrics/revenue.md', content: '---\ntype: Metric\nsources: [{ id: s, resource: policies/p.md }]\n---\n\nbody\n' };
  const LOCAL = { path: 'metrics/policies/p.md', content: '---\ntype: Policy\ntitle: Local\n---\n\nbody\n' };
  const ROOT = { path: 'policies/p.md', content: '---\ntype: Policy\ntitle: Root\n---\n\nbody\n' };
  const lineage = (r: ReturnType<typeof importBundle>) => {
    const c = r.concepts.find((x) => x.conceptId === 'metrics/revenue')!;
    return {
      resource: objs(c.quads, OKF_RESOURCE, node(GENID_TAGS.source, 0)),
      derivedFrom: objs(c.quads, PROV_WAS_DERIVED_FROM),
      concepts: c.trust.derivedFromConcepts,
    };
  };
  const named = (id: string) => ({ resource: [`urn:okf:${id}`], derivedFrom: [`urn:okf:${id}`], concepts: [id] });

  it('picks the file-relative concept when both readings exist (§6.2)', () => {
    const first = importBundle([IDX_V02(), metric, LOCAL, ROOT]);
    expect(lineage(first)).toEqual(named('metrics/policies/p'));
    expect(lineage(importBundle(exportBundle(first)))).toEqual(named('metrics/policies/p'));
  });

  it('falls back to the bundle-root concept when there is no file-relative one', () => {
    const first = importBundle([IDX_V02(), metric, ROOT]);
    expect(lineage(first)).toEqual(named('policies/p'));
    expect(lineage(importBundle(exportBundle(first)))).toEqual(named('policies/p'));
  });

  it("counts a concept's own absolute IRI as that concept, and keeps every other IRI external", () => {
    const files = [
      IDX_V02(),
      { path: 'a.md', content: '---\ntype: Metric\nsources:\n  - { id: p, resource: urn:okf:p }\n  - { id: m, resource: urn:okf:missing }\n  - { id: x, resource: https://x.example/doc }\n---\n\nbody\n' },
      { path: 'p.md', content: '---\ntype: Policy\n---\n\nbody\n' },
    ];
    const first = importBundle(files);
    for (const r of [first, importBundle(exportBundle(first))]) {
      const a = r.concepts.find((c) => c.conceptId === 'a')!;
      expect(a.trust.derivedFromConcepts).toEqual(['p']);
      expect(objs(a.quads, PROV_WAS_DERIVED_FROM, a.iri).sort()).toEqual(['https://x.example/doc', 'urn:okf:missing', 'urn:okf:p']);
    }
  });
});

describe('§10 attested computations', () => {
  const AC = [
    'type: Attested Computation',
    'title: Revenue for fiscal year',
    'runtime: bigquery',
    'parameters:',
    '  - { name: year, type: integer, required: true }',
    '  - { name: segment, type: string, required: false, default: all }',
    'computation: references/computations/lib/revenue.sql',
    'executor:',
    '  resource: /policies/revenue-recognition.md',
    '  receipt: [job_id, executed_sql, result]',
    '  timeout_s: 30',
    'attester:',
    '  resource: references/attesters/sql-equality.py',
    '  strict: true',
  ].join('\n');

  it('maps the contract: runtime, ordered parameter nodes, computation, executor, attester', () => {
    const { c } = conceptOf(bundle(AC));
    expect(objs(c.quads, OKF_RUNTIME)).toEqual(['"bigquery"']);
    const p0 = node(GENID_TAGS.parameter, 0);
    const p1 = node(GENID_TAGS.parameter, 1);
    expect(objs(c.quads, OKF_PARAMETER)).toEqual([p0, p1]);
    expect(objs(c.quads, RDF_TYPE, p0)).toEqual([OKF_CLASS_PARAMETER]);
    expect(objs(c.quads, SCHEMA_NAME, p0)).toEqual(['"year"']);
    expect(objs(c.quads, OKF_PARAMETER_TYPE, p0)).toEqual(['"integer"']);
    expect(objs(c.quads, OKF_REQUIRED, p0)).toEqual([`"true"^^<${XSD_BOOLEAN}>`]);
    expect(objs(c.quads, okfExtensionPredicate('parameters', 'default'), p1)).toEqual(['"all"']);
    expect(objs(c.quads, OKF_COMPUTATION)).toEqual(['"references/computations/lib/revenue.sql"']);
    // a bundle concept named by executor.resource becomes a typed edge
    expect(objs(c.quads, OKF_EXECUTOR_RESOURCE)).toEqual(['urn:okf:policies/revenue-recognition']);
    expect(objs(c.quads, OKF_EXECUTOR_RECEIPT).sort()).toEqual(['"executed_sql"', '"job_id"', '"result"']);
    expect(objs(c.quads, OKF_NS + 'executor.timeout_s')).toEqual([`"30"^^<${XSD_INTEGER}>`]);
    expect(objs(c.quads, OKF_ATTESTER_RESOURCE)).toEqual(['"references/attesters/sql-equality.py"']);
    expect(objs(c.quads, OKF_NS + 'attester.strict')).toEqual([`"true"^^<${XSD_BOOLEAN}>`]);
    expect(c.trust.attestedComputation).toBe(true);
  });

  it('round-trips the contract through export, restoring the spec type spelling', () => {
    const fm = exportedFrontmatter(bundle(AC));
    expect(fm.type).toBe('Attested Computation');
    expect(fm.runtime).toBe('bigquery');
    expect(fm.parameters).toEqual([
      { name: 'year', type: 'integer', required: true },
      { name: 'segment', type: 'string', required: false, default: 'all' },
    ]);
    expect(fm.computation).toBe('references/computations/lib/revenue.sql');
    expect(fm.executor).toEqual({
      resource: '/policies/revenue-recognition.md',
      receipt: ['executed_sql', 'job_id', 'result'], // set semantics: sorted
      timeout_s: 30, // the extension key comes back exactly, not camelCased
    });
    expect(fm.attester).toEqual({ resource: 'references/attesters/sql-equality.py', strict: true });
    expect(summarizeTrust(fm).attestedComputation).toBe(true);
  });

  it('reports a missing runtime and malformed parameters / executor / attester, never rejecting', () => {
    const files = bundle('type: Attested Computation\nparameters: year\nexecutor: run-it\nattester: [a]');
    const report = validateBundle(files);
    expect(report.conformant).toBe(true);
    const msgs = report.warnings.join('\n');
    expect(msgs).toMatch(/`runtime` is required for an `Attested Computation`/);
    expect(msgs).toMatch(/`parameters` must be a list/);
    expect(msgs).toMatch(/`executor` must be a mapping/);
    expect(msgs).toMatch(/`attester` must be a mapping/);
    const d = familyDiagnostics({ type: 'Attested Computation', runtime: 'bigquery', parameters: [{ type: 'integer' }, 'x'] });
    expect(d.map((x) => x.message).join('\n')).toMatch(/parameters\[0\]\.name` is missing/);
    expect(d.map((x) => x.message).join('\n')).toMatch(/parameters\[1\]` is not a mapping/);
    // the malformed shapes are kept verbatim under the generic predicate, whole:
    // a single value as its own term, a list as one rdf:JSON literal
    const { c } = conceptOf(files);
    expect(objs(c.quads, SCHEMA_NS + 'parameters')).toEqual(['"year"']);
    expect(objs(c.quads, SCHEMA_NS + 'executor')).toEqual(['"run-it"']);
    expect(objs(c.quads, SCHEMA_NS + 'attester')).toEqual([`"[\\"a\\"]"^^<${RDF_JSON}>`]);
  });

  it('warns on a computation path that looks like a concept but is missing', () => {
    const { r } = conceptOf(bundle('type: Attested Computation\nruntime: dbt\ncomputation: /computations/missing.md'));
    expect(r.warnings.some((w) => w.code === 'broken-link' && /computation "\/computations\/missing\.md"/.test(w.message))).toBe(true);
  });
});

describe('family extensions (SPEC §4.1) are preserved invertibly', () => {
  const WINDOWS = [
    'type: Metric',
    'usage_window: { from: 2026-04-01T00:00:00Z, to: 2026-06-30T00:00:00Z, population: production-only }',
    'sources:',
    '  - id: dash',
    '    resource: https://x.example/dash',
    '    usage_window: { from: 2026-05-01T00:00:00Z, to: 2026-05-31T00:00:00Z, population: prod, sample_rate: 0.1 }',
  ].join('\n');

  it('keeps usage_window extensions at concept and source level', () => {
    const { c } = conceptOf(bundle(WINDOWS));
    const s0 = node(GENID_TAGS.source, 0);
    expect(objs(c.quads, okfExtensionPredicate('usage_window', 'population'))).toEqual(['"production-only"']);
    expect(objs(c.quads, okfExtensionPredicate('usage_window', 'population'), s0)).toEqual(['"prod"']);
    expect(objs(c.quads, okfExtensionPredicate('usage_window', 'sample_rate'), s0)).toEqual(['"0.1"^^<http://www.w3.org/2001/XMLSchema#decimal>']);
    expect(objs(c.quads, OKF_USAGE_WINDOW_FROM, s0)).toEqual([DT('2026-05-01T00:00:00Z')]);
  });

  it('round-trips the extensions through export and re-import', () => {
    const files = bundle(WINDOWS);
    const fm = exportedFrontmatter(files);
    expect(fm.usage_window).toEqual({ from: '2026-04-01T00:00:00Z', to: '2026-06-30T00:00:00Z', population: 'production-only' });
    expect((fm.sources as Array<Record<string, unknown>>)[0].usage_window).toEqual({
      from: '2026-05-01T00:00:00Z',
      to: '2026-05-31T00:00:00Z',
      population: 'prod',
      sample_rate: 0.1,
    });
    const first = conceptOf(files).c;
    const second = importBundle(exportBundle(importBundle(files))).concepts.find((x) => x.conceptId === 'metrics/revenue')!;
    expect(quadsToNQuads(second.quads.filter((q) => !q.subject.includes(GENID_TAGS.section)))).toBe(
      quadsToNQuads(first.quads.filter((q) => !q.subject.includes(GENID_TAGS.section))),
    );
  });

  it('encodes any key to an IRI-safe predicate and decodes it back exactly', () => {
    for (const key of ['population', 'sample rate', 'retry_count', 'café', 'a.b', '50%', '日本語']) {
      const predicate = okfExtensionPredicate('executor', key);
      expect(isSafeIri(predicate)).toBe(true);
      expect(okfExtensionKey('executor', predicate)).toBe(key);
      expect(okfExtensionKey('attester', predicate)).toBeNull();
    }
    expect(okfExtensionKey('generated', OKF_NS + 'generatedBy')).toBeNull();
    // a malformed percent sequence (hand-edited graph) is returned undecoded, never thrown
    expect(okfExtensionKey('executor', OKF_NS + 'executor.%E0%A4%A')).toBe('%E0%A4%A');
  });

  it('round-trips keys with spaces, underscores and non-ASCII characters exactly', () => {
    const files = bundle(
      "type: Metric\ngenerated: { by: human:a, 'sample rate': 0.5, run_id: r1, 'café': ja }\nexecutor: { resource: https://x.example/run, retry_count: 2 }\nverified:\n  - { by: human:a, 'review note': ok, ticket_id: T-1 }",
    );
    const { c } = conceptOf(files);
    for (const q of c.quads) expect(isSafeIri(q.predicate)).toBe(true);
    const fm = exportedFrontmatter(files);
    expect(fm.generated).toEqual({ by: 'human:a', 'sample rate': 0.5, run_id: 'r1', café: 'ja' });
    expect(fm.executor).toEqual({ resource: 'https://x.example/run', retry_count: 2 });
    expect(fm.verified).toEqual([{ by: 'human:a', 'review note': 'ok', ticket_id: 'T-1' }]);
  });
});

describe('an empty list in a family extension is a value, not an absence', () => {
  it('keeps a parameter default of [] and an executor extension of [] through a round trip', () => {
    const files = bundle(
      'type: Attested Computation\nruntime: bigquery\nparameters:\n  - { name: regions, type: array, required: false, default: [] }\nexecutor: { resource: https://x.example/run, retries: [] }',
    );
    const { c } = conceptOf(files);
    const empty = `"[]"^^<${RDF_JSON}>`;
    expect(objs(c.quads, okfExtensionPredicate('parameters', 'default'), node(GENID_TAGS.parameter, 0))).toEqual([empty]);
    expect(objs(c.quads, okfExtensionPredicate('executor', 'retries'))).toEqual([empty]);
    const fm = exportedFrontmatter(files);
    expect((fm.parameters as Array<Record<string, unknown>>)[0]).toEqual({ name: 'regions', type: 'array', required: false, default: [] });
    expect((fm.executor as Record<string, unknown>).retries).toEqual([]);
    expect(semantic(conceptOf(exportBundle(importBundle(files))).c.quads)).toBe(semantic(c.quads));
  });
});

describe('export restores family entry order from the node IRIs, whatever order quads arrive in', () => {
  // The CLI rebuilds concepts from a SPARQL SELECT with no ORDER BY, so node and
  // link quads can arrive in any order. Export must restore the entry order
  // from the index baked into each node IRI, not rely on input order.
  const ORDERED = [
    'type: Attested Computation',
    'runtime: bigquery',
    'parameters:',
    '  - { name: p0, type: integer, required: true }',
    '  - { name: p1, type: string, required: false }',
    '  - { name: p2, type: date, required: true }',
    'verified:',
    '  - { by: human:first, at: 2026-06-25T09:00:00Z }',
    '  - { by: process:second, at: 2026-06-26T02:00:00Z }',
    '  - { by: reference_agent/third, at: 2026-06-27T02:00:00Z }',
    'sources:',
    '  - { id: s0, resource: https://x.example/0 }',
    '  - { id: s1, resource: https://x.example/1 }',
    '  - { id: s2, resource: https://x.example/2 }',
  ].join('\n');

  /** Deterministic Fisher–Yates with a small LCG, so the test is reproducible. */
  function shuffled<T>(items: T[], seed: number): T[] {
    const out = [...items];
    let x = seed;
    for (let i = out.length - 1; i > 0; i--) {
      x = (x * 1103515245 + 12345) % 2147483648;
      const j = x % (i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  const imported = importBundle(bundle(ORDERED));
  const concept = imported.concepts.find((x) => x.conceptId === 'metrics/revenue')!;
  const exportWith = (quads: Quad[]) => {
    const files = exportBundle({ concepts: imported.concepts.map((x) => (x === concept ? { ...x, quads } : x)) });
    return parseDocument('metrics/revenue.md', files.find((f) => f.path === 'metrics/revenue.md')!.content).frontmatter;
  };
  const expectOriginalOrder = (fm: Record<string, unknown>) => {
    expect((fm.parameters as Array<{ name: string }>).map((p) => p.name)).toEqual(['p0', 'p1', 'p2']);
    expect((fm.verified as Array<{ by: string }>).map((v) => v.by)).toEqual(['human:first', 'process:second', 'reference_agent/third']);
    expect((fm.sources as Array<{ id: string }>).map((s) => s.id)).toEqual(['s0', 's1', 's2']);
  };

  it('restores the order from reversed quads', () => {
    expectOriginalOrder(exportWith([...concept.quads].reverse()));
  });

  it('restores the order from shuffled quads', () => {
    for (const seed of [7, 42, 1234]) {
      const quads = shuffled(concept.quads, seed);
      // the permutation really does scramble at least one family's link order
      const linkOrder = quads.filter((q) => q.predicate === OKF_SOURCE || q.predicate === OKF_VERIFICATION || q.predicate === OKF_PARAMETER);
      expect(linkOrder.map((q) => q.object)).not.toEqual(
        concept.quads.filter((q) => linkOrder.includes(q)).map((q) => q.object),
      );
      expectOriginalOrder(exportWith(quads));
    }
  });
});

describe('one verification boundary: RDF, summary and diagnostics agree on which entry is which', () => {
  it('numbers a valid verifier that follows an invalid entry as the first node', () => {
    const { c, r } = conceptOf(bundle('type: Metric\nverified:\n  - { at: 2026-06-26T02:00:00Z }\n  - { by: human:a, at: 2026-06-27T02:00:00Z }'));
    // the RDF: one Verification node, numbered 0 — its position among the
    // usable entries, which is what export writes back and re-import reads
    expect(objs(c.quads, OKF_VERIFICATION)).toEqual([node(GENID_TAGS.verification, 0)]);
    expect(objs(c.quads, OKF_VERIFIED_BY, node(GENID_TAGS.verification, 0))).toEqual(['"human:a"']);
    expect(objs(c.quads, OKF_TRUST_TIER)).toEqual(['"human-reviewed"']);
    // the summary counts the same single event
    expect(c.trust).toMatchObject({ tier: 'human-reviewed', verifications: 1 });
    // the diagnostics name the skipped entry by its position as written
    expect(r.warnings.map((w) => w.message)).toContain('`verified[0].by` is missing (§5.2); the event cannot name a verifier and is skipped');
    // and export writes back only the usable event
    expect(exportedFrontmatter(bundle('type: Metric\nverified:\n  - { at: 2026-06-26T02:00:00Z }\n  - { by: human:a, at: 2026-06-27T02:00:00Z }')).verified).toEqual([
      { by: 'human:a', at: '2026-06-27T02:00:00Z' },
    ]);
  });
});

describe('family definitions drive both directions', () => {
  // One sample value per family, covering every field kind. Encoding with
  // familyQuads and decoding with decodeFamilies must give the value back.
  const SAMPLES: Record<string, unknown> = {
    generated: { by: 'human:a', at: '2026-06-30T14:00:00Z', model: 'm' },
    verified: [{ by: 'process:p', at: '2026-06-25T09:00:00Z' }, { by: 'human:h', at: '2026-06-26T09:00:00Z', note: 'ok' }],
    status: 'deprecated',
    stale_after: '2026-12-31T00:00:00Z',
    sources: [
      {
        id: 's',
        resource: 'https://x.example/s',
        title: 'S',
        author: 'team:t',
        usage_count: 5,
        last_modified: '2026-05-30T00:00:00Z',
        usage_window: { from: '2026-05-01T00:00:00Z', to: '2026-05-31T00:00:00Z', population: 'prod' },
        credibility_note: 'n',
      },
    ],
    usage_window: { from: '2026-06-01T00:00:00Z', to: '2026-06-30T00:00:00Z', population: 'all' },
    runtime: 'bigquery',
    parameters: [{ name: 'year', type: 'integer', required: true, default: 2026 }],
    computation: 'references/sql/revenue.sql',
    executor: { resource: 'https://x.example/run', receipt: ['executed_sql', 'job_id'], timeout_s: 30 },
    attester: { resource: 'https://x.example/attest.py', strict: true },
  };
  const ctx = { conceptId: 'm', iriBase: 'urn:okf:', conceptExists: () => false };
  const decodeCtx = { iriBase: 'urn:okf:', conceptIris: new Set(['urn:okf:m']) };

  it('declares every v0.2 family exactly once', () => {
    expect(FAMILY_SPECS.map((s) => s.key).sort()).toEqual([...V02_FAMILY_KEYS].sort());
    expect(Object.keys(SAMPLES).sort()).toEqual([...V02_FAMILY_KEYS].sort());
    for (const spec of FAMILY_SPECS) {
      if (spec.shape === 'scalar') continue;
      const predicates = spec.fields.map((f) => f.predicate);
      expect(new Set(predicates).size).toBe(predicates.length);
      expect(FAMILY_BY_KEY.get(spec.key)).toBe(spec);
    }
  });

  for (const key of Object.keys(SAMPLES)) {
    it(`round-trips the ${key} family through its definition`, () => {
      const quads = familyQuads('urn:okf:m', key, SAMPLES[key], ctx).quads;
      const bySubject = new Map<string, Quad[]>();
      for (const q of quads) bySubject.set(q.subject, [...(bySubject.get(q.subject) ?? []), q]);
      const conceptQuads = bySubject.get('urn:okf:m') ?? [];
      const decoded = decodeFamilies(conceptQuads, (n) => bySubject.get(n) ?? [], decodeCtx);
      expect(decoded.frontmatter[key]).toEqual(SAMPLES[key]);
      // It owns every concept quad of the family but the derived ones, so the
      // exporter reads none of them as a producer key.
      const derived = new Set([OKF_TRUST_TIER, PROV_WAS_DERIVED_FROM]);
      expect(conceptQuads.filter((q) => !decoded.consumed.has(q) && !derived.has(q.predicate))).toEqual([]);
    });
  }
});

describe('the family decoder owns what the encoder keeps for a family', () => {
  const decodeCtx = { iriBase: 'urn:okf:', conceptIris: new Set(['urn:okf:metrics/revenue']) };
  const conceptQuads = (yaml: string) => {
    const { c } = conceptOf(bundle(`type: Metric\n${yaml}`));
    return c.quads.filter((q) => q.subject === c.iri);
  };
  const usageWindow = SCHEMA_NS + 'usageWindow';

  it('reads a list kept verbatim back under the family key and consumes it', () => {
    const quads = conceptQuads('usage_window: [{ from: 2026-06-01T00:00:00Z }]');
    const decoded = decodeFamilies(quads, () => [], decodeCtx);
    expect(decoded.frontmatter.usage_window).toEqual([{ from: '2026-06-01T00:00:00Z' }]);
    expect(quads.filter((q) => q.predicate === usageWindow).every((q) => decoded.consumed.has(q))).toBe(true);
  });

  it('leaves a single value on the same predicate to the exporter, as the producer key it also is', () => {
    for (const yaml of ['usage_window: Q2', 'usageWindow: Q2']) {
      const quads = conceptQuads(yaml);
      const decoded = decodeFamilies(quads, () => [], decodeCtx);
      expect('usage_window' in decoded.frontmatter).toBe(false);
      expect(quads.some((q) => q.predicate === usageWindow && decoded.consumed.has(q))).toBe(false);
    }
  });

  it('reads a lone generated.at back as the legacy timestamp and consumes it', () => {
    const quads = conceptQuads('generated: { at: 2026-06-30T00:00:00Z }');
    const decoded = decodeFamilies(quads, () => [], decodeCtx);
    expect(decoded.frontmatter).toEqual({ timestamp: '2026-06-30T00:00:00Z' });
    expect(quads.filter((q) => q.predicate === SCHEMA_DATE_MODIFIED).every((q) => decoded.consumed.has(q))).toBe(true);
  });
});

describe('a nested family of the wrong shape is kept through export', () => {
  const SCALAR_WINDOW = 'type: Metric\nsources:\n  - { resource: https://example.org/source, usage_window: last-quarter }';

  it('writes the per-source usage_window back verbatim and keeps the warning on re-import', () => {
    const fm = exportedFrontmatter(bundle(SCALAR_WINDOW));
    expect(fm.sources).toEqual([{ resource: 'https://example.org/source', usage_window: 'last-quarter' }]);
    const second = importBundle(exportBundle(importBundle(bundle(SCALAR_WINDOW))));
    expect(second.warnings.map((w) => w.message)).toContain('`sources[0].usage_window` must be a `{ from, to }` mapping (§5.1); preserved verbatim');
    const node0 = node(GENID_TAGS.source, 0);
    expect(objs(second.concepts.find((c) => c.conceptId === 'metrics/revenue')!.quads, SCHEMA_NS + 'usageWindow', node0)).toEqual(['"last-quarter"']);
  });
});

describe('family definitions are internal and carry their behaviour as data', () => {
  it('keeps the definitions and codec out of the public API', () => {
    for (const name of ['FAMILY_SPECS', 'FAMILY_BY_KEY', 'VERIFIED', 'SOURCES', 'prepareFamily', 'resolveReferences', 'decodeFamilies', 'parseList', 'prepareConcept', 'resolveConcept']) {
      expect(Object.prototype.hasOwnProperty.call(okfPublic, name)).toBe(false);
    }
    for (const name of ['familyQuads', 'familyDiagnostics', 'parseVerified', 'exportInputFromQuads', 'V02_FAMILY_KEYS', 'dateTimeLexical', 'isXsdDateTime', 'isXsdDate', 'hasExplicitOffset']) {
      expect(Object.prototype.hasOwnProperty.call(okfPublic, name)).toBe(true);
    }
  });

  it('does not depend on which definition object it is handed', () => {
    const ctx = { conceptId: 'm', iriBase: 'urn:okf:', conceptExists: () => false };
    const value = [{ by: 'human:a', at: '2026-06-25T09:00:00Z' }];
    const canonical = resolveReferences('urn:okf:m', prepareFamily('urn:okf:m', 'm', VERIFIED, value), ctx);
    const copy = resolveReferences('urn:okf:m', prepareFamily('urn:okf:m', 'm', { ...VERIFIED }, value), ctx);
    expect(quadsToNQuads(copy.quads)).toBe(quadsToNQuads(canonical.quads));
    expect(copy.quads.some((q) => q.predicate === OKF_TRUST_TIER)).toBe(true);
  });
});
