/**
 * Phase 2 of document ingestion: deterministic structural extraction
 * from a Markdown intermediate to RDF triples + provenance.
 *
 * This is the "Layer 1 structural" extraction defined by
 * `19_MARKDOWN_CONTENT_TYPE.md` — it runs without an LLM and produces
 * triples from explicit Markdown/YAML structure only:
 *
 *   - YAML frontmatter keys → subject properties
 *   - `type` frontmatter key → rdf:type
 *   - Wikilinks `[[Target]]` → schema:mentions
 *   - Hashtags `#keyword` → schema:keywords
 *   - Dataview `key:: value` inline fields → properties
 *   - Heading hierarchy → dkg:hasSection
 *
 * Every extracted triple gets a provenance record pointing to a
 * `dkg:ExtractionProvenance` blank identifier so downstream consumers
 * can distinguish structurally-derived triples from user-asserted ones.
 *
 * Spec: 05_PROTOCOL_EXTENSIONS.md §6.5.2, 19_MARKDOWN_CONTENT_TYPE.md
 */

import { load as loadYaml } from 'js-yaml';
import type { ExtractionQuad as Quad } from '@origintrail-official/dkg-core';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SCHEMA_NAME = 'http://schema.org/name';
const SCHEMA_DESCRIPTION = 'http://schema.org/description';
const SCHEMA_MENTIONS = 'http://schema.org/mentions';
const SCHEMA_KEYWORDS = 'http://schema.org/keywords';
const DKG_HAS_SECTION = 'http://dkg.io/ontology/hasSection';
const DKG_EXTRACTION_PROVENANCE = 'http://dkg.io/ontology/ExtractionProvenance';
const DKG_DERIVED_FROM = 'http://dkg.io/ontology/derivedFrom';
const DKG_EXTRACTED_BY = 'http://dkg.io/ontology/extractedBy';
const DKG_EXTRACTION_RULE = 'http://dkg.io/ontology/extractionRule';
const DKG_EXTRACTED_AT = 'http://dkg.io/ontology/extractedAt';
const PROV_WAS_GENERATED_BY = 'http://www.w3.org/ns/prov#wasGeneratedBy';
const XSD_DATE_TIME = 'http://www.w3.org/2001/XMLSchema#dateTime';

export interface MarkdownExtractInput {
  /** Markdown source text (the Phase 1 mdIntermediate). */
  markdown: string;
  /** DID of the extracting agent, recorded in provenance. */
  agentDid: string;
  /** Optional ontology URI (not yet used by Layer 1 — reserved for Layer 2). */
  ontologyRef?: string;
  /**
   * Optional stable subject IRI for the document. When omitted, the extractor
   * derives a subject from frontmatter `id` or the first H1 heading.
   */
  documentIri?: string;
  /** Optional timestamp for provenance (defaults to now). */
  now?: Date;
}

export interface MarkdownExtractOutput {
  /** Extracted RDF triples. */
  triples: Quad[];
  /** dkg:ExtractionProvenance quads for the extraction run. */
  provenance: Quad[];
  /** The subject IRI used for the document (useful to the caller for indexing). */
  subjectIri: string;
}

/**
 * Parse YAML frontmatter if present. Returns the parsed object and the
 * remaining markdown body with frontmatter stripped.
 */
function splitFrontmatter(markdown: string): { frontmatter: Record<string, unknown> | null; body: string } {
  if (!markdown.startsWith('---')) {
    return { frontmatter: null, body: markdown };
  }
  // Match the opening --- and find the closing ---
  const lines = markdown.split(/\r?\n/);
  if (lines[0].trim() !== '---') {
    return { frontmatter: null, body: markdown };
  }
  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      endIndex = i;
      break;
    }
  }
  if (endIndex === -1) {
    return { frontmatter: null, body: markdown };
  }
  const yamlText = lines.slice(1, endIndex).join('\n');
  let parsed: unknown;
  try {
    parsed = loadYaml(yamlText);
  } catch {
    return { frontmatter: null, body: markdown };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { frontmatter: null, body: markdown };
  }
  const body = lines.slice(endIndex + 1).join('\n');
  return { frontmatter: parsed as Record<string, unknown>, body };
}

/** Extract the text of the first level-1 heading, if any. */
function findFirstH1(body: string): string | null {
  const m = body.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : null;
}

/**
 * Slugify a string for use in an IRI fragment. Keeps alphanumerics and hyphens.
 */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * Resolve a stable subject IRI for the document:
 *   1. explicit `documentIri` argument, or
 *   2. frontmatter `id` (if it looks like an IRI or a slug), or
 *   3. slugified first H1 heading with an `urn:dkg:md:` prefix, or
 *   4. stable fallback `urn:dkg:md:anonymous-{short-hash}`.
 */
function resolveSubjectIri(
  input: MarkdownExtractInput,
  frontmatter: Record<string, unknown> | null,
  body: string,
): string {
  if (input.documentIri && input.documentIri.length > 0) return input.documentIri;

  const fmId = frontmatter?.['id'];
  if (typeof fmId === 'string' && fmId.length > 0) {
    if (/^(https?:|did:|urn:|_:)/.test(fmId)) return fmId;
    return `urn:dkg:md:${slugify(fmId)}`;
  }

  const h1 = findFirstH1(body);
  if (h1) return `urn:dkg:md:${slugify(h1)}`;

  // Stable fallback: hash-like suffix derived from content length and first chars
  const snippet = body.slice(0, 32).replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-]/g, '');
  return `urn:dkg:md:anonymous-${snippet.slice(0, 16) || 'empty'}`;
}

/** Resolve a value from a frontmatter `type` field to a full IRI. */
function resolveTypeIri(typeValue: unknown): string | null {
  if (typeof typeValue !== 'string' || typeValue.length === 0) return null;
  if (/^(https?:|did:|urn:)/.test(typeValue)) return typeValue;
  // Treat bare identifiers as schema.org classes by convention (Report, Person, etc.)
  return `http://schema.org/${typeValue}`;
}

/** Resolve a frontmatter scalar value to a triple object literal or IRI. */
function resolveFrontmatterValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    if (/^(https?:|did:|urn:)/.test(value)) return value;
    return JSON.stringify(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(String(value));
  }
  return null;
}

/** Extract wikilinks `[[Target]]` or `[[Target|Alt]]` → IRIs using the `urn:dkg:md:` namespace. */
function extractWikilinks(body: string): string[] {
  const out = new Set<string>();
  const re = /\[\[([^\]|#]+?)(?:#[^\]|]*)?(?:\|[^\]]*?)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const target = m[1].trim();
    if (target.length === 0) continue;
    out.add(`urn:dkg:md:${slugify(target)}`);
  }
  return [...out];
}

/**
 * Extract hashtags `#tag` from the body. Excludes markdown headings
 * (lines starting with `#` followed by a space) and code fence contents.
 */
function extractHashtags(body: string): string[] {
  const out = new Set<string>();
  const noFences = stripCodeFences(body);
  const noHeadings = noFences.replace(/^#{1,6}\s+.*$/gm, '');
  // Match `#word` where word is alphanumeric + `_`/`-`/`/`, not preceded by `[`
  // (to avoid `[#heading]` anchors) and not followed by more `#`.
  const re = /(?:^|[^\w#[/])#([a-zA-Z][\w-/]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(noHeadings)) !== null) {
    out.add(m[1]);
  }
  return [...out];
}

/**
 * Extract Dataview inline fields: `key:: value` at line-start (allowing leading whitespace).
 * Returns key-value pairs with raw string values; the caller translates to triples.
 */
function extractDataviewFields(body: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  const noFences = stripCodeFences(body);
  const re = /^[\s>*-]*([a-zA-Z][\w-]*)::\s*(.+?)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(noFences)) !== null) {
    out.push({ key: m[1], value: m[2] });
  }
  return out;
}

/** Extract section headings (H1..H6) as an ordered list with levels. */
function extractHeadings(body: string): Array<{ level: number; text: string }> {
  const noFences = stripCodeFences(body);
  const out: Array<{ level: number; text: string }> = [];
  const re = /^(#{1,6})\s+(.+?)\s*#*\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(noFences)) !== null) {
    out.push({ level: m[1].length, text: m[2].trim() });
  }
  return out;
}

/** Strip ``` fenced code blocks (and ~~~ variants) from the markdown. */
function stripCodeFences(body: string): string {
  return body.replace(/^(```|~~~)[\s\S]*?^\1\s*$/gm, '');
}

/**
 * Run the full Phase 2 structural extraction. Deterministic, no LLM.
 * Returns `{ triples, provenance, subjectIri }`. Empty arrays are valid
 * — a Markdown document with no frontmatter, no wikilinks, no tags, no
 * dataview fields, and no headings produces zero triples.
 */
export function extractFromMarkdown(input: MarkdownExtractInput): MarkdownExtractOutput {
  const triples: Quad[] = [];
  const now = input.now ?? new Date();

  const { frontmatter, body } = splitFrontmatter(input.markdown);
  const subject = resolveSubjectIri(input, frontmatter, body);

  // ── 1. YAML frontmatter → properties ───────────────────────────────
  if (frontmatter) {
    for (const [key, value] of Object.entries(frontmatter)) {
      if (key === 'id') continue; // already used as subject identifier
      if (key === 'type') {
        const typeIri = resolveTypeIri(value);
        if (typeIri) triples.push({ subject, predicate: RDF_TYPE, object: typeIri });
        continue;
      }
      // Array values emit one triple per element.
      const values = Array.isArray(value) ? value : [value];
      for (const v of values) {
        const obj = resolveFrontmatterValue(v);
        if (obj === null) continue;
        const predicate = frontmatterKeyToPredicate(key);
        triples.push({ subject, predicate, object: obj });
      }
    }
  }

  // Promote first H1 → schema:name if no explicit name triple exists.
  const h1 = findFirstH1(body);
  if (h1 && !triples.some(q => q.predicate === SCHEMA_NAME)) {
    triples.push({ subject, predicate: SCHEMA_NAME, object: JSON.stringify(h1) });
  }

  // ── 2. Wikilinks → schema:mentions ─────────────────────────────────
  for (const target of extractWikilinks(body)) {
    triples.push({ subject, predicate: SCHEMA_MENTIONS, object: target });
  }

  // ── 3. Hashtags → schema:keywords ──────────────────────────────────
  for (const tag of extractHashtags(body)) {
    triples.push({ subject, predicate: SCHEMA_KEYWORDS, object: JSON.stringify(tag) });
  }

  // ── 4. Dataview inline fields → properties ─────────────────────────
  for (const { key, value } of extractDataviewFields(body)) {
    const predicate = frontmatterKeyToPredicate(key);
    const obj = /^(https?:|did:|urn:)/.test(value) ? value : JSON.stringify(value);
    triples.push({ subject, predicate, object: obj });
  }

  // ── 5. Headings → dkg:hasSection ───────────────────────────────────
  for (const heading of extractHeadings(body)) {
    if (heading.level === 1) continue; // H1 is the document title, not a section
    const sectionIri = `${subject}#section-${slugify(heading.text)}`;
    triples.push({ subject, predicate: DKG_HAS_SECTION, object: sectionIri });
    triples.push({ subject: sectionIri, predicate: SCHEMA_NAME, object: JSON.stringify(heading.text) });
  }

  // ── Provenance ─────────────────────────────────────────────────────
  const provenance = buildProvenance({
    subject,
    agentDid: input.agentDid,
    tripleCount: triples.length,
    now,
  });

  return { triples, provenance, subjectIri: subject };
}

function frontmatterKeyToPredicate(key: string): string {
  if (key === 'name' || key === 'title') return SCHEMA_NAME;
  if (key === 'description' || key === 'summary') return SCHEMA_DESCRIPTION;
  if (key === 'keywords' || key === 'tags') return SCHEMA_KEYWORDS;
  // Unknown keys fall back into the schema.org namespace (same convention as `type`).
  return `http://schema.org/${key}`;
}

function buildProvenance(args: {
  subject: string;
  agentDid: string;
  tripleCount: number;
  now: Date;
}): Quad[] {
  if (args.tripleCount === 0) return [];
  const provIri = `urn:dkg:extraction:${slugify(args.subject)}-${args.now.getTime()}`;
  const xsdDateTime = `"${args.now.toISOString()}"^^<${XSD_DATE_TIME}>`;
  return [
    { subject: provIri, predicate: RDF_TYPE, object: DKG_EXTRACTION_PROVENANCE },
    { subject: provIri, predicate: DKG_EXTRACTED_BY, object: args.agentDid },
    { subject: provIri, predicate: DKG_EXTRACTION_RULE, object: JSON.stringify('markdown-structural-v1') },
    { subject: provIri, predicate: DKG_EXTRACTED_AT, object: xsdDateTime },
    { subject: provIri, predicate: DKG_DERIVED_FROM, object: args.subject },
    { subject: args.subject, predicate: PROV_WAS_GENERATED_BY, object: provIri },
  ];
}
