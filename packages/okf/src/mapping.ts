/**
 * Deterministic OKF concept → RDF mapping (no LLM, no network).
 *
 * One OKF concept document maps to one Knowledge Asset subject IRI plus a set
 * of content + linkage quads. The mapping reuses the node Markdown extractor's
 * predicate vocabulary (so an OKF import and a native Markdown import converge),
 * with the OKF-specific deltas recorded in `docs/adr/0005-okf-rdf-mapping.md`:
 *
 *   - body links are real Markdown links `[text](path)` (OKF §6), NOT the
 *     extractor's `[[wikilinks]]`, so we resolve them with a real Markdown AST
 *     (`mdast-util-from-markdown`) — which is also what lets us honour the
 *     CommonMark rule that a link inside an inline code span is literal text;
 *   - OKF concept titles live in frontmatter, so body headings (including `#`
 *     H1s like `# Schema`) are genuine sections → `dkg:hasSection`;
 *   - `generated.at` (v0.2 §5.2), or the legacy v0.1 `timestamp` it supersedes
 *     (§13.1), is the last-modified time → `schema:dateModified`;
 *   - the v0.2 provenance / trust / lifecycle / attestation families (§5, §10)
 *     are mapped by `families.ts` — flat predicates for single values, one
 *     skolemized node per list entry, typed edges for bundle paths.
 */

import { fromMarkdown } from 'mdast-util-from-markdown';
import { toString as mdToString } from 'mdast-util-to-string';
import type { Nodes, Link, InlineCode, Text } from 'mdast';
import {
  RDF_TYPE,
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
  GENID_TAGS,
  DEFAULT_IRI_BASE,
} from './constants.js';
import { conceptIdToIri, resolveLinkTarget } from './paths.js';
import { isSafeIri, literalTerm, sanitizeForBlank } from './utils.js';
import {
  typeToIri,
  dateTerm,
  genericQuads,
  isAttestedComputationType,
  isMapping,
  toArray,
  type PathContext,
} from './terms.js';
import { V02_FAMILY_KEYS, familyQuads, familyDiagnostics, sourceIds, declaresSources } from './families.js';
import { dateTimeLexical, deriveTrustTier, normalizeVerified, conceptStatus } from './trust.js';
import type {
  OkfDocument,
  OkfMappingOptions,
  ConceptMapping,
  ConceptTrust,
  Quad,
  OkfLink,
  OkfCitation,
  OkfWarning,
} from './types.js';

const BARE_URL_RE = /https?:\/\/[^\s)<>"]+/g;
const INLINE_LINK_RE = /\[[^\]]*\]\(([^)\s]+)\)/g;
/** A footnote *reference* `[^label]` (not a definition `[^label]: …`), SPEC §5.1 per-claim attribution. */
const FOOTNOTE_REF_RE = /\[\^([^\]\s]+)\](?!:)/g;

/**
 * Display bound for section names (OT-RFC-56 §4.6). Headings are headings —
 * anything longer is a markdown-parse artifact (a huge single-line document
 * surfaces its whole body as one "heading"), and un-truncated it becomes an
 * oversized RDF literal the DKG's replicated graphs must refuse (the
 * 2026-07-08 mainnet 177KB `schema:name` poison was exactly this shape).
 * 2,048 chars ≤ 6,144 MUTF-8 bytes — far below the 60,000-byte protocol
 * limit. Frontmatter fields are NOT truncated: they are author-controlled
 * structured data, and the daemon's guarded import routes reject oversized
 * values there with a caller-correctable error.
 */
const SECTION_NAME_MAX_CHARS = 2_048;
function truncateSectionName(text: string): string {
  if (text.length <= SECTION_NAME_MAX_CHARS) return text;
  return `${text.slice(0, SECTION_NAME_MAX_CHARS - 1)}…`;
}

/** Optional bundle context for frontmatter mapping (needed to resolve path-valued fields to concepts). */
export interface FrontmatterContext {
  /** The concept's ID; derived from `iri` when omitted. */
  conceptId?: string;
  /** IRI namespace the bundle's concepts were minted under. Default `urn:okf:`. */
  iriBase?: string;
  /** Membership test for bundle concepts. Default: nothing resolves (paths stay literals). */
  conceptExists?: (conceptId: string) => boolean;
}

export interface FrontmatterMapping {
  quads: Quad[];
  /** Bundle concepts named by `sources[].resource` (sorted, unique). */
  derivedFromConcepts: string[];
  /** Context-dependent diagnostics (unresolved bundle paths). */
  warnings: OkfWarning[];
}

/** Map the YAML frontmatter to quads (SPEC §4.1, §5, §10; see the locked table in ADR 0005 / CONTEXT.md). */
export function mapFrontmatter(
  iri: string,
  frontmatter: Record<string, unknown>,
  ctx: FrontmatterContext = {},
): FrontmatterMapping {
  const iriBase = ctx.iriBase ?? DEFAULT_IRI_BASE;
  const pathCtx: PathContext = {
    conceptId: ctx.conceptId ?? (iri.startsWith(iriBase) ? iri.slice(iriBase.length) : iri),
    iriBase,
    conceptExists: ctx.conceptExists ?? (() => false),
  };
  const out: Quad[] = [];
  const derived: string[] = [];
  const warnings: OkfWarning[] = [];
  // v0.2 `generated.at` supersedes the v0.1 `timestamp` (§13.1).
  const generatedAt = isMapping(frontmatter.generated) ? dateTimeLexical(frontmatter.generated.at) : null;

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
        out.push({ subject: iri, predicate: SCHEMA_DESCRIPTION, object: literalTerm(String(value)) });
        break;
      case 'tags':
        for (const tag of toArray(value)) {
          out.push({ subject: iri, predicate: SCHEMA_KEYWORDS, object: literalTerm(String(tag)) });
        }
        break;
      case 'timestamp': {
        // Legacy v0.1 last-modified (§13.1). When `generated.at` is present it
        // wins; the leftover `timestamp` is then preserved as a producer key.
        if (generatedAt !== null) {
          out.push(...genericQuads(iri, key, value));
          break;
        }
        const t = dateTerm(value);
        if (t) out.push({ subject: iri, predicate: SCHEMA_DATE_MODIFIED, object: t });
        break;
      }
      case 'resource': {
        const r = String(value);
        out.push({ subject: iri, predicate: SCHEMA_URL, object: isSafeIri(r) ? r : literalTerm(r) });
        break;
      }
      default: {
        if (V02_FAMILY_KEYS.has(key)) {
          const r = familyQuads(iri, key, value, frontmatter, pathCtx);
          out.push(...r.quads);
          derived.push(...r.derivedFromConcepts);
          warnings.push(...r.warnings);
        } else {
          // Producer-defined keys — preserved, never dropped (SPEC §4.1/§11).
          out.push(...genericQuads(iri, key, value));
        }
      }
    }
  }
  return { quads: out, derivedFromConcepts: [...new Set(derived)].sort(), warnings };
}

/** Quads-only view of `mapFrontmatter` (kept for API compatibility). */
export function frontmatterQuads(
  iri: string,
  frontmatter: Record<string, unknown>,
  ctx?: FrontmatterContext,
): Quad[] {
  return mapFrontmatter(iri, frontmatter, ctx).quads;
}

/** The §5 / §10 summary a consumer derives from frontmatter (deterministic; staleness excluded — see `isStale`). */
export function summarizeTrust(
  frontmatter: Record<string, unknown>,
  derivedFromConcepts: string[] = [],
): ConceptTrust {
  const generated = isMapping(frontmatter.generated) ? frontmatter.generated : null;
  const by = generated?.by;
  const generatedBy = by !== undefined && by !== null && String(by).trim() !== '' ? String(by).trim() : null;
  const generatedAt = (generated ? dateTimeLexical(generated.at) : null) ?? dateTimeLexical(frontmatter.timestamp);
  const sourcesRaw: unknown[] = Array.isArray(frontmatter.sources)
    ? frontmatter.sources
    : isMapping(frontmatter.sources)
      ? [frontmatter.sources]
      : [];
  return {
    tier: deriveTrustTier(frontmatter.verified),
    status: conceptStatus(frontmatter),
    staleAfter: dateTimeLexical(frontmatter.stale_after),
    generatedBy,
    generatedAt,
    verifications: normalizeVerified(frontmatter.verified).length,
    sources: sourcesRaw.filter(isMapping).length,
    derivedFromConcepts: [...new Set(derivedFromConcepts)].sort(),
    attestedComputation: isAttestedComputationType(frontmatter.type),
  };
}

interface ParsedBody {
  headings: string[];
  /** Real Markdown links found outside the Citations section. */
  bodyLinks: string[];
  /** `[label](target)` patterns found inside inline code spans (outside Citations). */
  codeSpanHrefs: string[];
  /** Citations gathered from a legacy `# Citations` section (both styles). */
  citations: OkfCitation[];
  /** Footnote reference labels (`[^label]`) found in body text, unique, in order of first appearance. */
  footnoteRefs: string[];
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
  const footnoteRefs = new Set<string>();
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

    for (const t of texts) {
      for (const m of t.matchAll(FOOTNOTE_REF_RE)) footnoteRefs.add(m[1]);
    }

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
  return { headings, bodyLinks, codeSpanHrefs, citations, footnoteRefs: [...footnoteRefs] };
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
  const fm = mapFrontmatter(iri, doc.frontmatter, { conceptId: doc.conceptId, iriBase, conceptExists });
  const quads: Quad[] = [...fm.quads];
  const warnings: OkfWarning[] = [
    ...familyDiagnostics(doc.frontmatter).map((d) => ({ conceptId: doc.conceptId, ...d })),
    ...fm.warnings,
  ];

  const parsed = parseBody(doc.body);

  // Sections: every body heading (OKF titles live in frontmatter, so H1s count).
  // Section nodes are skolemized into deterministic concept-scoped IRIs rather
  // than emitted as RDF blank nodes: the daemon rejects blank-node *objects*
  // ("RDF object must be a quoted literal term or absolute IRI"), so a blank
  // `hasSection` object fails the first write on a strict node. The IRI uses the
  // node's own `.well-known/genid/` scheme, so the stored graph is identical.
  parsed.headings.forEach((text, i) => {
    const sectionIri = `${iri}${SECTION_GENID_INFIX}${GENID_TAGS.section}${sanitizeForBlank(doc.conceptId)}_${i}`;
    quads.push({ subject: iri, predicate: DKG_HAS_SECTION, object: sectionIri });
    // OT-RFC-56 §4.6: a markdown-parse quirk (e.g. a huge single-line
    // document) can surface an arbitrarily large string as a "heading" —
    // the exact producer bug behind the 2026-07-08 mainnet 177KB
    // `schema:name` working-memory poison. Section names are HEADINGS:
    // truncate to a sane display bound rather than failing the whole
    // import over a parse artifact.
    quads.push({ subject: sectionIri, predicate: SCHEMA_NAME, object: literalTerm(truncateSectionName(text)) });
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
      // Resolved to a bundle path that doesn't exist → broken (SPEC §6.1/§11).
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

  // Per-claim attribution (§5.1): a footnote label is the join key into
  // `sources[].id`. Only checked when the document declares `sources` at all,
  // so v0.1-style footnotes are left alone.
  if (declaresSources(doc.frontmatter)) {
    const ids = sourceIds(doc.frontmatter);
    for (const label of parsed.footnoteRefs) {
      if (ids.has(label)) continue;
      warnings.push({
        conceptId: doc.conceptId,
        code: 'unknown-footnote',
        message: `footnote [^${label}] does not match any sources[].id (§5.1 per-claim attribution)`,
      });
    }
  }

  const trust = summarizeTrust(doc.frontmatter, fm.derivedFromConcepts);

  return {
    conceptId: doc.conceptId,
    iri,
    quads,
    resolvedLinks,
    brokenLinks,
    codeSpanLinks,
    citations,
    trust,
    warnings,
  };
}
