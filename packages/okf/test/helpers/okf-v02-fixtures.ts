/**
 * Fixture builders shared by the OKF v0.2 test suites: a two-concept bundle
 * (the concept under test plus a policy it can derive from), and small
 * accessors for its quads and exported frontmatter. Not a test file.
 */

import {
  exportBundle,
  importBundle,
  parseDocument,
  quadsToNQuads,
  DKG_HAS_SECTION,
  GENID_TAGS,
  SECTION_GENID_INFIX,
  XSD_DATE_TIME,
} from '../../src/index.js';
import type { BundleFile, Quad } from '../../src/index.js';

export const IRI = 'urn:okf:metrics/revenue';
export const DT = (lex: string) => `"${lex}"^^<${XSD_DATE_TIME}>`;
export const objs = (quads: Quad[], predicate: string, subject = IRI) =>
  quads.filter((q) => q.subject === subject && q.predicate === predicate).map((q) => q.object);
export const node = (tag: string, i: number) => `${IRI}${SECTION_GENID_INFIX}${tag}metrics_revenue_${i}`;

export const IDX_V02 = (): BundleFile => ({ path: 'index.md', content: '---\nokf_version: "0.2"\n---\n\n# Root\n' });

/** A two-concept bundle: the subject under test plus a policy it can derive from. */
export function bundle(frontmatterYaml: string, body = 'body\n'): BundleFile[] {
  return [
    { path: 'index.md', content: '---\nokf_version: "0.2"\n---\n\n# Root\n' },
    { path: 'metrics/revenue.md', content: `---\n${frontmatterYaml}\n---\n\n${body}` },
    { path: 'policies/revenue-recognition.md', content: '---\ntype: Policy\ntitle: Rev rec\n---\n\nbody\n' },
  ];
}
export function conceptOf(files: BundleFile[], id = 'metrics/revenue') {
  const r = importBundle(files);
  const c = r.concepts.find((x) => x.conceptId === id)!;
  return { r, c };
}
export function exportedFrontmatter(files: BundleFile[], path = 'metrics/revenue.md'): Record<string, unknown> {
  const exported = exportBundle(importBundle(files));
  const file = exported.find((f) => f.path === path)!;
  return parseDocument(path, file.content).frontmatter;
}

/**
 * The semantic graph: every quad minus the presentational `dkg:hasSection`
 * structure (the `hasSection` edges and the skolemized *section* nodes). The
 * v0.2 family nodes (`okfver_` / `okfsrc_` / `okfparam_`) ARE part of the
 * semantic graph and must survive the round trip. Equivalence is asserted over
 * this projection (export is graph-faithful, not byte-faithful — see export.ts).
 */
export function semantic(quads: Quad[]): string {
  const sectionNode = SECTION_GENID_INFIX + GENID_TAGS.section;
  return quadsToNQuads(quads.filter((q) => !q.subject.includes(sectionNode) && q.predicate !== DKG_HAS_SECTION));
}
