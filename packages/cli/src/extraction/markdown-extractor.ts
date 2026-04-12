/**
 * Phase 2 of document ingestion: deterministic structural extraction
 * from a Markdown intermediate to RDF triples + source-file linkage.
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
 * When `sourceFileIri` is provided the extractor emits the §10.1 data-
 * graph linkage triples it owns — specifically row 1
 * (`<entityUri> dkg:sourceFile <fileUri>`) and row 3
 * (`<entityUri> dkg:rootEntity <resolvedRootEntity>`). These come back
 * in the `sourceFileLinkage` return field so the daemon can keep them
 * distinct from content triples before merging them into the
 * assertion graph. The field was renamed from `provenance` in Round 13
 * Bug 39 to remove the semantic clash with its original
 * extraction-run-metadata meaning.
 *
 * Row 2 (`<entityUri> dkg:sourceContentType "<original-mime>"`) is
 * owned by the daemon (Round 9 Bug 1 / Round 9 Bug 27 rulings), not
 * this module — only the daemon has access to the original upload
 * content type that row 2 must describe. The daemon emits row 2
 * alongside the extractor's rows 1 and 3 in the same atomic insert.
 *
 * Rows 4-13 (file descriptor block + ExtractionProvenance resource
 * described in §3.2/§10.2) are also daemon-owned — the daemon has
 * natural access to the UAL, the fresh provenance URI, the agent DID,
 * and the `_meta` writes. This module stays free of `_meta` /
 * extraction-run concerns.
 *
 * Spec: 05_PROTOCOL_EXTENSIONS.md §6.3 / §6.5, 19_MARKDOWN_CONTENT_TYPE.md §10
 */

import { createHash } from 'node:crypto';
import { load as loadYaml } from 'js-yaml';
import { isSafeIri, type ExtractionQuad as Quad } from '@origintrail-official/dkg-core';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SCHEMA_NAME = 'http://schema.org/name';
const SCHEMA_DESCRIPTION = 'http://schema.org/description';
const SCHEMA_MENTIONS = 'http://schema.org/mentions';
const SCHEMA_KEYWORDS = 'http://schema.org/keywords';
const DKG_HAS_SECTION = 'http://dkg.io/ontology/hasSection';
const DKG_SOURCE_FILE = 'http://dkg.io/ontology/sourceFile';
const DKG_ROOT_ENTITY = 'http://dkg.io/ontology/rootEntity';
const XSD_BOOLEAN = 'http://www.w3.org/2001/XMLSchema#boolean';
const XSD_DATE = 'http://www.w3.org/2001/XMLSchema#date';
const XSD_DATE_TIME = 'http://www.w3.org/2001/XMLSchema#dateTime';
const XSD_DECIMAL = 'http://www.w3.org/2001/XMLSchema#decimal';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';

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
  /**
   * IRI of the source blob this markdown was extracted from, in the form
   * `urn:dkg:file:keccak256:<hex>`. When set, the extractor emits the
   * §10.1 `dkg:sourceFile` linkage quad (row 1) with `<entityUri>` as
   * subject and this URI as object.
   *
   * The file descriptor block (rows 4-8) is subsequently filtered out of
   * `assertionPromote`'s root-entity partition via a subject-prefix
   * filter on `urn:dkg:file:` in `packages/publisher/src/dkg-publisher.ts`
   * — that's how we prevent cross-assertion contention without using
   * blank-node subjects. See `19_MARKDOWN_CONTENT_TYPE.md §10.2` for the
   * normative rule and spec-engineer's reconciled ruling on Codex Bug 8
   * for the history (Round 3 tried blank nodes; Round 4 reverted to URI
   * subjects + promote-time filter after an `autoPartition` audit showed
   * the blank-node approach silently drops the ExtractionProvenance
   * block, which is a correctness smell).
   */
  sourceFileIri?: string;
  /**
   * Explicit root-entity IRI override. In V10.0 this is usually the
   * document subject IRI itself (`<entityUri> dkg:rootEntity <entityUri>`).
   * If the frontmatter carries a `rootEntity` key with a string value it
   * takes precedence over both the input and the subject default; see
   * §19.10.1:508. The resolved value is returned on
   * `MarkdownExtractOutput.resolvedRootEntity` so the daemon can reuse it
   * for the `_meta` row 14 write without re-resolving.
   */
  rootEntityIri?: string;
  /**
   * Optional timestamp reserved for future extraction-run metadata
   * (defaults to now when eventually used). Currently unused — the
   * extractor no longer emits extraction-run provenance since that
   * moved to the daemon's route handler in Round 9 Bug 27. Callers
   * may still pass this for forward compatibility, but it is not
   * consumed by any code path today.
   */
  now?: Date;
}

export interface MarkdownExtractOutput {
  /** Extracted RDF triples describing the document content. */
  triples: Quad[];
  /**
   * §10.1 source-file linkage quads on the document subject. Emits rows
   * 1 and 3 (`dkg:sourceFile` + `dkg:rootEntity`); row 2
   * (`dkg:sourceContentType`) is owned by the daemon because it has the
   * original upload content type and the extractor does not. Empty when
   * `sourceFileIri` is not supplied. The daemon merges these into the
   * same data graph as `triples` before committing.
   *
   * Round 13 Bug 39: renamed from `provenance` to `sourceFileLinkage`.
   * The original field at module introduction (`ff8afe3`) was
   * "`dkg:ExtractionProvenance` blank-identifier records for every
   * extracted triple" — extraction-run metadata (agent, timestamp,
   * method). The PR #121 chain repurposed the field to hold source-
   * file linkage triples, creating a semantic clash with the old
   * meaning. Round 9 Bug 27 moved the extraction-run provenance rows
   * (9-13 on the `<urn:dkg:extraction:uuid>` subject) to the daemon's
   * route handler, so the extractor no longer produces ANY
   * extraction-run metadata — only source-file linkage. Renaming
   * makes the contract honest: this field contains linkage triples,
   * full stop.
   */
  sourceFileLinkage: Quad[];
  /** The subject IRI used for the document (useful to the caller for indexing). */
  subjectIri: string;
  /**
   * The resolved root-entity IRI, following the §19.10.1:508 precedence
   * rules: frontmatter `rootEntity` key > explicit `rootEntityIri` input >
   * reflexive fallback to the document subject. The daemon reuses this
   * value as the object of the `_meta` row 14 quad so the data-graph row 3
   * and `_meta` row 14 stay in sync without the daemon re-running the
   * resolution logic.
   */
  resolvedRootEntity: string;
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
  const m = stripCodeFences(body).match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : null;
}

/**
 * Slugify a string for use in an IRI fragment. Keeps alphanumerics and hyphens.
 */
function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  if (slug.length > 0) return slug;
  return `hash-${shortHash(input)}`;
}

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}

// Issue #123 / Round 11 Bug 33 follow-up: user-content extraction paths
// (`type`, generic frontmatter scalars, Dataview inline values) should
// treat ANY absolute scheme-based IRI as eligible, then use `isSafeIri`
// as the strictness gate. Narrow allowlists silently rewrote valid IRIs
// like `tag:` / `doi:` / `ark:`, while unchecked allowlist hits could
// pass malformed `urn:x y` values through raw.
const ABSOLUTE_IRI_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

function looksLikeAbsoluteIri(value: string): boolean {
  return ABSOLUTE_IRI_SCHEME_RE.test(value);
}

function resolveSafeAbsoluteIri(value: string): string | null {
  if (!looksLikeAbsoluteIri(value)) return null;
  return isSafeIri(value) ? value : null;
}

function typedLiteral(lexicalForm: string, datatypeIri: string): string {
  return `${JSON.stringify(lexicalForm)}^^<${datatypeIri}>`;
}

function normalizeSchemaLocalName(raw: string, kind: 'property' | 'class'): string | null {
  const stripped = raw.trim().replace(/\(([^)]*)\)/g, '$1');
  if (stripped.length === 0) return null;

  const asciiTokens = stripped.match(/[A-Za-z0-9]+/g);
  if (asciiTokens && asciiTokens.length > 0) {
    return asciiTokens
      .map((token, index) => {
        if (kind === 'property' && index === 0) {
          return token[0]!.toLowerCase() + token.slice(1);
        }
        return token[0]!.toUpperCase() + token.slice(1);
      })
      .join('');
  }

  const encoded = encodeURIComponent(stripped);
  return encoded.length > 0 ? encoded : null;
}

/**
 * Resolve a stable subject IRI for the document:
 *   1. explicit `documentIri` argument, or
 *   2. frontmatter `id` (if it looks like an IRI or a slug), or
 *   3. slugified first H1 heading with an `urn:dkg:md:` prefix, or
 *   4. stable fallback `urn:dkg:md:anonymous-{short-hash}` derived from the full body.
 */
function resolveSubjectIri(
  input: MarkdownExtractInput,
  frontmatter: Record<string, unknown> | null,
  body: string,
): string {
  if (input.documentIri && input.documentIri.length > 0) return input.documentIri;

  const fmId = frontmatter?.['id'];
  if (typeof fmId === 'string' && fmId.length > 0) {
    // Round 11 Bug 33 + Round 10 Bug 30 preempt: use `isSafeIri` as the
    // single source-of-truth "is this an IRI" check. Previous rounds
    // used a narrow regex allowlist `^(https?:|did:|urn:|_:)` which
    // (a) accepted `_:foo` blank nodes even though `isSafeIri` rejects
    // them — contradicting spec §19.10.2:628-629 / §03 §1 non-blank-node
    // Entity-hood, and (b) silently slugified valid IRIs whose schemes
    // fell outside the allowlist, e.g. `tag:origintrail.org,2026:paper`
    // or `doi:10.1000/xyz`. The spec defines the contract as "scheme-
    // based IRI" without restricting schemes; the only exclusions are
    // blank nodes (RDF 1.1 §3.4 — not IRIs) and reserved protocol
    // namespaces (§19.10.2:708-723). `isSafeIri` matches that contract.
    if (isSafeIri(fmId)) return fmId;
    return `urn:dkg:md:${slugify(fmId)}`;
  }

  const h1 = findFirstH1(body);
  if (h1) return `urn:dkg:md:${slugify(h1)}`;

  return `urn:dkg:md:anonymous-${shortHash(body)}`;
}

/** Resolve a value from a frontmatter `type` field to a full IRI. */
function resolveTypeIri(typeValue: unknown): string | null {
  if (typeof typeValue !== 'string' || typeValue.length === 0) return null;
  if (looksLikeAbsoluteIri(typeValue)) return resolveSafeAbsoluteIri(typeValue);
  // Treat bare identifiers as schema.org classes by convention (Report, Person, etc.)
  const localName = normalizeSchemaLocalName(typeValue, 'class');
  return localName ? `http://schema.org/${localName}` : null;
}

/** Resolve a frontmatter scalar value to a triple object literal or IRI. */
function resolveFrontmatterValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const iri = resolveSafeAbsoluteIri(value);
    if (iri) return iri;
    return JSON.stringify(value);
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const isUtcDateOnly =
      value.getUTCHours() === 0
      && value.getUTCMinutes() === 0
      && value.getUTCSeconds() === 0
      && value.getUTCMilliseconds() === 0;
    return isUtcDateOnly
      ? typedLiteral(value.toISOString().slice(0, 10), XSD_DATE)
      : typedLiteral(value.toISOString(), XSD_DATE_TIME);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return Number.isInteger(value)
      ? typedLiteral(String(value), XSD_INTEGER)
      : typedLiteral(String(value), XSD_DECIMAL);
  }
  if (typeof value === 'boolean') {
    return typedLiteral(value ? 'true' : 'false', XSD_BOOLEAN);
  }
  return null;
}

/** Extract wikilinks `[[Target]]` or `[[Target|Alt]]` → IRIs using the `urn:dkg:md:` namespace. */
function extractWikilinks(body: string): string[] {
  const out = new Set<string>();
  const noFences = stripCodeFences(body);
  const re = /\[\[([^\]|#]+?)(?:#[^\]|]*)?(?:\|[^\]]*?)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(noFences)) !== null) {
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
 * Extract Dataview inline fields: `key:: value` anywhere in a visible line.
 * Returns key-value pairs with raw string values; the caller translates to triples.
 */
function extractDataviewFields(body: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  const noFences = stripCodeFences(body);
  for (const line of noFences.split(/\r?\n/)) {
    const re = /(?:^|[^\w])([a-zA-Z][\w-]*)::\s*(.+?)(?=(?:\s+[a-zA-Z][\w-]*::)|$)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      out.push({ key: m[1], value: m[2].trim() });
    }
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
  const lines = body.split(/\r?\n/);
  const keptLines: string[] = [];
  let activeFence: { char: '`' | '~'; length: number } | null = null;

  for (const line of lines) {
    const trimmedEnd = line.trimEnd();
    const fenceMatch = trimmedEnd.match(/^ {0,3}(([`~])\2{2,})(.*)$/);

    if (!activeFence) {
      if (fenceMatch) {
        activeFence = {
          char: fenceMatch[2] as '`' | '~',
          length: fenceMatch[1].length,
        };
        continue;
      }
      keptLines.push(line);
      continue;
    }

    if (
      fenceMatch
      && fenceMatch[2] === activeFence.char
      && fenceMatch[1].length >= activeFence.length
      && fenceMatch[3].trim().length === 0
    ) {
      activeFence = null;
    }
  }

  return keptLines.join('\n');
}

/**
 * Run the full Phase 2 structural extraction. Deterministic, no LLM.
 * Returns `{ triples, sourceFileLinkage, subjectIri, resolvedRootEntity }`. Empty arrays are valid
 * — a Markdown document with no frontmatter, no wikilinks, no tags, no
 * dataview fields, and no headings produces zero triples.
 */
export function extractFromMarkdown(input: MarkdownExtractInput): MarkdownExtractOutput {
  const triples: Quad[] = [];

  const { frontmatter, body } = splitFrontmatter(input.markdown);
  const subject = resolveSubjectIri(input, frontmatter, body);

  // ── 1. YAML frontmatter → properties ───────────────────────────────
  if (frontmatter) {
    for (const [key, value] of Object.entries(frontmatter)) {
      if (key === 'id') continue; // already used as subject identifier
      if (key === 'rootEntity') continue; // consumed as a linkage override below
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
        if (predicate === null) continue;
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
    if (predicate === null) continue;
    const obj = resolveSafeAbsoluteIri(value) ?? JSON.stringify(value);
    triples.push({ subject, predicate, object: obj });
  }

  // ── 5. Headings → dkg:hasSection ───────────────────────────────────
  let sectionIndex = 0;
  const sectionStack: Array<{ level: number; iri: string }> = [];
  for (const heading of extractHeadings(body)) {
    if (heading.level === 1) continue; // H1 is the document title, not a section
    sectionIndex += 1;
    const sectionIri = `${subject}#section-${sectionIndex}-${slugify(heading.text)}`;
    while (sectionStack.length > 0 && sectionStack[sectionStack.length - 1]!.level >= heading.level) {
      sectionStack.pop();
    }
    const parentSection = sectionStack.length > 0
      ? sectionStack[sectionStack.length - 1]!.iri
      : subject;
    triples.push({ subject: parentSection, predicate: DKG_HAS_SECTION, object: sectionIri });
    triples.push({ subject: sectionIri, predicate: SCHEMA_NAME, object: JSON.stringify(heading.text) });
    sectionStack.push({ level: heading.level, iri: sectionIri });
  }

  // ── §10.1 source-file linkage (data graph) ─────────────────────────
  const { quads: sourceFileLinkage, resolvedRootEntity } = buildSourceFileLinkage({
    subject,
    frontmatter,
    sourceFileIri: input.sourceFileIri,
    rootEntityIri: input.rootEntityIri,
  });

  return { triples, sourceFileLinkage, subjectIri: subject, resolvedRootEntity };
}

function frontmatterKeyToPredicate(key: string): string | null {
  if (key === 'name' || key === 'title') return SCHEMA_NAME;
  if (key === 'description' || key === 'summary') return SCHEMA_DESCRIPTION;
  if (key === 'keywords' || key === 'tags') return SCHEMA_KEYWORDS;
  // Unknown keys fall back into the schema.org namespace (same convention as `type`).
  const localName = normalizeSchemaLocalName(key, 'property');
  return localName ? `http://schema.org/${localName}` : null;
}

/**
 * Build the `19_MARKDOWN_CONTENT_TYPE.md §10.1` source-file linkage quads
 * on the document subject, plus compute the resolved root-entity IRI.
 *
 * The extractor is responsible for rows 1 and 3 of the Phase A table.
 * Row 2 (`dkg:sourceContentType`) is owned by the daemon: the extractor
 * only ever processes markdown (even for PDF uploads, where the
 * markdown intermediate is what it sees), but row 2 must describe the
 * ORIGINAL blob pointed at by row 1. Only the daemon has that value, so
 * it emits row 2 itself alongside the file descriptor block.
 *
 *   Row 1: `<entityUri> dkg:sourceFile  <urn:dkg:file:keccak256:...>`
 *   Row 3: `<entityUri> dkg:rootEntity  <resolvedRootEntity>`
 *
 * Row 1's object is a content-addressed URI (`urn:dkg:file:keccak256:<hex>`).
 * Cross-assertion promote contention on that subject is prevented by a
 * subject-prefix filter in `packages/publisher/src/dkg-publisher.ts`
 * `assertionPromote` that excludes `urn:dkg:file:` and `urn:dkg:extraction:`
 * subjects from the partition before `autoPartition` runs. See Codex
 * Bug 8 Round 4 reconciled ruling for the history — Round 3 tried blank
 * nodes but an `autoPartition` audit showed they silently drop the
 * ExtractionProvenance block on promote, which was a correctness smell.
 *
 * `resolvedRootEntity` follows the §19.10.1:508 precedence rules:
 *   1. frontmatter `rootEntity` key (string) — honored regardless of
 *      whether source-file linkage was requested, since the caller may
 *      still want the resolved value for other purposes. IRI-shaped
 *      values are validated via `isSafeIri` to reject malformed inputs
 *      (Codex Bug 13); non-IRI values fall through to slugification.
 *   2. explicit `rootEntityIri` input.
 *   3. reflexive fallback: the document subject itself.
 */
function buildSourceFileLinkage(args: {
  subject: string;
  frontmatter: Record<string, unknown> | null;
  sourceFileIri: string | undefined;
  rootEntityIri: string | undefined;
}): { quads: Quad[]; resolvedRootEntity: string } {
  // Round 7 Bug 20: symmetric validation for the PROGRAMMATIC override
  // inputs. The frontmatter `rootEntity` path already validates via
  // `isSafeIri` (Round 4 Bug 13), but `rootEntityIri` and `sourceFileIri`
  // came through untrusted until now — an internal caller (including
  // the daemon itself if a hash computation ever drifts) could pass
  // `''`, `foo`, or `http://x>y` and get malformed linkage quads that
  // only fail later at store insert with a cryptic RDF parse error.
  // Reject non-IRIs the same way as the frontmatter path: empty string,
  // missing IRI scheme prefix, or failed `isSafeIri` check → throw a
  // clear `Invalid '<field>' IRI` error that the daemon surfaces as 400.
  //
  // Round 10 Bug 30 + Round 11 Bug 33: `rootEntity` / `sourceFileIri`
  // MUST be scheme-based IRIs per `19_MARKDOWN_CONTENT_TYPE.md
  // §10.2:628-629` (`dkg:rootEntity is an IRI`) AND the reserved-
  // namespaces rule at §10.2:708-723. The spec defines the contract
  // as "scheme-based IRI" WITHOUT restricting schemes — the only
  // exclusions are blank nodes (RDF 1.1 §3.4 — not IRIs, also
  // excluded from Entity-hood per `03_PROTOCOL_CORE.md §1`) and
  // reserved protocol namespaces (§10.2:708-723, guarded at the
  // publisher write-boundary via `rejectReservedSubjectPrefixes`).
  //
  // Earlier rounds used a narrow regex allowlist
  // `^(https?:|did:|urn:)` which silently rejected valid absolute
  // IRIs with other schemes (e.g. `tag:origintrail.org,2026:paper`,
  // `doi:10.1000/xyz`, `info:lccn/2005029870`) — users who supplied
  // such IRIs as `rootEntityIri` got an `Invalid 'rootEntityIri'`
  // rejection even though `isSafeIri` would have accepted them.
  // The fix: drop the narrow regex, use `isSafeIri` as the single
  // source-of-truth "is this an IRI" check. It already rejects
  // empty strings, malformed values, AND blank nodes per its spec.
  if (args.rootEntityIri !== undefined) {
    if (!isSafeIri(args.rootEntityIri)) {
      throw new Error(
        `Invalid 'rootEntityIri' input: ${JSON.stringify(args.rootEntityIri)}. ` +
          `Expected a scheme-based IRI such as urn:note:foo, http://example.com/bar, ` +
          `or tag:example.org,2026:paper. Any absolute IRI scheme is accepted as long ` +
          `as the value contains no spaces, angle brackets, quotes, or control ` +
          `characters. Blank nodes (_:foo) are not accepted — per ` +
          `19_MARKDOWN_CONTENT_TYPE.md §10.2, rootEntity must be an IRI.`,
      );
    }
  }
  if (args.sourceFileIri !== undefined) {
    if (!isSafeIri(args.sourceFileIri)) {
      throw new Error(
        `Invalid 'sourceFileIri' input: ${JSON.stringify(args.sourceFileIri)}. ` +
          `Expected a scheme-based IRI such as urn:dkg:file:keccak256:abc, ` +
          `http://example.com/file, or tag:example.org,2026:doc. Any absolute IRI ` +
          `scheme is accepted as long as the value contains no spaces, angle brackets, ` +
          `quotes, or control characters. Blank nodes (_:foo) are not accepted — per ` +
          `19_MARKDOWN_CONTENT_TYPE.md §10.2, sourceFile must be an IRI.`,
      );
    }
  }

  // Resolve the root entity regardless of whether linkage quads will be
  // emitted. Frontmatter wins, then explicit input, then reflexive default.
  //
  // Round 11 Bug 33: broaden scheme detection from a narrow allowlist
  // `^(https?:|did:|urn:)` to the RFC 3986 generic scheme pattern
  // `^[a-zA-Z][a-zA-Z0-9+.-]*:`. The narrow allowlist silently
  // slugified valid IRIs with other schemes — Codex's cited example:
  // `rootEntity: tag:origintrail.org,2026:paper` was rewritten into
  // `urn:dkg:md:tag-origintrail-org-2026-paper` instead of being
  // preserved as the caller-intended IRI. Any scheme `isSafeIri`
  // accepts is now preserved (tag:, doi:, info:, etc.), matching the
  // programmatic `rootEntityIri` path for contract consistency.
  //
  // Round 4 Bug 13 semantics preserved: values that LOOK like IRI
  // attempts (scheme-prefixed) but fail `isSafeIri` still throw
  // loudly with a clear `Invalid frontmatter 'rootEntity' IRI`
  // message — e.g. `urn:x y` (embedded space) or `http://x>y`
  // (angle bracket). Values that don't look like IRI attempts
  // (plain text with no scheme prefix) still slugify as before.
  //
  // Round 10 Bug 30: blank nodes (`_:foo`) do NOT match the RFC 3986
  // scheme production (which requires `[a-zA-Z]` first — `_` is not
  // in that class), so they fall through to slugification rather
  // than being accepted as pseudo-IRIs. This matches spec §10.2
  // (rootEntity must be an IRI, not a blank node).
  let resolvedRootEntity: string = args.rootEntityIri ?? args.subject;
  const fmRoot = args.frontmatter?.['rootEntity'];
  if (typeof fmRoot === 'string' && fmRoot.length > 0) {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(fmRoot)) {
      // Looks like an IRI attempt — validate strictly.
      if (!isSafeIri(fmRoot)) {
        throw new Error(
          `Invalid frontmatter 'rootEntity' IRI: ${JSON.stringify(fmRoot)}. ` +
            `Scheme-prefixed values must be safe IRIs ` +
            `(no spaces, angle brackets, quotes, or control characters). ` +
            `Any absolute IRI scheme is accepted (http, https, did, urn, ` +
            `tag, doi, info, etc.). Blank nodes (_:foo) are not accepted — ` +
            `per 19_MARKDOWN_CONTENT_TYPE.md §10.2, rootEntity must be an IRI.`,
        );
      }
      resolvedRootEntity = fmRoot;
    } else {
      resolvedRootEntity = `urn:dkg:md:${slugify(fmRoot)}`;
    }
  }

  if (!args.sourceFileIri) {
    return { quads: [], resolvedRootEntity };
  }

  const quads: Quad[] = [
    // Row 1 — points at the content-addressed file URN
    { subject: args.subject, predicate: DKG_SOURCE_FILE, object: args.sourceFileIri },
    // Row 3 — resolved root entity (reflexive or frontmatter/explicit override)
    { subject: args.subject, predicate: DKG_ROOT_ENTITY, object: resolvedRootEntity },
  ];

  return { quads, resolvedRootEntity };
}
