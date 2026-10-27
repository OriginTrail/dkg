/**
 * A concept body read as Markdown, with a real AST (`mdast-util-from-markdown`),
 * which is what lets a link inside an inline code span stay literal text, as
 * CommonMark has it: the body's headings, the links in its prose, the links
 * written inside code spans, the citations of a legacy `# Citations` section
 * and its footnote references. The importer maps them to sections, edges,
 * citations and diagnostics (`mapping.ts`); the exporter reads a stored body
 * the same way, to tell which of a graph's edges and citations it expresses
 * (`export.ts`).
 */

import { fromMarkdown } from 'mdast-util-from-markdown';
import { toString as mdToString } from 'mdast-util-to-string';
import type { Nodes, Link, InlineCode, Text } from 'mdast';
import { resolveLinkTarget } from './paths.js';
import type { OkfCitation } from './types.js';

const BARE_URL_RE = /https?:\/\/[^\s)<>"]+/g;
const INLINE_LINK_RE = /\[[^\]]*\]\(([^)\s]+)\)/g;
/** A footnote *reference* `[^label]` (not a definition `[^label]: …`), SPEC §5.1 per-claim attribution. */
const FOOTNOTE_REF_RE = /\[\^([^\]\s]+)\](?!:)/g;

export interface ParsedBody {
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
 * The bundle paths a body links to, as the importer reads its links: every
 * link in its prose and, with `includeCodeSpanLinks`, every link inside a code
 * span, resolved against the concept (`resolveLinkTarget`). Each one that
 * names a concept of the bundle is an edge.
 */
export function linkedConceptIds(parsed: ParsedBody, conceptId: string, includeCodeSpanLinks: boolean): Set<string> {
  const hrefs = includeCodeSpanLinks ? [...parsed.bodyLinks, ...parsed.codeSpanHrefs] : parsed.bodyLinks;
  const ids = new Set<string>();
  for (const href of hrefs) {
    const candidate = resolveLinkTarget(href, conceptId);
    if (candidate) ids.add(candidate);
  }
  return ids;
}
