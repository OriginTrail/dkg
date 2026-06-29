/**
 * Deterministic OKF concept → RDF mapping (no LLM, no network).
 *
 * One OKF concept document maps to one Knowledge Asset subject IRI plus a set
 * of content + linkage quads. The mapping reuses the node Markdown extractor's
 * predicate vocabulary (so an OKF import and a native Markdown import converge),
 * with the OKF-specific deltas recorded in `docs/adr/0005-okf-rdf-mapping.md`:
 *
 *   - body links are real Markdown links `[text](path)` (OKF §5), NOT the
 *     extractor's `[[wikilinks]]`, so we resolve them with a real Markdown AST
 *     (`mdast-util-from-markdown`) — which is also what lets us honour the
 *     CommonMark rule that a link inside an inline code span is literal text;
 *   - OKF concept titles live in frontmatter, so body headings (including `#`
 *     H1s like `# Schema`) are genuine sections → `dkg:hasSection`;
 *   - `timestamp` is OKF's last-modified time → `schema:dateModified`.
 */

import { fromMarkdown } from 'mdast-util-from-markdown';
import { toString as mdToString } from 'mdast-util-to-string';
import type { Nodes, Link, InlineCode, Text } from 'mdast';
import {
  RDF_TYPE,
  SCHEMA_NS,
  SCHEMA_NAME,
  SCHEMA_DESCRIPTION,
  SCHEMA_KEYWORDS,
  SCHEMA_MENTIONS,
  SCHEMA_DATE_MODIFIED,
  SCHEMA_URL,
  SCHEMA_CITATION,
  SCHEMA_IS_PART_OF,
  DKG_HAS_SECTION,
  SECTION_GENID_INFIX,
  XSD_DATE_TIME,
  XSD_BOOLEAN,
  XSD_INTEGER,
  XSD_DECIMAL,
  DEFAULT_IRI_BASE,
} from './constants.js';
import { conceptIdToIri, resolveLinkTarget } from './paths.js';
import {
  isSafeIri,
  literalTerm,
  typedLiteralTerm,
  pascalCase,
  camelCase,
  sanitizeForBlank,
} from './utils.js';
import type {
  OkfDocument,
  OkfMappingOptions,
  ConceptMapping,
  Quad,
  OkfLink,
  OkfCitation,
} from './types.js';

const BARE_URL_RE = /https?:\/\/[^\s)<>"]+/g;
const INLINE_LINK_RE = /\[[^\]]*\]\(([^)\s]+)\)/g;

/** OKF `type` value → an rdf:type object IRI (raw, no angle brackets). */
function typeToIri(value: unknown): string | null {
  const s = String(value).trim();
  if (!s) return null;
  if (isSafeIri(s)) return s; // already a full IRI (e.g. `tag:…`, `https://…`)
  const pascal = pascalCase(s);
  return pascal ? SCHEMA_NS + pascal : null;
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

function dateToLexical(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/** Producer-defined scalar/array values → object terms (typed where possible). */
function valueToTerms(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap(valueToTerms);
  if (value instanceof Date) return [typedLiteralTerm(value.toISOString(), XSD_DATE_TIME)];
  if (typeof value === 'boolean') return [typedLiteralTerm(String(value), XSD_BOOLEAN)];
  if (typeof value === 'number') {
    return [typedLiteralTerm(String(value), Number.isInteger(value) ? XSD_INTEGER : XSD_DECIMAL)];
  }
  if (typeof value === 'string') {
    return [isSafeIri(value) ? value : literalTerm(value)];
  }
  return [literalTerm(JSON.stringify(value))];
}

/** Map the YAML frontmatter to quads (SPEC §4.1; see the locked table in ADR 0005). */
export function frontmatterQuads(iri: string, frontmatter: Record<string, unknown>): Quad[] {
  const out: Quad[] = [];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === null || value === undefined) continue;
    switch (key) {
      case 'type': {
        const t = typeToIri(value);
        if (t) out.push({ subject: iri, predicate: RDF_TYPE, object: t });
        break;
      }
      case 'title':
        out.push({ subject: iri, predicate: SCHEMA_NAME, object: literalTerm(String(value)) });
        break;
      case 'description':
        out.push({
          subject: iri,
          predicate: SCHEMA_DESCRIPTION,
          object: literalTerm(String(value)),
        });
        break;
      case 'tags':
        for (const tag of toArray(value)) {
          out.push({ subject: iri, predicate: SCHEMA_KEYWORDS, object: literalTerm(String(tag)) });
        }
        break;
      case 'timestamp':
        out.push({
          subject: iri,
          predicate: SCHEMA_DATE_MODIFIED,
          object: typedLiteralTerm(dateToLexical(value), XSD_DATE_TIME),
        });
        break;
      case 'resource': {
        const r = String(value);
        out.push({
          subject: iri,
          predicate: SCHEMA_URL,
          object: isSafeIri(r) ? r : literalTerm(r),
        });
        break;
      }
      default: {
        // Producer-defined keys — preserved, never dropped (SPEC §4.1/§9).
        const predicate = SCHEMA_NS + camelCase(key);
        for (const term of valueToTerms(value)) {
          out.push({ subject: iri, predicate, object: term });
        }
      }
    }
  }
  return out;
}

interface ParsedBody {
  headings: string[];
  /** Real Markdown links found outside the Citations section. */
  bodyLinks: string[];
  /** `[label](target)` patterns found inside inline code spans (outside Citations). */
  codeSpanHrefs: string[];
  /** Citations gathered from the `# Citations` section (both styles). */
  citations: OkfCitation[];
}

function collect(node: Nodes, links: Link[], codes: InlineCode[], texts: string[]): void {
  if (node.type === 'link') links.push(node);
  else if (node.type === 'inlineCode') codes.push(node);
  else if (node.type === 'text') texts.push((node as Text).value);
  if ('children' in node && Array.isArray(node.children)) {
    for (const child of node.children) collect(child as Nodes, links, codes, texts);
  }
}

function extractInlineLinkHrefs(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(INLINE_LINK_RE)) out.push(m[1]);
  return out;
}

/** Parse a concept body with a real Markdown AST. */
export function parseBody(body: string): ParsedBody {
  const tree = fromMarkdown(body);
  const headings: string[] = [];
  const bodyLinks: string[] = [];
  const codeSpanHrefs: string[] = [];
  const citations: OkfCitation[] = [];
  let currentSection = '';

  for (const node of tree.children) {
    if (node.type === 'heading') {
      const text = mdToString(node);
      headings.push(text);
      currentSection = text.trim().toLowerCase();
      continue;
    }
    const inCitations = currentSection === 'citations';
    const links: Link[] = [];
    const codes: InlineCode[] = [];
    const texts: string[] = [];
    collect(node as Nodes, links, codes, texts);

    if (inCitations) {
      for (const l of links) {
        const label = mdToString(l).trim();
        citations.push(label ? { url: l.url, label } : { url: l.url });
      }
      for (const t of texts) {
        for (const m of t.matchAll(BARE_URL_RE)) citations.push({ url: m[0] });
      }
    } else {
      for (const l of links) bodyLinks.push(l.url);
      for (const c of codes) codeSpanHrefs.push(...extractInlineLinkHrefs(c.value));
    }
  }
  return { headings, bodyLinks, codeSpanHrefs, citations };
}

/**
 * Map a single concept to its Knowledge Asset quads + structured link/citation
 * diagnostics. `conceptExists` decides whether a resolved link target is in the
 * bundle (a candidate that is not present is a broken link — warned, never fatal).
 */
export function mapConcept(
  doc: OkfDocument,
  iri: string,
  conceptExists: (conceptId: string) => boolean,
  opts: OkfMappingOptions = {},
): ConceptMapping {
  const iriBase = opts.iriBase ?? DEFAULT_IRI_BASE;
  const quads: Quad[] = [...frontmatterQuads(iri, doc.frontmatter)];

  const parsed = parseBody(doc.body);

  // Sections: every body heading (OKF titles live in frontmatter, so H1s count).
  // Section nodes are skolemized into deterministic concept-scoped IRIs rather
  // than emitted as RDF blank nodes: the daemon rejects blank-node *objects*
  // ("RDF object must be a quoted literal term or absolute IRI"), so a blank
  // `hasSection` object fails the first write on a strict node. The IRI uses the
  // node's own `.well-known/genid/` scheme, so the stored graph is identical.
  parsed.headings.forEach((text, i) => {
    const sectionIri = `${iri}${SECTION_GENID_INFIX}okfsec_${sanitizeForBlank(doc.conceptId)}_${i}`;
    quads.push({ subject: iri, predicate: DKG_HAS_SECTION, object: sectionIri });
    quads.push({ subject: sectionIri, predicate: SCHEMA_NAME, object: literalTerm(text) });
  });

  const resolvedLinks: OkfLink[] = [];
  const brokenLinks: OkfLink[] = [];
  const codeSpanLinks: OkfLink[] = [];
  const edgeTargets = new Set<string>();

  const addEdge = (target: string) => {
    if (edgeTargets.has(target)) return;
    edgeTargets.add(target);
    quads.push({
      subject: iri,
      predicate: SCHEMA_MENTIONS,
      object: conceptIdToIri(target, iriBase),
    });
  };

  for (const href of parsed.bodyLinks) {
    const candidate = resolveLinkTarget(href, doc.conceptId);
    if (candidate && conceptExists(candidate)) {
      resolvedLinks.push({ raw: href, targetConceptId: candidate, inCodeSpan: false });
      addEdge(candidate);
    } else if (candidate) {
      // Resolved to a bundle path that doesn't exist → broken (SPEC §5.3/§9).
      brokenLinks.push({ raw: href, targetConceptId: null, inCodeSpan: false });
    }
    // candidate === null → external URL / anchor / escapes root: not a concept edge.
  }

  for (const href of parsed.codeSpanHrefs) {
    const candidate = resolveLinkTarget(href, doc.conceptId);
    const present = !!candidate && conceptExists(candidate);
    const link: OkfLink = {
      raw: href,
      targetConceptId: present ? candidate : null,
      inCodeSpan: true,
    };
    codeSpanLinks.push(link);
    if (opts.includeCodeSpanLinks && present && candidate) {
      resolvedLinks.push(link);
      addEdge(candidate);
    }
  }

  const citations: OkfCitation[] = [];
  const seenCitation = new Set<string>();
  for (const c of parsed.citations) {
    if (seenCitation.has(c.url)) continue;
    seenCitation.add(c.url);
    citations.push(c);
    quads.push({
      subject: iri,
      predicate: SCHEMA_CITATION,
      object: isSafeIri(c.url) ? c.url : literalTerm(c.url),
    });
  }

  if (opts.emitFolderHierarchy && doc.segments.length > 1) {
    const parentId = doc.segments.slice(0, -1).join('/');
    quads.push({
      subject: iri,
      predicate: SCHEMA_IS_PART_OF,
      object: conceptIdToIri(parentId, iriBase),
    });
  }

  return { conceptId: doc.conceptId, iri, quads, resolvedLinks, brokenLinks, codeSpanLinks, citations };
}
