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
} from '../src/index.js';
import type { BundleFile, Quad } from '../src/index.js';

const IRI = 'urn:okf:metrics/revenue';
const DT = (lex: string) => `"${lex}"^^<${XSD_DATE_TIME}>`;
const objs = (quads: Quad[], predicate: string, subject = IRI) =>
  quads.filter((q) => q.subject === subject && q.predicate === predicate).map((q) => q.object);
const node = (tag: string, i: number) => `${IRI}${SECTION_GENID_INFIX}${tag}metrics_revenue_${i}`;

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
  it('preserves producer keys nested inside generated under okf:generated<Key>', () => {
    const { c } = conceptOf(bundle('type: Metric\ngenerated: { by: human:a, at: 2026-06-30T14:00:00Z, model: gemini-2.5-pro }'));
    expect(objs(c.quads, OKF_NS + 'generatedModel')).toEqual(['"gemini-2.5-pro"']);
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
    expect(objs(c.quads, SCHEMA_NS + 'note', node(GENID_TAGS.verification, 1))).toEqual(['"re-run"']);
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
    // derivation edges: the policy concept (deduped) + the external URL; scope descriptor gets none
    expect(objs(c.quads, PROV_WAS_DERIVED_FROM).sort()).toEqual([
      'https://developers.google.com/analytics/bigquery/export-schema',
      policy,
      policy,
      policy,
    ].sort());
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
    expect(objs(c.quads, SCHEMA_NS + 'default', p1)).toEqual(['"all"']);
    expect(objs(c.quads, OKF_COMPUTATION)).toEqual(['"references/computations/lib/revenue.sql"']);
    // a bundle concept named by executor.resource becomes a typed edge
    expect(objs(c.quads, OKF_EXECUTOR_RESOURCE)).toEqual(['urn:okf:policies/revenue-recognition']);
    expect(objs(c.quads, OKF_EXECUTOR_RECEIPT).sort()).toEqual(['"executed_sql"', '"job_id"', '"result"']);
    expect(objs(c.quads, OKF_NS + 'executorTimeoutS')).toEqual([`"30"^^<${XSD_INTEGER}>`]);
    expect(objs(c.quads, OKF_ATTESTER_RESOURCE)).toEqual(['"references/attesters/sql-equality.py"']);
    expect(objs(c.quads, OKF_NS + 'attesterStrict')).toEqual([`"true"^^<${XSD_BOOLEAN}>`]);
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
      timeoutS: 30,
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
