import { describe, it, expect } from 'vitest';
import { load as loadYaml } from 'js-yaml';
import {
  importBundle,
  exportBundle,
  validateBundle,
  frontmatterQuads,
  mapFrontmatter,
  parseDocument,
  parseBody,
  familyDiagnostics,
  summarizeTrust,
  quadsToNQuads,
  RDF_TYPE,
  RDF_JSON,
  SCHEMA_DATE_MODIFIED,
  SCHEMA_NS,
  SCHEMA_IDENTIFIER,
  SCHEMA_NAME,
  PROV_WAS_DERIVED_FROM,
  OKF_NS,
  OKF_GENERATED_BY,
  OKF_VERIFICATION,
  OKF_VERIFIED_BY,
  OKF_VERIFIED_AT,
  OKF_TRUST_TIER,
  OKF_STATUS,
  SCHEMA_URL,
  SCHEMA_IS_PART_OF,
  OKF_STALE_AFTER,
  OKF_SOURCE,
  OKF_RESOURCE,
  OKF_AUTHOR,
  OKF_USAGE_COUNT,
  OKF_USAGE_WINDOW_FROM,
  OKF_USAGE_WINDOW_TO,
  OKF_RUNTIME,
  OKF_PARAMETER,
  OKF_PARAMETER_TYPE,
  OKF_REQUIRED,
  OKF_COMPUTATION,
  OKF_EXECUTOR_RESOURCE,
  OKF_EXECUTOR_RECEIPT,
  OKF_ATTESTER_RESOURCE,
  OKF_CLASS_VERIFICATION,
  OKF_CLASS_SOURCE,
  OKF_CLASS_PARAMETER,
  SECTION_GENID_INFIX,
  GENID_TAGS,
  XSD_DATE_TIME,
  XSD_INTEGER,
  XSD_BOOLEAN,
  okfExtensionPredicate,
  okfExtensionKey,
  isSafeIri,
  exportInputFromQuads,
  familyQuads,
  V02_FAMILY_KEYS,
  DKG_HAS_SECTION,
} from '../src/index.js';
import * as okfPublic from '../src/index.js';
import { decodeFamilies, encodeFamily, FAMILY_SPECS, FAMILY_BY_KEY, VERIFIED } from '../src/families/index.js';
import type { BundleFile, Quad } from '../src/index.js';
import { loadBundleDir } from '../src/index.js';
import { fileURLToPath } from 'node:url';

const IRI = 'urn:okf:metrics/revenue';
const DT = (lex: string) => `"${lex}"^^<${XSD_DATE_TIME}>`;
const objs = (quads: Quad[], predicate: string, subject = IRI) =>
  quads.filter((q) => q.subject === subject && q.predicate === predicate).map((q) => q.object);
const node = (tag: string, i: number) => `${IRI}${SECTION_GENID_INFIX}${tag}metrics_revenue_${i}`;

const IDX_V02 = (): BundleFile => ({ path: 'index.md', content: '---\nokf_version: "0.2"\n---\n\n# Root\n' });

/** A two-concept bundle: the subject under test plus a policy it can derive from. */
function bundle(frontmatterYaml: string, body = 'body\n'): BundleFile[] {
  return [
    { path: 'index.md', content: '---\nokf_version: "0.2"\n---\n\n# Root\n' },
    { path: 'metrics/revenue.md', content: `---\n${frontmatterYaml}\n---\n\n${body}` },
    { path: 'policies/revenue-recognition.md', content: '---\ntype: Policy\ntitle: Rev rec\n---\n\nbody\n' },
  ];
}
function conceptOf(files: BundleFile[], id = 'metrics/revenue') {
  const r = importBundle(files);
  const c = r.concepts.find((x) => x.conceptId === id)!;
  return { r, c };
}
function exportedFrontmatter(files: BundleFile[], path = 'metrics/revenue.md'): Record<string, unknown> {
  const exported = exportBundle(importBundle(files));
  const file = exported.find((f) => f.path === path)!;
  return parseDocument(path, file.content).frontmatter;
}

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
    // the malformed shapes are preserved as producer keys rather than dropped
    const { c } = conceptOf(files);
    expect(objs(c.quads, SCHEMA_NS + 'parameters')).toEqual(['"year"']);
    expect(objs(c.quads, SCHEMA_NS + 'executor')).toEqual(['"run-it"']);
    expect(objs(c.quads, SCHEMA_NS + 'attester')).toEqual(['"a"']);
  });

  it('warns on a computation path that looks like a concept but is missing', () => {
    const { r } = conceptOf(bundle('type: Attested Computation\nruntime: dbt\ncomputation: /computations/missing.md'));
    expect(r.warnings.some((w) => w.code === 'broken-link' && /computation "\/computations\/missing\.md"/.test(w.message))).toBe(true);
  });
});

describe('export only rewrites IRIs that are exported concepts', () => {
  // With a custom iriBase the namespace alone does not identify a concept:
  // an external https://example.org/docs/external must survive verbatim.
  const BASE = 'https://example.org/';
  const files: BundleFile[] = [
    { path: 'index.md', content: '---\nokf_version: "0.2"\n---\n\n# Root\n' },
    {
      path: 'metric.md',
      content: [
        '---',
        'type: Attested Computation',
        'runtime: bigquery',
        'computation: https://example.org/sql/revenue.sql',
        'executor: { resource: https://example.org/skills/run.md }',
        'attester: { resource: /policy.md }',
        'sources:',
        '  - { id: ext, resource: https://example.org/docs/external }',
        '  - { id: pol, resource: /policy.md }',
        '---',
        '',
        'body',
        '',
      ].join('\n'),
    },
    { path: 'policy.md', content: '---\ntype: Policy\n---\n\nbody\n' },
  ];

  it('keeps external IRIs under the namespace verbatim and writes real concepts as bundle paths', () => {
    const first = importBundle(files, { iriBase: BASE });
    const exported = exportBundle(first, { iriBase: BASE });
    const fm = parseDocument('metric.md', exported.find((f) => f.path === 'metric.md')!.content).frontmatter;
    expect(fm.sources).toEqual([
      { id: 'ext', resource: 'https://example.org/docs/external' },
      { id: 'pol', resource: '/policy.md' },
    ]);
    expect(fm.computation).toBe('https://example.org/sql/revenue.sql');
    expect(fm.executor).toEqual({ resource: 'https://example.org/skills/run.md' });
    expect(fm.attester).toEqual({ resource: '/policy.md' });
  });

  it('round-trips graph-equal, lineage edges included', () => {
    const first = importBundle(files, { iriBase: BASE });
    const second = importBundle(exportBundle(first, { iriBase: BASE }), { iriBase: BASE });
    const metric = (r: typeof first) => r.concepts.find((c) => c.conceptId === 'metric')!;
    expect(objs(metric(first).quads, PROV_WAS_DERIVED_FROM, BASE + 'metric').sort()).toEqual([
      'https://example.org/docs/external',
      'https://example.org/policy',
    ]);
    expect(quadsToNQuads(metric(second).quads)).toBe(quadsToNQuads(metric(first).quads));
  });
});

describe('each triple is emitted once (an RDF store holds a set)', () => {
  const REPEATED = [
    'type: Metric',
    'tags: [finance, revenue, finance]',
    'sources:',
    '  - { id: a, resource: /policies/revenue-recognition.md }',
    '  - { id: b, resource: policies/revenue-recognition.md }',
    '  - { id: c, resource: https://x.example/doc }',
    '  - { id: d, resource: https://x.example/doc }',
  ].join('\n');

  it('keeps one Source node per entry but one lineage edge per distinct resource', () => {
    const { c } = conceptOf(bundle(REPEATED));
    expect(objs(c.quads, OKF_SOURCE)).toHaveLength(4);
    expect(objs(c.quads, PROV_WAS_DERIVED_FROM).sort()).toEqual(['https://x.example/doc', 'urn:okf:policies/revenue-recognition']);
    expect(objs(c.quads, SCHEMA_NS + 'keywords')).toEqual(['"finance"', '"revenue"']);
  });

  it('never emits a duplicate quad, so the mapped count is the count the store holds', () => {
    const r = importBundle(bundle(REPEATED));
    for (const concept of r.concepts) {
      const distinct = new Set(quadsToNQuads(concept.quads).split('\n').filter(Boolean));
      expect(concept.quads).toHaveLength(distinct.size);
    }
    expect(r.quads).toHaveLength(new Set(quadsToNQuads(r.quads).split('\n').filter(Boolean)).size);
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
  it('keeps the node index of a valid verifier that follows an invalid entry', () => {
    const { c, r } = conceptOf(bundle('type: Metric\nverified:\n  - { at: 2026-06-26T02:00:00Z }\n  - { by: human:a, at: 2026-06-27T02:00:00Z }'));
    // the RDF: one Verification node, at index 1 — the entry's position in the list
    expect(objs(c.quads, OKF_VERIFICATION)).toEqual([node(GENID_TAGS.verification, 1)]);
    expect(objs(c.quads, OKF_VERIFIED_BY, node(GENID_TAGS.verification, 1))).toEqual(['"human:a"']);
    expect(objs(c.quads, OKF_TRUST_TIER)).toEqual(['"human-reviewed"']);
    // the summary counts the same single event
    expect(c.trust).toMatchObject({ tier: 'human-reviewed', verifications: 1 });
    // the diagnostics name the skipped entry by the same index
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
      const decoded = decodeFamilies(bySubject.get('urn:okf:m') ?? [], (n) => bySubject.get(n) ?? [], decodeCtx);
      expect(decoded[key]).toEqual(SAMPLES[key]);
    });
  }
});

describe('exportInputFromQuads: the package rebuilds concepts from a graph in any order', () => {
  const BASE = 'https://example.org/';
  const files: BundleFile[] = [
    IDX_V02(),
    {
      path: 'a.md',
      content: '---\ntype: Metric\nverified:\n  - { by: human:a }\n  - { by: process:b }\nsources:\n  - { id: s0, resource: /b.md }\n---\n\n# Notes\n\nbody\n',
    },
    { path: 'b.md', content: '---\ntype: Attested Computation\nruntime: dbt\nparameters:\n  - { name: year }\n  - { name: region }\n---\n\nbody\n' },
  ];
  const imported = importBundle(files, { iriBase: BASE });
  const sectionNode = '/.well-known/genid/' + GENID_TAGS.section;
  const semantic = (quads: Quad[]) =>
    quadsToNQuads(quads.filter((q) => !q.subject.includes(sectionNode) && q.predicate !== DKG_HAS_SECTION));

  it('selects typed roots under the base and attaches every node to its owner', () => {
    const noise: Quad[] = [
      { subject: `${BASE}untyped`, predicate: SCHEMA_NAME, object: '"no rdf:type"' },
      { subject: 'urn:elsewhere:x', predicate: RDF_TYPE, object: 'http://schema.org/Thing' },
    ];
    const input = exportInputFromQuads([...noise, ...[...imported.quads].reverse()], { iriBase: BASE });
    expect(input.concepts.map((c) => c.conceptId).sort()).toEqual(['a', 'b']);
    for (const c of input.concepts) {
      expect(c.iri).toBe(BASE + c.conceptId);
      for (const q of c.quads) expect(q.subject === c.iri || q.subject.startsWith(`${c.iri}/.well-known/genid/`)).toBe(true);
    }
    const a = input.concepts.find((c) => c.conceptId === 'a')!;
    expect(a.quads.some((q) => q.subject.includes(GENID_TAGS.verification))).toBe(true);
    expect(a.quads.some((q) => q.subject.includes(GENID_TAGS.parameter))).toBe(false);
  });

  it('round-trips the semantic graph from shuffled quads under a custom base', () => {
    let x = 99;
    const shuffledQuads = [...imported.quads];
    for (let i = shuffledQuads.length - 1; i > 0; i--) {
      x = (x * 1103515245 + 12345) % 2147483648;
      const j = x % (i + 1);
      [shuffledQuads[i], shuffledQuads[j]] = [shuffledQuads[j], shuffledQuads[i]];
    }
    const exported = exportBundle(exportInputFromQuads(shuffledQuads, { iriBase: BASE }), { iriBase: BASE });
    expect(exported.some((f) => f.path.includes('.well-known'))).toBe(false);
    expect(semantic(importBundle(exported, { iriBase: BASE }).quads)).toBe(semantic(imported.quads));
  });
});

describe('arbitrary producer keys, prototype names included', () => {
  // `key in obj` is true for inherited names, and plain assignment of
  // `__proto__` runs the prototype setter; neither may drop a producer key.
  const PROTO = [
    'type: Metric',
    'constructor: c0',
    'toString: t0',
    'generated: { by: human:a, constructor: c1, toString: t1, __proto__: p1 }',
    'verified:',
    '  - { by: human:a, constructor: c2, __proto__: p2 }',
    'sources:',
    '  - { id: s, resource: https://x.example/s, toString: t3, usage_window: { from: 2026-05-01T00:00:00Z, constructor: c4, __proto__: p4 } }',
    'usage_window: { from: 2026-06-01T00:00:00Z, toString: t5 }',
    'parameters:',
    '  - { name: year, constructor: c6, __proto__: p6 }',
    'executor: { resource: https://example.org/run, constructor: custom, toString: t7, __proto__: p7 }',
    'attester: { resource: https://x.example/a, valueOf: v8 }',
  ].join('\n');
  const own = (obj: unknown, key: string) => Object.getOwnPropertyDescriptor(obj as object, key)?.value;

  it('writes every key back in every family', () => {
    const fm = exportedFrontmatter(bundle(PROTO));
    expect([own(fm, 'constructor'), own(fm, 'toString')]).toEqual(['c0', 't0']);
    expect(['constructor', 'toString', '__proto__'].map((k) => own(fm.generated, k))).toEqual(['c1', 't1', 'p1']);
    const [v] = fm.verified as unknown[];
    expect([own(v, 'constructor'), own(v, '__proto__')]).toEqual(['c2', 'p2']);
    const [src] = fm.sources as Array<Record<string, unknown>>;
    expect(own(src, 'toString')).toBe('t3');
    expect([own(src.usage_window, 'constructor'), own(src.usage_window, '__proto__')]).toEqual(['c4', 'p4']);
    expect(own(fm.usage_window, 'toString')).toBe('t5');
    const [param] = fm.parameters as unknown[];
    expect([own(param, 'constructor'), own(param, '__proto__')]).toEqual(['c6', 'p6']);
    expect(['constructor', 'toString', '__proto__'].map((k) => own(fm.executor, k))).toEqual(['custom', 't7', 'p7']);
    expect(own(fm.attester, 'valueOf')).toBe('v8');
    // and no prototype was replaced along the way
    expect(Object.getPrototypeOf(fm.executor)).toBe(Object.prototype);
  });

  it('round-trips the graph exactly', () => {
    const first = importBundle(bundle(PROTO));
    const second = importBundle(exportBundle(first));
    const strip = (r: typeof first) => quadsToNQuads(r.quads.filter((q) => !q.subject.includes(GENID_TAGS.section) && q.predicate !== DKG_HAS_SECTION));
    expect(strip(second)).toBe(strip(first));
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

describe('concept IDs are arbitrary file paths', () => {
  it('imports `__proto__.md` and `constructor.md` as ordinary, linked concepts', () => {
    const r = importBundle([
      IDX_V02(),
      { path: '__proto__.md', content: '---\ntype: Thing\ntitle: P\n---\n\nSee [c](constructor.md).\n' },
      { path: 'constructor.md', content: '---\ntype: Thing\ntitle: C\n---\n\nSee [p](__proto__.md).\n' },
    ]);
    expect(r.concepts.map((c) => [c.conceptId, c.iri])).toEqual([
      ['__proto__', 'urn:okf:__proto__'],
      ['constructor', 'urn:okf:constructor'],
    ]);
    expect(Object.keys(r.iriByConceptId).sort()).toEqual(['__proto__', 'constructor']);
    expect(r.concepts.map((c) => c.resolvedLinks.map((l) => l.targetConceptId))).toEqual([['constructor'], ['__proto__']]);
    expect(r.quads.every((q) => typeof q.subject === 'string')).toBe(true);
    expect(exportBundle(r).map((f) => f.path)).toEqual(['__proto__.md', 'constructor.md', 'index.md']);
  });
});

describe('the same triple from several named graphs is one triple on export', () => {
  const acme = loadBundleDir(fileURLToPath(new URL('./fixtures/acme_retail', import.meta.url)));
  const bitcoin = loadBundleDir(fileURLToPath(new URL('./fixtures/crypto_bitcoin', import.meta.url)));

  it('exports doubled rows byte-for-byte like the single graph', () => {
    for (const files of [acme, bitcoin]) {
      const imported = importBundle(files);
      const single = exportBundle(exportInputFromQuads(imported.quads));
      expect(single).toEqual(exportBundle(imported));
      expect(exportBundle(exportInputFromQuads([...imported.quads, ...imported.quads]))).toEqual(single);
      // a caller-built ExportInput with repeats is normalised as well
      const repeated = { concepts: imported.concepts.map((c) => ({ ...c, quads: [...c.quads, ...c.quads] })) };
      expect(exportBundle(repeated)).toEqual(single);
    }
  });

  it('keeps distinct sources that name the same resource as separate entries', () => {
    const files = bundle('type: Metric\nsources:\n  - { id: a, resource: /policies/revenue-recognition.md }\n  - { id: b, resource: /policies/revenue-recognition.md }');
    const imported = importBundle(files);
    const doubled = exportBundle(exportInputFromQuads([...imported.quads, ...imported.quads]));
    const fm = parseDocument('metrics/revenue.md', doubled.find((f) => f.path === 'metrics/revenue.md')!.content).frontmatter;
    expect(fm.sources).toEqual([
      { id: 'a', resource: '/policies/revenue-recognition.md' },
      { id: 'b', resource: '/policies/revenue-recognition.md' },
    ]);
  });
});

describe('rdf:type export', () => {
  const TYPES: Array<[string, string]> = [
    ['http://schema.org/toString', 'http://schema.org/toString'],
    ['http://schema.org/constructor', 'http://schema.org/constructor'],
    ['http://schema.org/__proto__', 'http://schema.org/__proto__'],
    ['http://schema.org/foo-bar', 'http://schema.org/foo-bar'],
    ['http://schema.org/thing', 'http://schema.org/thing'],
    ['BigQuery Table', 'BigQueryTable'],
    ['Attested Computation', 'Attested Computation'],
    ['https://example.org/Custom', 'https://example.org/Custom'],
  ];
  const files: BundleFile[] = [IDX_V02(), ...TYPES.map(([type], i) => ({ path: `t${i}.md`, content: `---\ntype: ${type}\n---\n\nbody\n` }))];
  const imported = importBundle(files);

  it('writes a string for every type, and the full IRI when a bare local name would not map back', () => {
    const exported = exportBundle(imported);
    TYPES.forEach(([, expected], i) => {
      const fm = parseDocument(`t${i}.md`, exported.find((f) => f.path === `t${i}.md`)!.content).frontmatter;
      expect(typeof fm.type).toBe('string');
      expect(fm.type).toBe(expected);
    });
  });

  it('re-imports every concept with its original rdf:type', () => {
    const exported = exportBundle(imported);
    const typesOf = (r: typeof imported) => r.quads.filter((q) => q.predicate === RDF_TYPE).map((q) => `${q.subject} ${q.object}`).sort();
    expect(typesOf(importBundle(exported))).toEqual(typesOf(imported));
  });
});

describe('family definitions are internal and carry their behaviour as data', () => {
  it('keeps the definitions and codec out of the public API', () => {
    for (const name of ['FAMILY_SPECS', 'FAMILY_BY_KEY', 'VERIFIED', 'SOURCES', 'encodeFamily', 'decodeFamilies', 'parseList']) {
      expect(Object.prototype.hasOwnProperty.call(okfPublic, name)).toBe(false);
    }
    for (const name of ['familyQuads', 'familyDiagnostics', 'parseVerified', 'exportInputFromQuads', 'V02_FAMILY_KEYS']) {
      expect(Object.prototype.hasOwnProperty.call(okfPublic, name)).toBe(true);
    }
  });

  it('does not depend on which definition object it is handed', () => {
    const ctx = { conceptId: 'm', iriBase: 'urn:okf:', conceptExists: () => false };
    const value = [{ by: 'human:a', at: '2026-06-25T09:00:00Z' }];
    const canonical = encodeFamily('urn:okf:m', VERIFIED, value, ctx);
    const copy = encodeFamily('urn:okf:m', { ...VERIFIED }, value, ctx);
    expect(quadsToNQuads(copy.quads)).toBe(quadsToNQuads(canonical.quads));
    expect(copy.quads.some((q) => q.predicate === OKF_TRUST_TIER)).toBe(true);
  });
});

describe('a malformed value never aborts the bundle', () => {
  // A YAML mapping can carry its own `toString` key; String() of it throws.
  const SIBLING: BundleFile = { path: 'sibling.md', content: '---\ntype: Thing\ntitle: Healthy\n---\n\nbody\n' };
  const withSibling = (fm: string) => [...bundle(fm), SIBLING];
  const strip = (quads: Quad[]) => quadsToNQuads(quads.filter((q) => !q.subject.includes(GENID_TAGS.section) && q.predicate !== DKG_HAS_SECTION));

  it('a verifier given as a mapping names no verifier, warns, and leaves sibling concepts importing', () => {
    const files = withSibling('type: Metric\nverified: { by: { toString: human:alice } }');
    const r = importBundle(files);
    expect(r.concepts.map((c) => c.conceptId).sort()).toEqual(['metrics/revenue', 'policies/revenue-recognition', 'sibling']);
    const c = r.concepts.find((x) => x.conceptId === 'metrics/revenue')!;
    expect(objs(c.quads, OKF_VERIFICATION)).toEqual([]);
    expect(c.trust).toMatchObject({ tier: 'unverified', verifications: 0 });
    expect(r.warnings.map((w) => w.message)).toContain('`verified[0].by` should be a single value, not a mapping or list (§5.2); the entry is skipped');
    expect(validateBundle(files).warnings.join('\n')).toMatch(/verified\[0\]\.by` should be a single value/);
  });

  it('keeps any other family field given a mapping or list verbatim, with a warning, through export', () => {
    const fm = [
      'type: Attested Computation',
      'status: { toString: x }',
      'stale_after: [2026-12-31T00:00:00Z]',
      'runtime: [bigquery]',
      'computation: { file: x.sql }',
      'generated: { by: { toString: g }, at: 2026-06-30T14:00:00Z }',
      'sources:',
      '  - { id: [a], resource: { href: https://x.example/s }, title: { toString: t }, author: { toString: a }, usage_count: [1, 2] }',
      'parameters:',
      '  - { name: [year], required: [true] }',
      'executor: { resource: { toString: r }, receipt: [job_id, { k: 1 }] }',
    ].join('\n');
    const files = withSibling(fm);
    const r = importBundle(files);
    const messages = r.warnings.map((w) => w.message);
    for (const label of ['status', 'stale_after', 'runtime', 'computation', 'generated.by', 'sources[0].id', 'sources[0].resource', 'sources[0].title', 'sources[0].author', 'sources[0].usage_count', 'parameters[0].name', 'parameters[0].required', 'executor.resource']) {
      expect(messages.some((m) => m.startsWith(`\`${label}\` should be a single value`)), `warning for ${label}`).toBe(true);
    }
    expect(messages).toContain('`executor.receipt[1]` should be a single value, not a mapping or list (§10.2); kept verbatim');
    const c = r.concepts.find((x) => x.conceptId === 'metrics/revenue')!;
    expect(objs(c.quads, OKF_STATUS)).toEqual([`"{\\"toString\\":\\"x\\"}"^^<${RDF_JSON}>`]);
    expect(objs(c.quads, PROV_WAS_DERIVED_FROM)).toEqual([]); // a mapping is not a resource IRI
    expect(c.trust.generatedBy).toBeNull();
    const exported = exportBundle(r);
    const back = parseDocument('metrics/revenue.md', exported.find((f) => f.path === 'metrics/revenue.md')!.content).frontmatter;
    expect(Object.getOwnPropertyDescriptor(back.status, 'toString')?.value).toBe('x');
    expect(back.runtime).toEqual(['bigquery']);
    expect((back.executor as Record<string, unknown>).receipt).toEqual(['job_id', { k: 1 }]);
    expect(strip(importBundle(exported).quads)).toBe(strip(r.quads));
  });

  it('never throws on a malformed base field or type', () => {
    const files = [IDX_V02(), { path: 'a.md', content: '---\ntype: Metric\ntitle: { toString: x }\ntags: [{ toString: t }]\nresource: { toString: r }\n---\n\nbody\n' }, { path: 'b.md', content: '---\ntype: { toString: x }\n---\n\nbody\n' }, SIBLING];
    const r = importBundle(files);
    expect(r.concepts.map((c) => c.conceptId)).toEqual(['a', 'b', 'sibling']);
    expect(validateBundle(files).conformant).toBe(true);
  });

  it('skips only the concept whose value no RDF term can hold (a cyclic alias)', () => {
    const files = [IDX_V02(), { path: 'a.md', content: '---\ntype: Metric\nowner: &x\n  self: *x\n---\n\nbody\n' }, SIBLING];
    const r = importBundle(files);
    expect(r.concepts.map((c) => c.conceptId)).toEqual(['sibling']);
    expect(r.warnings.find((w) => w.conceptId === 'a')).toMatchObject({ code: 'parse' });
    expect(r.warnings.find((w) => w.conceptId === 'a')!.message).toMatch(/^could not be mapped \(.*circular.*\); skipped$/);
  });
});

describe('schema:isPartOf and schema:url on export', () => {
  it('keeps an explicit isPartOf producer value', () => {
    const files = [IDX_V02(), { path: 'reports/q.md', content: '---\ntype: Metric\nisPartOf: FY2026 reporting\n---\n\nbody\n' }];
    const first = importBundle(files);
    const exported = exportBundle(first);
    expect(parseDocument('reports/q.md', exported.find((f) => f.path === 'reports/q.md')!.content).frontmatter.isPartOf).toBe('FY2026 reporting');
    expect(quadsToNQuads(importBundle(exported).quads.filter((q) => q.predicate === SCHEMA_IS_PART_OF))).toBe(
      quadsToNQuads(first.quads.filter((q) => q.predicate === SCHEMA_IS_PART_OF)),
    );
  });

  it('omits only the folder edge emitFolderHierarchy infers, which the option re-derives', () => {
    const files = [IDX_V02(), { path: 'reports/q.md', content: '---\ntype: Metric\nisPartOf: FY2026 reporting\n---\n\nbody\n' }];
    const first = importBundle(files, { emitFolderHierarchy: true });
    expect(objs(first.quads, SCHEMA_IS_PART_OF, 'urn:okf:reports/q').sort()).toEqual(['"FY2026 reporting"', 'urn:okf:reports']);
    const exported = exportBundle(first);
    expect(parseDocument('reports/q.md', exported.find((f) => f.path === 'reports/q.md')!.content).frontmatter.isPartOf).toBe('FY2026 reporting');
    expect(quadsToNQuads(importBundle(exported, { emitFolderHierarchy: true }).quads.filter((q) => q.predicate === SCHEMA_IS_PART_OF))).toBe(
      quadsToNQuads(first.quads.filter((q) => q.predicate === SCHEMA_IS_PART_OF)),
    );
  });

  it('writes a resource that is not an IRI back by value, not as a quoted term', () => {
    const files = [IDX_V02(), { path: 'a.md', content: '---\ntype: Metric\nresource: tables/orders\n---\n\nbody\n' }];
    const first = importBundle(files);
    const exported = exportBundle(first);
    expect(parseDocument('a.md', exported.find((f) => f.path === 'a.md')!.content).frontmatter.resource).toBe('tables/orders');
    expect(objs(importBundle(exported).quads, SCHEMA_URL, 'urn:okf:a')).toEqual(['"tables/orders"']);
  });
});

describe('concept diagnostics have one owner', () => {
  it('mapConcept reports unresolved source paths and body links, and the bundle reports exactly those', () => {
    const files = bundle(
      'type: Metric\nsources:\n  - { id: s, resource: /policies/missing.md }',
      'See [gone](/tables/gone.md) and `[code](/policies/revenue-recognition.md)`.\n',
    );
    const r = importBundle(files);
    const c = r.concepts.find((x) => x.conceptId === 'metrics/revenue')!;
    const expected = [
      'broken-link|sources[0].resource "/policies/missing.md" does not resolve to a concept in the bundle (not an error, SPEC §6.1/§11)',
      'broken-link|unresolved cross-link "/tables/gone.md" (not in bundle — not an error, SPEC §6.1/§11)',
      'code-span-link|link "/policies/revenue-recognition.md" sits inside an inline code span — treated as literal text per CommonMark, not an edge',
    ];
    expect(c.warnings.map((w) => `${w.code}|${w.message}`)).toEqual(expected);
    expect(r.warnings.filter((w) => w.conceptId === 'metrics/revenue').map((w) => `${w.code}|${w.message}`)).toEqual(expected);
    // includeCodeSpanLinks turns the code-span link into an edge, and its warning off
    const withCode = importBundle(files, { includeCodeSpanLinks: true }).concepts.find((x) => x.conceptId === 'metrics/revenue')!;
    expect(withCode.warnings.map((w) => w.code)).toEqual(['broken-link', 'broken-link']);
    expect(withCode.codeSpanLinks.map((l) => l.raw)).toEqual(['/policies/revenue-recognition.md']);
  });
});

describe('§12 versioning', () => {
  it('reads okf_version 0.2 silently and warns (best-effort) on an unknown version', () => {
    const ok = importBundle(bundle('type: Metric'));
    expect(ok.okfVersion).toBe('0.2');
    expect(ok.warnings.some((w) => w.code === 'unsupported-version')).toBe(false);
    const files = bundle('type: Metric');
    files[0] = { path: 'index.md', content: '---\nokf_version: "0.3"\n---\n\n# Root\n' };
    const r = importBundle(files);
    expect(r.okfVersion).toBe('0.3');
    expect(r.warnings.filter((w) => w.code === 'unsupported-version')).toHaveLength(1);
    expect(r.concepts).toHaveLength(2); // still consumed
    expect(validateBundle(files).warnings.join('\n')).toMatch(/okf_version "0\.3"/);
  });
  it('export declares okf_version 0.2 in the root index only', () => {
    const exported = exportBundle(importBundle(bundle('type: Metric')));
    const root = exported.find((f) => f.path === 'index.md')!;
    expect(root.content.startsWith('---\nokf_version: "0.2"\n---\n')).toBe(true);
    expect(exported.find((f) => f.path === 'metrics/index.md')!.content.startsWith('---')).toBe(false);
    expect(importBundle(exported).okfVersion).toBe('0.2');
    expect(validateBundle(exported).conformant).toBe(true);
  });
});

describe('producer-defined keys', () => {
  it('carries nested mappings as rdf:JSON so they round-trip as objects', () => {
    const yaml = 'type: Metric\nnot:\n  - term: revenue minus product cost only\n    why: legacy\nowner: { team: finance, lead: human:a }';
    const { c } = conceptOf(bundle(yaml));
    expect(objs(c.quads, SCHEMA_NS + 'not')).toEqual([`"{\\"term\\":\\"revenue minus product cost only\\",\\"why\\":\\"legacy\\"}"^^<${RDF_JSON}>`]);
    const fm = exportedFrontmatter(bundle(yaml));
    expect(fm.not).toEqual({ term: 'revenue minus product cost only', why: 'legacy' });
    expect(fm.owner).toEqual({ team: 'finance', lead: 'human:a' });
  });
  it('writes a v0.1 import back with the legacy timestamp key (generated needs a by)', () => {
    const fm = exportedFrontmatter(bundle("type: Metric\ntimestamp: '2026-05-28T22:44:47+00:00'"));
    expect(fm.timestamp).toBe('2026-05-28T22:44:47+00:00');
    expect(fm.generated).toBeUndefined();
  });
});

describe('frontmatterQuads without bundle context', () => {
  it('still maps the families; bundle paths stay literals and node IRIs derive from the subject IRI', () => {
    const quads = frontmatterQuads(IRI, {
      type: 'Metric',
      verified: { by: 'human:a', at: '2026-06-25T09:00:00Z' },
      sources: [{ id: 'p', resource: 'policies/revenue-recognition.md' }],
    });
    expect(objs(quads, OKF_VERIFICATION)).toEqual([node(GENID_TAGS.verification, 0)]);
    expect(objs(quads, OKF_RESOURCE, node(GENID_TAGS.source, 0))).toEqual(['"policies/revenue-recognition.md"']);
    expect(objs(quads, PROV_WAS_DERIVED_FROM)).toEqual([]);
    const m = mapFrontmatter(IRI, { type: 'Metric' });
    expect(m).toEqual({ quads: [{ subject: IRI, predicate: RDF_TYPE, object: 'http://schema.org/Metric' }], derivedFromConcepts: [], warnings: [] });
  });
  it('is byte-stable', () => {
    const fm = loadYaml('type: Metric\nverified: { by: human:a, at: 2026-06-25T09:00:00Z }\nsources:\n  - resource: https://x.example/a\n') as Record<string, unknown>;
    expect(quadsToNQuads(frontmatterQuads(IRI, fm))).toBe(quadsToNQuads(frontmatterQuads(IRI, fm)));
  });
});
