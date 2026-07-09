import { describe, it, expect } from 'vitest';
import { parseDocument, OkfDocumentError } from '../src/index.js';

describe('parseDocument (mirrors document.py OKFDocument.parse)', () => {
  it('treats a file with no leading --- as all body (reserved files)', () => {
    const doc = parseDocument('index.md', '# Subdirectories\n\n* [a](a.md)\n');
    expect(doc.frontmatter).toEqual({});
    expect(doc.body).toBe('# Subdirectories\n\n* [a](a.md)\n');
  });

  it('splits frontmatter and strips exactly one leading body newline', () => {
    const doc = parseDocument(
      'tables/blocks.md',
      '---\ntype: BigQuery Table\ntitle: Blocks\n---\n\nBody line one\n',
    );
    expect(doc.conceptId).toBe('tables/blocks');
    expect(doc.segments).toEqual(['tables', 'blocks']);
    expect(doc.frontmatter).toEqual({ type: 'BigQuery Table', title: 'Blocks' });
    expect(doc.body).toBe('\nBody line one\n'.slice(1)); // one leading \n removed
    expect(doc.body.startsWith('Body line one')).toBe(true);
  });

  it('closes the block on a --- with trailing whitespace', () => {
    const doc = parseDocument('a.md', '---\ntype: X\n--- \nbody');
    expect(doc.frontmatter).toEqual({ type: 'X' });
    expect(doc.body).toBe('body');
  });

  it('throws on an unterminated frontmatter block', () => {
    expect(() => parseDocument('a.md', '---\ntype: X\nbody without close')).toThrow(
      OkfDocumentError,
    );
  });

  it('throws when frontmatter is not a YAML mapping', () => {
    expect(() => parseDocument('a.md', '---\n- just\n- a\n- list\n---\nbody')).toThrow(
      /must be a YAML mapping/,
    );
  });

  it('reads okf_version from a root index.md', () => {
    const doc = parseDocument('index.md', '---\nokf_version: "0.1"\n---\n\n# Root\n');
    expect(doc.frontmatter.okf_version).toBe('0.1');
  });
});
