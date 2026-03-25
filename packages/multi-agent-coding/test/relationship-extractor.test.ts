/**
 * Unit tests for src/code/relationship-extractor.ts
 */

import { describe, it, expect } from 'vitest';
import { buildFileIndex, extractRelationships } from '../src/code/relationship-extractor.js';
import type { ParseResult } from '../src/code/parser.js';

const OWNER = 'octocat';
const REPO = 'Hello-World';

function makeParseResult(opts?: {
  entities?: ParseResult['entities'];
  imports?: ParseResult['imports'];
  exports?: ParseResult['exports'];
}): ParseResult {
  return {
    entities: opts?.entities ?? [],
    imports: opts?.imports ?? [],
    exports: opts?.exports ?? [],
  };
}

describe('buildFileIndex', () => {
  it('creates an index from parsed files', () => {
    const files = new Map<string, ParseResult>();
    files.set('src/a.ts', makeParseResult({
      entities: [
        { kind: 'class', name: 'ClassA', startLine: 1, endLine: 10, isExported: true },
        { kind: 'function', name: 'privateHelper', startLine: 12, endLine: 15 },
      ],
      exports: [{ name: 'ClassA', kind: 'class', line: 1 }],
    }));
    files.set('src/b.ts', makeParseResult({
      entities: [
        { kind: 'function', name: 'utilFunc', startLine: 1, endLine: 5, isExported: true },
      ],
    }));

    const index = buildFileIndex(files);

    expect(index.files.size).toBe(2);
    expect(index.exportedSymbols.size).toBe(2);

    // ClassA is exported
    expect(index.exportedSymbols.get('src/a.ts')?.has('ClassA')).toBe(true);
    // privateHelper is NOT exported
    expect(index.exportedSymbols.get('src/a.ts')?.has('privateHelper')).toBe(false);
    // utilFunc is exported
    expect(index.exportedSymbols.get('src/b.ts')?.has('utilFunc')).toBe(true);
  });

  it('includes export declaration names in exported symbols', () => {
    const files = new Map<string, ParseResult>();
    files.set('src/index.ts', makeParseResult({
      exports: [
        { name: 'foo', kind: 're-export', line: 1 },
        { name: 'bar', kind: 're-export', line: 2 },
      ],
    }));

    const index = buildFileIndex(files);
    const exported = index.exportedSymbols.get('src/index.ts');
    expect(exported?.has('foo')).toBe(true);
    expect(exported?.has('bar')).toBe(true);
  });

  it('returns empty index for empty input', () => {
    const index = buildFileIndex(new Map());
    expect(index.files.size).toBe(0);
    expect(index.exportedSymbols.size).toBe(0);
  });
});

describe('extractRelationships', () => {
  describe('import resolution', () => {
    it('resolves relative imports between files', () => {
      const files = new Map<string, ParseResult>();
      files.set('src/app.ts', makeParseResult({
        imports: [{ source: './utils', specifiers: ['helper'], line: 1 }],
      }));
      files.set('src/utils.ts', makeParseResult({
        entities: [{ kind: 'function', name: 'helper', startLine: 1, endLine: 5, isExported: true }],
      }));

      const index = buildFileIndex(files);
      const rels = extractRelationships(index, OWNER, REPO);

      const importRels = rels.filter(r => r.kind === 'imports');
      expect(importRels.length).toBe(1);
      expect(importRels[0].sourceUri).toContain('src%2Fapp.ts');
      expect(importRels[0].targetUri).toContain('src%2Futils.ts');
    });

    it('resolves imports with .js extension (TS moduleResolution)', () => {
      const files = new Map<string, ParseResult>();
      files.set('src/main.ts', makeParseResult({
        imports: [{ source: './lib.js', specifiers: ['Lib'], line: 1 }],
      }));
      files.set('src/lib.ts', makeParseResult({
        entities: [{ kind: 'class', name: 'Lib', startLine: 1, endLine: 10, isExported: true }],
      }));

      const index = buildFileIndex(files);
      const rels = extractRelationships(index, OWNER, REPO);

      const importRels = rels.filter(r => r.kind === 'imports');
      expect(importRels.length).toBe(1);
    });

    it('resolves imports to index files (./dir -> ./dir/index.ts)', () => {
      const files = new Map<string, ParseResult>();
      files.set('src/app.ts', makeParseResult({
        imports: [{ source: './utils', specifiers: ['foo'], line: 1 }],
      }));
      files.set('src/utils/index.ts', makeParseResult({
        entities: [{ kind: 'function', name: 'foo', startLine: 1, endLine: 5, isExported: true }],
      }));

      const index = buildFileIndex(files);
      const rels = extractRelationships(index, OWNER, REPO);

      const importRels = rels.filter(r => r.kind === 'imports');
      expect(importRels.length).toBe(1);
      expect(importRels[0].targetUri).toContain('src%2Futils%2Findex.ts');
    });

    it('resolves parent directory imports (..)', () => {
      const files = new Map<string, ParseResult>();
      files.set('src/sub/child.ts', makeParseResult({
        imports: [{ source: '../parent', specifiers: ['Base'], line: 1 }],
      }));
      files.set('src/parent.ts', makeParseResult({
        entities: [{ kind: 'class', name: 'Base', startLine: 1, endLine: 10, isExported: true }],
      }));

      const index = buildFileIndex(files);
      const rels = extractRelationships(index, OWNER, REPO);

      expect(rels.filter(r => r.kind === 'imports').length).toBe(1);
    });

    it('ignores non-relative imports (npm packages)', () => {
      const files = new Map<string, ParseResult>();
      files.set('src/app.ts', makeParseResult({
        imports: [
          { source: 'react', specifiers: ['useState'], line: 1 },
          { source: 'node:fs', specifiers: ['readFile'], line: 2 },
          { source: '@scope/pkg', specifiers: ['Foo'], line: 3 },
        ],
      }));

      const index = buildFileIndex(files);
      const rels = extractRelationships(index, OWNER, REPO);
      expect(rels.filter(r => r.kind === 'imports').length).toBe(0);
    });

    it('handles unresolvable relative imports gracefully', () => {
      const files = new Map<string, ParseResult>();
      files.set('src/app.ts', makeParseResult({
        imports: [{ source: './nonexistent', specifiers: ['x'], line: 1 }],
      }));

      const index = buildFileIndex(files);
      const rels = extractRelationships(index, OWNER, REPO);
      expect(rels.filter(r => r.kind === 'imports').length).toBe(0);
    });
  });

  describe('inheritance resolution', () => {
    it('resolves extends within the same file', () => {
      const files = new Map<string, ParseResult>();
      files.set('src/models.ts', makeParseResult({
        entities: [
          { kind: 'class', name: 'Base', startLine: 1, endLine: 5 },
          { kind: 'class', name: 'Child', startLine: 7, endLine: 15, extends: 'Base' },
        ],
      }));

      const index = buildFileIndex(files);
      const rels = extractRelationships(index, OWNER, REPO);

      const inherits = rels.filter(r => r.kind === 'inherits');
      expect(inherits.length).toBe(1);
      expect(inherits[0].sourceUri).toContain('#Child');
      expect(inherits[0].targetUri).toContain('#Base');
    });

    it('resolves extends across files via imports', () => {
      const files = new Map<string, ParseResult>();
      files.set('src/animal.ts', makeParseResult({
        entities: [
          { kind: 'class', name: 'Animal', startLine: 1, endLine: 10, isExported: true },
        ],
      }));
      files.set('src/dog.ts', makeParseResult({
        entities: [
          { kind: 'class', name: 'Dog', startLine: 3, endLine: 15, extends: 'Animal', isExported: true },
        ],
        imports: [
          { source: './animal', specifiers: ['Animal'], line: 1 },
        ],
      }));

      const index = buildFileIndex(files);
      const rels = extractRelationships(index, OWNER, REPO);

      const inherits = rels.filter(r => r.kind === 'inherits');
      expect(inherits.length).toBe(1);
      expect(inherits[0].sourceUri).toContain('src%2Fdog.ts#Dog');
      expect(inherits[0].targetUri).toContain('src%2Fanimal.ts#Animal');
    });

    it('resolves implements across files via imports', () => {
      const files = new Map<string, ParseResult>();
      files.set('src/interfaces.ts', makeParseResult({
        entities: [
          { kind: 'interface', name: 'IService', startLine: 1, endLine: 5, isExported: true },
        ],
      }));
      files.set('src/service.ts', makeParseResult({
        entities: [
          { kind: 'class', name: 'Service', startLine: 3, endLine: 20, implements: ['IService'], isExported: true },
        ],
        imports: [
          { source: './interfaces', specifiers: ['IService'], line: 1 },
        ],
      }));

      const index = buildFileIndex(files);
      const rels = extractRelationships(index, OWNER, REPO);

      const impls = rels.filter(r => r.kind === 'implements');
      expect(impls.length).toBe(1);
      expect(impls[0].sourceUri).toContain('src%2Fservice.ts#Service');
      expect(impls[0].targetUri).toContain('src%2Finterfaces.ts#IService');
    });

    it('does not create relationship for unresolvable extends', () => {
      const files = new Map<string, ParseResult>();
      files.set('src/child.ts', makeParseResult({
        entities: [
          { kind: 'class', name: 'Child', startLine: 1, endLine: 10, extends: 'UnknownBase' },
        ],
      }));

      const index = buildFileIndex(files);
      const rels = extractRelationships(index, OWNER, REPO);
      expect(rels.filter(r => r.kind === 'inherits').length).toBe(0);
    });
  });

  describe('combined scenarios', () => {
    it('handles a file with imports, inheritance, and implements', () => {
      const files = new Map<string, ParseResult>();
      files.set('src/base.ts', makeParseResult({
        entities: [
          { kind: 'class', name: 'BaseClass', startLine: 1, endLine: 10, isExported: true },
          { kind: 'interface', name: 'IPlugin', startLine: 12, endLine: 18, isExported: true },
        ],
      }));
      files.set('src/plugin.ts', makeParseResult({
        entities: [
          {
            kind: 'class', name: 'MyPlugin', startLine: 3, endLine: 30,
            extends: 'BaseClass', implements: ['IPlugin'], isExported: true,
          },
        ],
        imports: [
          { source: './base', specifiers: ['BaseClass', 'IPlugin'], line: 1 },
        ],
      }));

      const index = buildFileIndex(files);
      const rels = extractRelationships(index, OWNER, REPO);

      expect(rels.filter(r => r.kind === 'imports').length).toBe(1);
      expect(rels.filter(r => r.kind === 'inherits').length).toBe(1);
      expect(rels.filter(r => r.kind === 'implements').length).toBe(1);
    });

    it('produces no relationships for an empty file index', () => {
      const index = buildFileIndex(new Map());
      const rels = extractRelationships(index, OWNER, REPO);
      expect(rels.length).toBe(0);
    });
  });
});
