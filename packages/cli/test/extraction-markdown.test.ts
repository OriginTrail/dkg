import { describe, it, expect } from 'vitest';
import { extractFromMarkdown } from '../src/extraction/markdown-extractor.js';

const AGENT = 'did:dkg:agent:0xAbC123';
const FIXED_NOW = new Date('2026-04-10T12:00:00Z');

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SCHEMA_NAME = 'http://schema.org/name';
const SCHEMA_DESCRIPTION = 'http://schema.org/description';
const SCHEMA_MENTIONS = 'http://schema.org/mentions';
const SCHEMA_KEYWORDS = 'http://schema.org/keywords';
const DKG_HAS_SECTION = 'http://dkg.io/ontology/hasSection';
const DKG_EXTRACTION_PROVENANCE = 'http://dkg.io/ontology/ExtractionProvenance';
const PROV_WAS_GENERATED_BY = 'http://www.w3.org/ns/prov#wasGeneratedBy';

describe('extractFromMarkdown — frontmatter', () => {
  it('extracts rdf:type from frontmatter `type` key (schema.org convention)', () => {
    const { triples, subjectIri } = extractFromMarkdown({
      markdown: `---\nid: climate-report-2026\ntype: Report\n---\n\n# Climate Report\n`,
      agentDid: AGENT,
      now: FIXED_NOW,
    });
    expect(subjectIri).toBe('urn:dkg:md:climate-report-2026');
    expect(triples).toContainEqual({
      subject: subjectIri,
      predicate: RDF_TYPE,
      object: 'http://schema.org/Report',
    });
  });

  it('extracts full IRI `type` without namespacing', () => {
    const { triples } = extractFromMarkdown({
      markdown: `---\nid: x\ntype: https://example.org/ontology/Thing\n---\n\n# X\n`,
      agentDid: AGENT,
      now: FIXED_NOW,
    });
    expect(triples.some(t => t.predicate === RDF_TYPE && t.object === 'https://example.org/ontology/Thing')).toBe(true);
  });

  it('maps `title` to schema:name and `description` to schema:description', () => {
    const { triples } = extractFromMarkdown({
      markdown: `---\nid: doc-1\ntitle: Hello World\ndescription: A short doc\n---\n\nBody.\n`,
      agentDid: AGENT,
      now: FIXED_NOW,
    });
    expect(triples).toContainEqual({ subject: 'urn:dkg:md:doc-1', predicate: SCHEMA_NAME, object: '"Hello World"' });
    expect(triples).toContainEqual({ subject: 'urn:dkg:md:doc-1', predicate: SCHEMA_DESCRIPTION, object: '"A short doc"' });
  });

  it('normalizes unsafe frontmatter keys and bare type values into safe schema IRIs', () => {
    const { triples, subjectIri } = extractFromMarkdown({
      markdown: `---\nid: doc-1\ntype: Research Report\nrelease date: 2026-04-10\nauthor(s): Alice\n---\n`,
      agentDid: AGENT,
      now: FIXED_NOW,
    });
    expect(triples).toContainEqual({
      subject: subjectIri,
      predicate: RDF_TYPE,
      object: 'http://schema.org/ResearchReport',
    });
    expect(triples).toContainEqual({
      subject: subjectIri,
      predicate: 'http://schema.org/releaseDate',
      object: '"2026-04-10T00:00:00.000Z"',
    });
    expect(triples).toContainEqual({
      subject: subjectIri,
      predicate: 'http://schema.org/authors',
      object: '"Alice"',
    });
  });

  it('emits one triple per element for array values in frontmatter', () => {
    const { triples } = extractFromMarkdown({
      markdown: `---\nid: doc\nauthors:\n  - Alice\n  - Bob\n---\n`,
      agentDid: AGENT,
      now: FIXED_NOW,
    });
    const authors = triples.filter(t => t.predicate === 'http://schema.org/authors');
    expect(authors.map(t => t.object).sort()).toEqual(['"Alice"', '"Bob"']);
  });

  it('handles numeric and boolean scalars', () => {
    const { triples } = extractFromMarkdown({
      markdown: `---\nid: doc\npageCount: 42\npublished: true\n---\n`,
      agentDid: AGENT,
      now: FIXED_NOW,
    });
    expect(triples).toContainEqual({ subject: 'urn:dkg:md:doc', predicate: 'http://schema.org/pageCount', object: '"42"' });
    expect(triples).toContainEqual({ subject: 'urn:dkg:md:doc', predicate: 'http://schema.org/published', object: '"true"' });
  });

  it('ignores frontmatter with invalid YAML (fallthrough to body)', () => {
    const { triples, subjectIri } = extractFromMarkdown({
      markdown: `---\nid: {broken yaml\n---\n\n# Fallback\n`,
      agentDid: AGENT,
      now: FIXED_NOW,
    });
    // Subject should derive from the H1 because frontmatter is rejected
    expect(subjectIri).toBe('urn:dkg:md:fallback');
    expect(triples).toContainEqual({ subject: subjectIri, predicate: SCHEMA_NAME, object: '"Fallback"' });
  });
});

describe('extractFromMarkdown — wikilinks', () => {
  it('extracts bare wikilinks', () => {
    const { triples, subjectIri } = extractFromMarkdown({
      markdown: `# Doc\n\nSee [[Alice]] and [[Bob]] for details.\n`,
      agentDid: AGENT,
      now: FIXED_NOW,
    });
    expect(triples).toContainEqual({ subject: subjectIri, predicate: SCHEMA_MENTIONS, object: 'urn:dkg:md:alice' });
    expect(triples).toContainEqual({ subject: subjectIri, predicate: SCHEMA_MENTIONS, object: 'urn:dkg:md:bob' });
  });

  it('extracts piped wikilinks `[[Target|alt]]`', () => {
    const { triples } = extractFromMarkdown({
      markdown: `# Doc\n\nSee [[Charlie Chocolate|Charlie]].\n`,
      agentDid: AGENT,
      now: FIXED_NOW,
    });
    expect(triples.some(t => t.predicate === SCHEMA_MENTIONS && t.object === 'urn:dkg:md:charlie-chocolate')).toBe(true);
  });

  it('deduplicates wikilinks', () => {
    const { triples } = extractFromMarkdown({
      markdown: `# Doc\n\n[[Alice]] [[Alice]] [[Alice]]\n`,
      agentDid: AGENT,
      now: FIXED_NOW,
    });
    const mentions = triples.filter(t => t.predicate === SCHEMA_MENTIONS);
    expect(mentions).toHaveLength(1);
  });

  it('ignores wikilinks inside code fences and derives H1 from visible markdown only', () => {
    const { triples, subjectIri } = extractFromMarkdown({
      markdown: `\`\`\`md\n# Hidden Title\n[[Hidden Target]]\n\`\`\`\n\n# Visible Title\n\nSee [[Visible Target]].\n`,
      agentDid: AGENT,
      now: FIXED_NOW,
    });
    expect(subjectIri).toBe('urn:dkg:md:visible-title');
    const mentions = triples.filter(t => t.predicate === SCHEMA_MENTIONS).map(t => t.object);
    expect(mentions).toEqual(['urn:dkg:md:visible-target']);
  });
});

describe('extractFromMarkdown — hashtags', () => {
  it('extracts hashtags as schema:keywords', () => {
    const { triples, subjectIri } = extractFromMarkdown({
      markdown: `# Doc\n\nSome text #climate #policy and more.\n`,
      agentDid: AGENT,
      now: FIXED_NOW,
    });
    expect(triples).toContainEqual({ subject: subjectIri, predicate: SCHEMA_KEYWORDS, object: '"climate"' });
    expect(triples).toContainEqual({ subject: subjectIri, predicate: SCHEMA_KEYWORDS, object: '"policy"' });
  });

  it('does not treat markdown headings as hashtags', () => {
    const { triples } = extractFromMarkdown({
      markdown: `# Title\n\n## Section\n\nBody without tags.\n`,
      agentDid: AGENT,
      now: FIXED_NOW,
    });
    const keywords = triples.filter(t => t.predicate === SCHEMA_KEYWORDS);
    expect(keywords).toHaveLength(0);
  });

  it('ignores hashtags inside code fences', () => {
    const { triples } = extractFromMarkdown({
      markdown: `# Doc\n\n\`\`\`bash\n# a comment #notatag\n\`\`\`\n\nBody #realtag here.\n`,
      agentDid: AGENT,
      now: FIXED_NOW,
    });
    const keywords = triples.filter(t => t.predicate === SCHEMA_KEYWORDS).map(t => t.object);
    expect(keywords).toContain('"realtag"');
    expect(keywords).not.toContain('"notatag"');
    expect(keywords).not.toContain('"a"');
  });
});

describe('extractFromMarkdown — Dataview inline fields', () => {
  it('extracts `key:: value` lines', () => {
    const { triples, subjectIri } = extractFromMarkdown({
      markdown: `# Doc\n\nauthor:: Alice\nstatus:: draft\n`,
      agentDid: AGENT,
      now: FIXED_NOW,
    });
    expect(triples).toContainEqual({ subject: subjectIri, predicate: 'http://schema.org/author', object: '"Alice"' });
    expect(triples).toContainEqual({ subject: subjectIri, predicate: 'http://schema.org/status', object: '"draft"' });
  });

  it('preserves IRI values as IRIs (not literals)', () => {
    const { triples, subjectIri } = extractFromMarkdown({
      markdown: `# Doc\n\nhomepage:: https://example.org/home\n`,
      agentDid: AGENT,
      now: FIXED_NOW,
    });
    expect(triples).toContainEqual({ subject: subjectIri, predicate: 'http://schema.org/homepage', object: 'https://example.org/home' });
  });

  it('ignores dataview-like syntax inside code fences', () => {
    const { triples } = extractFromMarkdown({
      markdown: `# Doc\n\n\`\`\`\nfake:: not a field\n\`\`\`\n\nreal:: value\n`,
      agentDid: AGENT,
      now: FIXED_NOW,
    });
    const dataview = triples.filter(t => t.predicate.startsWith('http://schema.org/'));
    expect(dataview.some(t => t.predicate === 'http://schema.org/real')).toBe(true);
    expect(dataview.some(t => t.predicate === 'http://schema.org/fake')).toBe(false);
  });
});

describe('extractFromMarkdown — headings', () => {
  it('emits dkg:hasSection triples for H2+ headings but not H1', () => {
    const { triples, subjectIri } = extractFromMarkdown({
      markdown: `# Title\n\n## Intro\n\n## Methods\n\n### Sub-method\n`,
      agentDid: AGENT,
      now: FIXED_NOW,
    });
    const sections = triples.filter(t => t.predicate === DKG_HAS_SECTION);
    expect(sections).toHaveLength(3);
    expect(sections.map(t => t.object)).toEqual([
      `${subjectIri}#section-intro`,
      `${subjectIri}#section-methods`,
      `${subjectIri}#section-sub-method`,
    ]);
    // Each section should have a schema:name
    for (const section of sections) {
      expect(triples.some(t => t.subject === section.object && t.predicate === SCHEMA_NAME)).toBe(true);
    }
  });

  it('H1 promotes to schema:name on the document subject', () => {
    const { triples, subjectIri } = extractFromMarkdown({
      markdown: `# My Document\n\nBody.\n`,
      agentDid: AGENT,
      now: FIXED_NOW,
    });
    expect(triples).toContainEqual({ subject: subjectIri, predicate: SCHEMA_NAME, object: '"My Document"' });
  });

  it('H1 does not overwrite an explicit frontmatter title', () => {
    const { triples, subjectIri } = extractFromMarkdown({
      markdown: `---\nid: x\ntitle: Explicit Title\n---\n\n# Different H1\n`,
      agentDid: AGENT,
      now: FIXED_NOW,
    });
    const names = triples.filter(t => t.subject === subjectIri && t.predicate === SCHEMA_NAME);
    expect(names).toHaveLength(1);
    expect(names[0].object).toBe('"Explicit Title"');
  });
});

describe('extractFromMarkdown — subject IRI resolution', () => {
  it('prefers explicit documentIri input', () => {
    const { subjectIri } = extractFromMarkdown({
      markdown: `---\nid: ignored\n---\n\n# H1 Also Ignored\n`,
      agentDid: AGENT,
      documentIri: 'did:dkg:context-graph:foo/assertion/0xabc/mydoc',
      now: FIXED_NOW,
    });
    expect(subjectIri).toBe('did:dkg:context-graph:foo/assertion/0xabc/mydoc');
  });

  it('uses frontmatter id as-is when it looks like an IRI', () => {
    const { subjectIri } = extractFromMarkdown({
      markdown: `---\nid: https://example.org/thing/42\n---\n`,
      agentDid: AGENT,
      now: FIXED_NOW,
    });
    expect(subjectIri).toBe('https://example.org/thing/42');
  });

  it('slugifies a frontmatter id that is not an IRI', () => {
    const { subjectIri } = extractFromMarkdown({
      markdown: `---\nid: My Great Document!\n---\n`,
      agentDid: AGENT,
      now: FIXED_NOW,
    });
    expect(subjectIri).toBe('urn:dkg:md:my-great-document');
  });

  it('falls back to slugified H1 when no id is present', () => {
    const { subjectIri } = extractFromMarkdown({
      markdown: `# A Title of Things\n\nBody.\n`,
      agentDid: AGENT,
      now: FIXED_NOW,
    });
    expect(subjectIri).toBe('urn:dkg:md:a-title-of-things');
  });

  it('uses a hash fallback when non-ASCII titles and headings would slugify to empty strings', () => {
    const { triples, subjectIri } = extractFromMarkdown({
      markdown: `# 東京\n\nSee [[大阪]].\n\n## 感想\n`,
      agentDid: AGENT,
      now: FIXED_NOW,
    });
    expect(subjectIri).toMatch(/^urn:dkg:md:hash-[0-9a-f]{12}$/);
    const mentions = triples.filter(t => t.predicate === SCHEMA_MENTIONS).map(t => t.object);
    expect(mentions).toEqual([expect.stringMatching(/^urn:dkg:md:hash-[0-9a-f]{12}$/)]);
    const sections = triples.filter(t => t.predicate === DKG_HAS_SECTION).map(t => t.object);
    expect(sections).toEqual([expect.stringMatching(new RegExp(`^${subjectIri.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}#section-hash-[0-9a-f]{12}$`))]);
  });

  it('produces a stable anonymous fallback when there is no title', () => {
    const { subjectIri } = extractFromMarkdown({
      markdown: `Just a body. No headings, no frontmatter.\n`,
      agentDid: AGENT,
      now: FIXED_NOW,
    });
    expect(subjectIri.startsWith('urn:dkg:md:anonymous-')).toBe(true);
  });
});

describe('extractFromMarkdown — provenance', () => {
  it('emits a single provenance block when triples are produced', () => {
    const { triples, provenance } = extractFromMarkdown({
      markdown: `# Doc\n\n#tag1\n`,
      agentDid: AGENT,
      now: FIXED_NOW,
    });
    expect(triples.length).toBeGreaterThan(0);
    expect(provenance.length).toBeGreaterThan(0);
    expect(provenance).toContainEqual(expect.objectContaining({
      predicate: RDF_TYPE,
      object: DKG_EXTRACTION_PROVENANCE,
    }));
    // Back-link from subject to provenance
    expect(provenance.some(q => q.predicate === PROV_WAS_GENERATED_BY)).toBe(true);
  });

  it('emits no provenance when no triples are extracted', () => {
    const { triples, provenance } = extractFromMarkdown({
      markdown: ``,
      agentDid: AGENT,
      now: FIXED_NOW,
    });
    expect(triples).toHaveLength(0);
    expect(provenance).toHaveLength(0);
  });

  it('records the extracting agent DID in provenance', () => {
    const { provenance } = extractFromMarkdown({
      markdown: `# Doc\n\n#tag\n`,
      agentDid: AGENT,
      now: FIXED_NOW,
    });
    expect(provenance.some(q => q.object === AGENT)).toBe(true);
  });
});

describe('extractFromMarkdown — end-to-end', () => {
  it('handles a full document with frontmatter, H1, tags, wikilinks, dataview, and sections', () => {
    const markdown = `---
id: research-note
type: ScholarlyArticle
title: On Decentralized Knowledge Graphs
description: Exploring DKG fundamentals
authors:
  - Alice
  - Bob
---

# On Decentralized Knowledge Graphs

status:: draft
topic:: knowledge graphs

This note discusses [[Decentralized Identifiers]] and [[RDF]] concepts.

It covers #knowledge-graphs and #dkg topics in depth.

## Background

Some background.

## Methods

Our method relies on [[SPARQL]] queries.
`;
    const { triples, provenance, subjectIri } = extractFromMarkdown({
      markdown,
      agentDid: AGENT,
      now: FIXED_NOW,
    });

    expect(subjectIri).toBe('urn:dkg:md:research-note');

    // Type
    expect(triples).toContainEqual({
      subject: subjectIri,
      predicate: RDF_TYPE,
      object: 'http://schema.org/ScholarlyArticle',
    });

    // Name from frontmatter title (NOT from H1 since title is set)
    expect(triples.filter(t => t.predicate === SCHEMA_NAME && t.subject === subjectIri)).toEqual([
      { subject: subjectIri, predicate: SCHEMA_NAME, object: '"On Decentralized Knowledge Graphs"' },
    ]);

    // Authors
    const authors = triples.filter(t => t.predicate === 'http://schema.org/authors').map(t => t.object);
    expect(authors).toContain('"Alice"');
    expect(authors).toContain('"Bob"');

    // Dataview fields
    expect(triples).toContainEqual({ subject: subjectIri, predicate: 'http://schema.org/status', object: '"draft"' });
    expect(triples).toContainEqual({ subject: subjectIri, predicate: 'http://schema.org/topic', object: '"knowledge graphs"' });

    // Wikilinks
    const mentions = triples.filter(t => t.predicate === SCHEMA_MENTIONS).map(t => t.object);
    expect(mentions).toContain('urn:dkg:md:decentralized-identifiers');
    expect(mentions).toContain('urn:dkg:md:rdf');
    expect(mentions).toContain('urn:dkg:md:sparql');

    // Tags
    const tags = triples.filter(t => t.predicate === SCHEMA_KEYWORDS).map(t => t.object);
    expect(tags).toContain('"knowledge-graphs"');
    expect(tags).toContain('"dkg"');

    // Sections
    const sections = triples.filter(t => t.predicate === DKG_HAS_SECTION).map(t => t.object);
    expect(sections).toEqual([
      `${subjectIri}#section-background`,
      `${subjectIri}#section-methods`,
    ]);

    // Provenance present
    expect(provenance.length).toBeGreaterThan(0);
    expect(provenance.some(q => q.object === AGENT)).toBe(true);
  });
});
