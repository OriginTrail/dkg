import { describe, it, expect } from 'vitest';
import { dump } from 'js-yaml';
import { parseDocument, OkfDocumentError, YamlTimestamp } from '../src/index.js';
import { OKF_YAML_SCHEMA } from '../src/document.js';

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

describe('an unquoted timestamp reads as a YamlTimestamp', () => {
  const fm = parseDocument(
    'x.md',
    '---\ntype: T\nreleased: 2026-06-15\nlocal: 2026-12-31T00:00:00\nshifted: 2026-06-25T09:00:00+02:00\nquoted: "2026-06-15"\nimpossible: 2026-02-30\n---\n',
  ).frontmatter;

  it('declares the text it was written as, and is a Date for everything else', () => {
    const released = fm.released as YamlTimestamp;
    expect(released).toBeInstanceOf(YamlTimestamp);
    expect(released).toBeInstanceOf(Date);
    expect(released.lexical).toBe('2026-06-15');
    expect(released.getTime()).toBe(Date.UTC(2026, 5, 15));
    expect(Object.keys(released)).toEqual([]);
    expect((fm.local as YamlTimestamp).lexical).toBe('2026-12-31T00:00:00');
    expect((fm.shifted as YamlTimestamp).lexical).toBe('2026-06-25T09:00:00+02:00');
    // A quoted date and an impossible one stay the strings they were.
    expect(fm.quoted).toBe('2026-06-15');
    expect(fm.impossible).toBe('2026-02-30');
  });

  it('writes that text as JSON and as YAML; a plain Date made from it is the instant alone', () => {
    const released = fm.released as YamlTimestamp;
    expect(JSON.stringify({ released })).toBe('{"released":"2026-06-15"}');
    expect(JSON.stringify(new Date(released))).toBe('"2026-06-15T00:00:00.000Z"');
    expect(new Date(released)).not.toBeInstanceOf(YamlTimestamp);
    expect(dump({ released, local: fm.local, at: new Date(Date.UTC(2026, 5, 30, 14)) }, { schema: OKF_YAML_SCHEMA })).toBe(
      'released: 2026-06-15\nlocal: 2026-12-31T00:00:00\nat: 2026-06-30T14:00:00Z\n',
    );
  });
});
