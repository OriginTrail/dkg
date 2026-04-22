import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ONTOLOGIES_DIR = path.resolve(__dirname, '..', 'templates', 'ontologies');

const EXPECTED_STARTERS = [
  'coding-project',
  'book-research',
  'pkm',
  'scientific-research',
  'narrative-writing',
] as const;

/**
 * Sanity tests for the 5 starter ontologies. Each must:
 *   - exist as a directory
 *   - ship both ontology.ttl + agent-guide.md
 *   - declare a Turtle ontology header (@prefix + owl:Ontology)
 *   - declare the universal annotation predicates (chat:topic / mentions /
 *     examines / proposes / concludes / asks)
 *   - declare a slug normalisation note (the convergence rule)
 *   - have a non-trivial agent-guide.md with the look-before-mint protocol
 *
 * These checks catch silent regressions (a starter accidentally truncated,
 * a predicate renamed in one file but not the others, a copy-paste
 * mistake that drops the protocol section).
 */
describe('starter ontologies — sanity checks', () => {
  describe.each(EXPECTED_STARTERS)('%s starter', (slug) => {
    const dir = path.join(ONTOLOGIES_DIR, slug);
    const ttlPath = path.join(dir, 'ontology.ttl');
    const guidePath = path.join(dir, 'agent-guide.md');

    it('directory exists', () => {
      expect(fs.existsSync(dir)).toBe(true);
    });

    it('ontology.ttl present + non-trivial', () => {
      expect(fs.existsSync(ttlPath)).toBe(true);
      const ttl = fs.readFileSync(ttlPath, 'utf-8');
      expect(ttl.length).toBeGreaterThan(500);
    });

    it('agent-guide.md present + non-trivial', () => {
      expect(fs.existsSync(guidePath)).toBe(true);
      const md = fs.readFileSync(guidePath, 'utf-8');
      expect(md.length).toBeGreaterThan(500);
    });

    it('ontology.ttl declares an owl:Ontology header', () => {
      const ttl = fs.readFileSync(ttlPath, 'utf-8');
      expect(ttl).toMatch(/@prefix\s+owl:/i);
      expect(ttl).toMatch(/a\s+owl:Ontology/);
    });

    it('ontology.ttl imports core standard vocabularies', () => {
      const ttl = fs.readFileSync(ttlPath, 'utf-8');
      // schema.org and DCTerms are universal — every starter must compose
      // with them.
      expect(ttl).toContain('schema.org');
      expect(ttl).toContain('purl.org/dc/terms');
    });

    it('ontology.ttl declares all 6 universal annotation predicates', () => {
      const ttl = fs.readFileSync(ttlPath, 'utf-8');
      for (const p of ['chat:topic', 'chat:mentions', 'chat:examines', 'chat:proposes', 'chat:concludes', 'chat:asks']) {
        expect(ttl, `${slug}/ontology.ttl missing predicate ${p}`).toContain(p);
      }
    });

    it('ontology.ttl declares the slug-normalisation rule', () => {
      const ttl = fs.readFileSync(ttlPath, 'utf-8');
      expect(ttl).toMatch(/slug-?normalisation|normalisation/i);
      expect(ttl).toContain('stopwords'); // the rule references stopword stripping
    });

    it('agent-guide.md teaches look-before-mint', () => {
      const md = fs.readFileSync(guidePath, 'utf-8');
      expect(md).toMatch(/look-before-mint/i);
      expect(md).toMatch(/dkg_search/);
    });

    it('agent-guide.md describes the URI patterns section', () => {
      const md = fs.readFileSync(guidePath, 'utf-8');
      expect(md).toMatch(/URI patterns/i);
      expect(md).toContain('urn:dkg:');
    });

    it('agent-guide.md tells the agent to call dkg_annotate_turn', () => {
      const md = fs.readFileSync(guidePath, 'utf-8');
      expect(md).toContain('dkg_annotate_turn');
    });
  });

  it('the coding-project starter is the largest (it is the v1 reference)', () => {
    const sizes = EXPECTED_STARTERS.map((slug) => ({
      slug,
      ttlBytes: fs.statSync(path.join(ONTOLOGIES_DIR, slug, 'ontology.ttl')).size,
    }));
    const codingSize = sizes.find((s) => s.slug === 'coding-project')!.ttlBytes;
    for (const s of sizes) {
      if (s.slug === 'coding-project') continue;
      expect(codingSize, `${s.slug} should be smaller than coding-project (the v1 reference)`)
        .toBeGreaterThan(s.ttlBytes);
    }
  });

  it('no extra unexpected directories under templates/ontologies', () => {
    const found = fs.readdirSync(ONTOLOGIES_DIR)
      .filter((name) => fs.statSync(path.join(ONTOLOGIES_DIR, name)).isDirectory())
      .sort();
    expect(found).toEqual([...EXPECTED_STARTERS].sort());
  });
});
