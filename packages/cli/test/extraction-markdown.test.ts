import { describe, it, expect } from 'vitest';
import { extractFromMarkdown } from '../src/extraction/markdown-extractor.js';

const AGENT = 'did:dkg:agent:0xAbC123';
const FIXED_NOW = new Date('2026-04-10T12:00:00Z');
const FILE_URI = 'urn:dkg:file:keccak256:1111111111111111111111111111111111111111111111111111111111111111';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SCHEMA_NAME = 'http://schema.org/name';
const SCHEMA_DESCRIPTION = 'http://schema.org/description';
const SCHEMA_MENTIONS = 'http://schema.org/mentions';
const SCHEMA_KEYWORDS = 'http://schema.org/keywords';
const DKG_HAS_SECTION = 'http://dkg.io/ontology/hasSection';
const DKG_SOURCE_FILE = 'http://dkg.io/ontology/sourceFile';
const DKG_SOURCE_CONTENT_TYPE = 'http://dkg.io/ontology/sourceContentType';
const DKG_ROOT_ENTITY = 'http://dkg.io/ontology/rootEntity';
const DKG_DERIVED_FROM = 'http://dkg.io/ontology/derivedFrom';
const DKG_EXTRACTION_PROVENANCE = 'http://dkg.io/ontology/ExtractionProvenance';
const XSD_BOOLEAN = 'http://www.w3.org/2001/XMLSchema#boolean';
const XSD_DATE = 'http://www.w3.org/2001/XMLSchema#date';
const XSD_DATE_TIME = 'http://www.w3.org/2001/XMLSchema#dateTime';
const XSD_DECIMAL = 'http://www.w3.org/2001/XMLSchema#decimal';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';

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

  it('Issue 123: preserves safe absolute-scheme IRIs in `type` and generic frontmatter scalars', () => {
    const { triples, subjectIri } = extractFromMarkdown({
      markdown: `---\nid: doc\ntype: tag:origintrail.org,2026:Document\nauthor: doi:10.1234/example\nhomepage: https://example.org/home\n---\n\n# Doc\n`,
      agentDid: AGENT,
      now: FIXED_NOW,
    });
    expect(triples).toContainEqual({
      subject: subjectIri,
      predicate: RDF_TYPE,
      object: 'tag:origintrail.org,2026:Document',
    });
    expect(triples).toContainEqual({
      subject: subjectIri,
      predicate: 'http://schema.org/author',
      object: 'doi:10.1234/example',
    });
    expect(triples).toContainEqual({
      subject: subjectIri,
      predicate: 'http://schema.org/homepage',
      object: 'https://example.org/home',
    });
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
      object: `"2026-04-10"^^<${XSD_DATE}>`,
    });
    expect(triples).toContainEqual({
      subject: subjectIri,
      predicate: 'http://schema.org/authors',
      object: '"Alice"',
    });
  });

  it('Issue 123: malformed scheme-prefixed frontmatter values fall back instead of emitting unsafe IRIs', () => {
    const { triples, subjectIri } = extractFromMarkdown({
      markdown: `---\nid: doc\ntype: "urn:x y"\nhomepage: "tag:example.org,2026:x y"\n---\n\n# Doc\n`,
      agentDid: AGENT,
      now: FIXED_NOW,
    });
    expect(triples).toContainEqual({
      subject: subjectIri,
      predicate: RDF_TYPE,
      object: 'http://schema.org/UrnXY',
    });
    expect(triples).toContainEqual({
      subject: subjectIri,
      predicate: 'http://schema.org/homepage',
      object: '"tag:example.org,2026:x y"',
    });
    expect(triples.some(t => t.object === 'urn:x y')).toBe(false);
    expect(triples.some(t => t.object === 'tag:example.org,2026:x y')).toBe(false);
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

  it('emits typed literals for numeric and boolean YAML scalars', () => {
    const { triples } = extractFromMarkdown({
      markdown: `---\nid: doc\npageCount: 42\nscore: 3.14\npublished: true\n---\n`,
      agentDid: AGENT,
      now: FIXED_NOW,
    });
    expect(triples).toContainEqual({
      subject: 'urn:dkg:md:doc',
      predicate: 'http://schema.org/pageCount',
      object: `"42"^^<${XSD_INTEGER}>`,
    });
    expect(triples).toContainEqual({
      subject: 'urn:dkg:md:doc',
      predicate: 'http://schema.org/score',
      object: `"3.14"^^<${XSD_DECIMAL}>`,
    });
    expect(triples).toContainEqual({
      subject: 'urn:dkg:md:doc',
      predicate: 'http://schema.org/published',
      object: `"true"^^<${XSD_BOOLEAN}>`,
    });
  });

  it('emits xsd:dateTime for YAML timestamps with a time component', () => {
    const { triples } = extractFromMarkdown({
      markdown: `---\nid: doc\nupdatedAt: 2026-04-10T15:45:30Z\n---\n`,
      agentDid: AGENT,
      now: FIXED_NOW,
    });
    expect(triples).toContainEqual({
      subject: 'urn:dkg:md:doc',
      predicate: 'http://schema.org/updatedAt',
      object: `"2026-04-10T15:45:30.000Z"^^<${XSD_DATE_TIME}>`,
    });
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

  it('ignores variable-length info-string fences across structural extraction passes', () => {
    const { triples, subjectIri } = extractFromMarkdown({
      markdown: `\`\`\`\`md\n# Hidden Title\n[[Hidden Target]]\n#hidden\nfield:: hidden\n\`\`\`\`\n\n# Visible Title\n\n[[Visible Target]] #visible\nfield:: shown\n`,
      agentDid: AGENT,
      now: FIXED_NOW,
    });
    expect(subjectIri).toBe('urn:dkg:md:visible-title');
    expect(triples.filter(t => t.predicate === SCHEMA_MENTIONS).map(t => t.object)).toEqual([
      'urn:dkg:md:visible-target',
    ]);
    expect(triples.filter(t => t.predicate === SCHEMA_KEYWORDS).map(t => t.object)).toEqual([
      '"visible"',
    ]);
    expect(triples).toContainEqual({
      subject: subjectIri,
      predicate: 'http://schema.org/field',
      object: '"shown"',
    });
    expect(triples).not.toContainEqual({
      subject: subjectIri,
      predicate: 'http://schema.org/field',
      object: '"hidden"',
    });
  });

  it('ignores fences indented by up to three spaces', () => {
    const { triples, subjectIri } = extractFromMarkdown({
      markdown: `  \`\`\`md\n  # Hidden Title\n  [[Hidden Target]]\n  #hidden\n  field:: hidden\n  \`\`\`\n\n# Visible Title\n\n[[Visible Target]] #visible\nfield:: shown\n`,
      agentDid: AGENT,
      now: FIXED_NOW,
    });
    expect(subjectIri).toBe('urn:dkg:md:visible-title');
    expect(triples.filter(t => t.predicate === SCHEMA_MENTIONS).map(t => t.object)).toEqual([
      'urn:dkg:md:visible-target',
    ]);
    expect(triples.filter(t => t.predicate === SCHEMA_KEYWORDS).map(t => t.object)).toEqual([
      '"visible"',
    ]);
    expect(triples).toContainEqual({
      subject: subjectIri,
      predicate: 'http://schema.org/field',
      object: '"shown"',
    });
    expect(triples).not.toContainEqual({
      subject: subjectIri,
      predicate: 'http://schema.org/field',
      object: '"hidden"',
    });
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

  it('extracts inline `key:: value` fields embedded in prose', () => {
    const { triples, subjectIri } = extractFromMarkdown({
      markdown: `# Doc\n\nSentence with status:: draft\n`,
      agentDid: AGENT,
      now: FIXED_NOW,
    });
    expect(triples).toContainEqual({
      subject: subjectIri,
      predicate: 'http://schema.org/status',
      object: '"draft"',
    });
  });

  it('preserves IRI values as IRIs (not literals)', () => {
    const { triples, subjectIri } = extractFromMarkdown({
      markdown: `# Doc\n\nhomepage:: https://example.org/home\n`,
      agentDid: AGENT,
      now: FIXED_NOW,
    });
    expect(triples).toContainEqual({ subject: subjectIri, predicate: 'http://schema.org/homepage', object: 'https://example.org/home' });
  });

  it('Issue 123: preserves safe non-whitelist scheme IRIs in Dataview fields', () => {
    const { triples, subjectIri } = extractFromMarkdown({
      markdown: `# Doc\n\nref:: ark:/12025/654xz321\n`,
      agentDid: AGENT,
      now: FIXED_NOW,
    });
    expect(triples).toContainEqual({
      subject: subjectIri,
      predicate: 'http://schema.org/ref',
      object: 'ark:/12025/654xz321',
    });
  });

  it('Issue 123: malformed scheme-prefixed Dataview values fall back to literals', () => {
    const { triples, subjectIri } = extractFromMarkdown({
      markdown: `# Doc\n\nref:: tag:example.org,2026:x y\n`,
      agentDid: AGENT,
      now: FIXED_NOW,
    });
    expect(triples).toContainEqual({
      subject: subjectIri,
      predicate: 'http://schema.org/ref',
      object: '"tag:example.org,2026:x y"',
    });
    expect(triples.some(t => t.object === 'tag:example.org,2026:x y')).toBe(false);
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
  it('preserves heading nesting by attaching deeper headings to their nearest parent section', () => {
    const { triples, subjectIri } = extractFromMarkdown({
      markdown: `# Title\n\n## Intro\n\n## Methods\n\n### Sub-method\n`,
      agentDid: AGENT,
      now: FIXED_NOW,
    });
    const rootSections = triples.filter(t => t.subject === subjectIri && t.predicate === DKG_HAS_SECTION);
    expect(rootSections).toHaveLength(2);
    expect(rootSections.map(t => t.object)).toEqual([
      `${subjectIri}#section-1-intro`,
      `${subjectIri}#section-2-methods`,
    ]);
    expect(triples).toContainEqual({
      subject: `${subjectIri}#section-2-methods`,
      predicate: DKG_HAS_SECTION,
      object: `${subjectIri}#section-3-sub-method`,
    });
    for (const section of [...rootSections, {
      subject: `${subjectIri}#section-2-methods`,
      predicate: DKG_HAS_SECTION,
      object: `${subjectIri}#section-3-sub-method`,
    }]) {
      expect(triples.some(t => t.subject === section.object && t.predicate === SCHEMA_NAME)).toBe(true);
    }
  });

  it('disambiguates repeated headings by prefixing a stable section index', () => {
    const { triples, subjectIri } = extractFromMarkdown({
      markdown: `# Title\n\n## Overview\n\nText.\n\n## Overview\n\nMore text.\n`,
      agentDid: AGENT,
      now: FIXED_NOW,
    });
    const sections = triples.filter(t => t.predicate === DKG_HAS_SECTION).map(t => t.object);
    expect(sections).toEqual([
      `${subjectIri}#section-1-overview`,
      `${subjectIri}#section-2-overview`,
    ]);
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
    expect(sections).toEqual([expect.stringMatching(new RegExp(`^${subjectIri.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}#section-1-hash-[0-9a-f]{12}$`))]);
  });

  it('produces a stable anonymous fallback when there is no title', () => {
    const { subjectIri } = extractFromMarkdown({
      markdown: `Just a body. No headings, no frontmatter.\n`,
      agentDid: AGENT,
      now: FIXED_NOW,
    });
    expect(subjectIri.startsWith('urn:dkg:md:anonymous-')).toBe(true);
  });

  it('derives anonymous fallback subjects from the full body instead of a shared prefix', () => {
    const first = extractFromMarkdown({
      markdown: `Shared prefix line\nBut a different ending A\n`,
      agentDid: AGENT,
      now: FIXED_NOW,
    });
    const second = extractFromMarkdown({
      markdown: `Shared prefix line\nBut a different ending B\n`,
      agentDid: AGENT,
      now: FIXED_NOW,
    });
    expect(first.subjectIri).not.toBe(second.subjectIri);
    expect(first.subjectIri).toMatch(/^urn:dkg:md:anonymous-[0-9a-f]{12}$/);
    expect(second.subjectIri).toMatch(/^urn:dkg:md:anonymous-[0-9a-f]{12}$/);
  });
});

describe('extractFromMarkdown — source-file linkage (§10.1)', () => {
  it('emits no source-file linkage quads when no sourceFileIri is supplied', () => {
    const { triples, sourceFileLinkage, resolvedRootEntity, subjectIri } = extractFromMarkdown({
      markdown: `# Doc\n\n#tag1\n`,
      agentDid: AGENT,
      now: FIXED_NOW,
    });
    expect(triples.length).toBeGreaterThan(0);
    expect(sourceFileLinkage).toHaveLength(0);
    // resolvedRootEntity still falls back to the document subject so the
    // daemon can write row 14 even when no linkage quads are emitted.
    expect(resolvedRootEntity).toBe(subjectIri);
  });

  it('does not emit the legacy dkg:ExtractionProvenance block from the extractor', () => {
    // The extraction-provenance resource (rows 9-13 of the Phase A table)
    // is owned by the daemon route handler, not the extractor. Verify the
    // extractor never emits it even when it would otherwise produce triples.
    const { triples, sourceFileLinkage } = extractFromMarkdown({
      markdown: `# Doc\n\n#tag1\n`,
      agentDid: AGENT,
      sourceFileIri: FILE_URI,
      now: FIXED_NOW,
    });
    const all = [...triples, ...sourceFileLinkage];
    expect(all.some(q => q.object === DKG_EXTRACTION_PROVENANCE)).toBe(false);
    expect(all.some(q => q.predicate === DKG_DERIVED_FROM)).toBe(false);
  });

  it('does not emit row 2 (dkg:sourceContentType) — daemon owns that row', () => {
    // The extractor only ever processes markdown, but row 2 must describe
    // the ORIGINAL upload blob. Only the daemon has the original content
    // type, so the extractor MUST NOT emit row 2 at all. Regression guard
    // for the row-2-ownership split ruled by spec-engineer on Codex Bug 1.
    const { triples, sourceFileLinkage } = extractFromMarkdown({
      markdown: `# Doc\n\n#tag\n`,
      agentDid: AGENT,
      sourceFileIri: FILE_URI,
      now: FIXED_NOW,
    });
    const all = [...triples, ...sourceFileLinkage];
    expect(all.some(q => q.predicate === DKG_SOURCE_CONTENT_TYPE)).toBe(false);
  });

  it('emits rows 1 and 3 linkage quads when sourceFileIri is supplied', () => {
    const { sourceFileLinkage, subjectIri, resolvedRootEntity } = extractFromMarkdown({
      markdown: `---\nid: research-note\n---\n\n# Research Note\n\nBody.\n`,
      agentDid: AGENT,
      sourceFileIri: FILE_URI,
      now: FIXED_NOW,
    });
    expect(subjectIri).toBe('urn:dkg:md:research-note');
    // Row 1 — object is the caller-supplied URN. The earlier Round 3
    // blank-node approach was reverted in Round 4 (Option B filter in
    // `assertionPromote` prevents cross-assertion contention).
    expect(sourceFileLinkage).toContainEqual({
      subject: subjectIri,
      predicate: DKG_SOURCE_FILE,
      object: FILE_URI,
    });
    // Row 3: reflexive rootEntity on the document subject by default.
    expect(sourceFileLinkage).toContainEqual({
      subject: subjectIri,
      predicate: DKG_ROOT_ENTITY,
      object: subjectIri,
    });
    // Only rows 1 and 3 — no row 2.
    expect(sourceFileLinkage).toHaveLength(2);
    expect(resolvedRootEntity).toBe(subjectIri);
  });

  it('honors an explicit rootEntityIri over the reflexive default', () => {
    const ROOT = 'urn:dkg:md:research-project';
    const { sourceFileLinkage, subjectIri, resolvedRootEntity } = extractFromMarkdown({
      markdown: `# Doc\n`,
      agentDid: AGENT,
      sourceFileIri: FILE_URI,
      rootEntityIri: ROOT,
      now: FIXED_NOW,
    });
    const rootQuads = sourceFileLinkage.filter(q => q.predicate === DKG_ROOT_ENTITY);
    expect(rootQuads).toHaveLength(1);
    expect(rootQuads[0]!.object).toBe(ROOT);
    expect(rootQuads[0]!.subject).toBe(subjectIri);
    // resolvedRootEntity must match the row 3 quad so the daemon's row 14
    // is consistent with the data-graph row 3.
    expect(resolvedRootEntity).toBe(ROOT);
  });

  it('lets a frontmatter `rootEntity` key override both the input and the default', () => {
    const { sourceFileLinkage, triples, subjectIri, resolvedRootEntity } = extractFromMarkdown({
      markdown: `---\nid: sub-doc\nrootEntity: urn:dkg:md:parent-root\n---\n\n# Sub Doc\n`,
      agentDid: AGENT,
      sourceFileIri: FILE_URI,
      rootEntityIri: 'urn:dkg:md:ignored-override',
      now: FIXED_NOW,
    });
    expect(subjectIri).toBe('urn:dkg:md:sub-doc');
    const rootQuads = sourceFileLinkage.filter(q => q.predicate === DKG_ROOT_ENTITY);
    expect(rootQuads).toHaveLength(1);
    expect(rootQuads[0]!.object).toBe('urn:dkg:md:parent-root');
    expect(resolvedRootEntity).toBe('urn:dkg:md:parent-root');
    // The rootEntity frontmatter key must NOT leak through as a content triple
    // on the schema.org namespace (it's consumed by the linkage builder).
    expect(triples.some(t => t.predicate === 'http://schema.org/rootEntity')).toBe(false);
  });

  it('slugifies a non-IRI frontmatter `rootEntity` value', () => {
    const { sourceFileLinkage, resolvedRootEntity } = extractFromMarkdown({
      markdown: `---\nid: child\nrootEntity: My Parent\n---\n`,
      agentDid: AGENT,
      sourceFileIri: FILE_URI,
      now: FIXED_NOW,
    });
    const rootQuads = sourceFileLinkage.filter(q => q.predicate === DKG_ROOT_ENTITY);
    expect(rootQuads).toHaveLength(1);
    expect(rootQuads[0]!.object).toBe('urn:dkg:md:my-parent');
    expect(resolvedRootEntity).toBe('urn:dkg:md:my-parent');
  });

  it('frontmatter rootEntity resolves even without a sourceFileIri', () => {
    // §19.10.1:508 promises the override works regardless — without a
    // sourceFileIri there are no quads to emit, but the daemon may still
    // need the resolved value for downstream writes.
    const { sourceFileLinkage, resolvedRootEntity } = extractFromMarkdown({
      markdown: `---\nid: child\nrootEntity: urn:dkg:md:parent\n---\n`,
      agentDid: AGENT,
      now: FIXED_NOW,
    });
    expect(sourceFileLinkage).toHaveLength(0);
    expect(resolvedRootEntity).toBe('urn:dkg:md:parent');
  });

  it('emits linkage even when the extractor produces zero content triples', () => {
    const { triples, sourceFileLinkage } = extractFromMarkdown({
      markdown: ``,
      agentDid: AGENT,
      sourceFileIri: FILE_URI,
      now: FIXED_NOW,
    });
    expect(triples).toHaveLength(0);
    expect(sourceFileLinkage.some(q => q.predicate === DKG_SOURCE_FILE)).toBe(true);
  });

  it('Bug 13: frontmatter `rootEntity` with a valid IRI is accepted', () => {
    const { resolvedRootEntity } = extractFromMarkdown({
      markdown: `---\nid: child\nrootEntity: urn:note:climate-report\n---\n`,
      agentDid: AGENT,
      now: FIXED_NOW,
    });
    expect(resolvedRootEntity).toBe('urn:note:climate-report');
  });

  it('Bug 13: frontmatter `rootEntity` with an http://-prefixed IRI is accepted', () => {
    const { resolvedRootEntity } = extractFromMarkdown({
      markdown: `---\nid: child\nrootEntity: https://example.org/entities/42\n---\n`,
      agentDid: AGENT,
      now: FIXED_NOW,
    });
    expect(resolvedRootEntity).toBe('https://example.org/entities/42');
  });

  it('Bug 13: frontmatter `rootEntity` with an embedded space is REJECTED (not silently passed through)', () => {
    // Pre-fix: `urn:x y` would pass the prefix check and flow into the
    // graph, blowing up at the RDF layer with a cryptic error. Post-fix:
    // `isSafeIri` catches it and the extractor throws with a clear
    // message that the daemon surfaces as a 400.
    expect(() => extractFromMarkdown({
      markdown: `---\nid: child\nrootEntity: 'urn:x y'\n---\n`,
      agentDid: AGENT,
      now: FIXED_NOW,
    })).toThrow(/Invalid frontmatter 'rootEntity' IRI/);
  });

  it('Bug 13: frontmatter `rootEntity` with an angle bracket is REJECTED', () => {
    expect(() => extractFromMarkdown({
      markdown: `---\nid: child\nrootEntity: 'http://x>y'\n---\n`,
      agentDid: AGENT,
      now: FIXED_NOW,
    })).toThrow(/Invalid frontmatter 'rootEntity' IRI/);
  });

  it('Bug 13: frontmatter `rootEntity` with a double-quote is REJECTED', () => {
    expect(() => extractFromMarkdown({
      markdown: `---\nid: child\nrootEntity: 'urn:x"y'\n---\n`,
      agentDid: AGENT,
      now: FIXED_NOW,
    })).toThrow(/Invalid frontmatter 'rootEntity' IRI/);
  });

  it('Bug 13: non-IRI `rootEntity` values still fall through to slugification (unchanged)', () => {
    // Values without an http:/https:/did:/urn:/_: prefix take the
    // slugify path, which is safe by construction (strips everything
    // that isn't a-z0-9-).
    const { resolvedRootEntity } = extractFromMarkdown({
      markdown: `---\nid: child\nrootEntity: My Parent Document\n---\n`,
      agentDid: AGENT,
      now: FIXED_NOW,
    });
    expect(resolvedRootEntity).toBe('urn:dkg:md:my-parent-document');
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
    const { triples, sourceFileLinkage, subjectIri } = extractFromMarkdown({
      markdown,
      agentDid: AGENT,
      sourceFileIri: FILE_URI,
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
      `${subjectIri}#section-1-background`,
      `${subjectIri}#section-2-methods`,
    ]);

    // §10.1 linkage present: rows 1 (sourceFile) and 3 (rootEntity).
    // Row 1's object is the caller-supplied content-addressed URN
    // (Round 4 Option B after the blank-node approach was reverted).
    // Row 2 (sourceContentType) is intentionally absent — the daemon
    // owns that row because only it has the original upload content
    // type.
    expect(sourceFileLinkage).toContainEqual({
      subject: subjectIri,
      predicate: DKG_SOURCE_FILE,
      object: FILE_URI,
    });
    expect(sourceFileLinkage).toContainEqual({
      subject: subjectIri,
      predicate: DKG_ROOT_ENTITY,
      object: subjectIri,
    });
    expect(sourceFileLinkage.some(q => q.predicate === DKG_SOURCE_CONTENT_TYPE)).toBe(false);
  });
});
