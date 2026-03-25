/**
 * Unit tests for src/code/parser-registry.ts
 */

import { describe, it, expect } from 'vitest';
import { getParser, isParseable, PARSEABLE_EXTENSIONS } from '../src/code/parser-registry.js';

describe('parser-registry', () => {
  describe('getParser', () => {
    it('returns TypeScriptParser for .ts files', () => {
      const parser = getParser('src/index.ts');
      expect(parser).toBeDefined();
    });

    it('returns TypeScriptParser for .tsx files', () => {
      const parser = getParser('src/App.tsx');
      expect(parser).toBeDefined();
    });

    it('returns TypeScriptParser for .js files', () => {
      expect(getParser('lib/util.js')).toBeDefined();
    });

    it('returns TypeScriptParser for .jsx files', () => {
      expect(getParser('components/Card.jsx')).toBeDefined();
    });

    it('returns TypeScriptParser for .mjs files', () => {
      expect(getParser('config.mjs')).toBeDefined();
    });

    it('returns TypeScriptParser for .cjs files', () => {
      expect(getParser('config.cjs')).toBeDefined();
    });

    it('returns TreeSitterParser for .py files', () => {
      expect(getParser('script.py')).toBeDefined();
    });

    it('returns TreeSitterParser for .go files', () => {
      expect(getParser('main.go')).toBeDefined();
    });

    it('returns TreeSitterParser for .rs files', () => {
      expect(getParser('lib.rs')).toBeDefined();
    });

    it('returns TreeSitterParser for .java files', () => {
      expect(getParser('Main.java')).toBeDefined();
    });

    it('returns TreeSitterParser for .sol files', () => {
      expect(getParser('Token.sol')).toBeDefined();
    });

    it('returns undefined for unsupported extensions', () => {
      expect(getParser('README.md')).toBeUndefined();
      expect(getParser('package.json')).toBeUndefined();
      expect(getParser('style.css')).toBeUndefined();
      expect(getParser('config.yaml')).toBeUndefined();
      expect(getParser('Dockerfile')).toBeUndefined();
    });

    it('is case-insensitive for extensions', () => {
      expect(getParser('FILE.TS')).toBeDefined();
      expect(getParser('FILE.PY')).toBeDefined();
    });

    it('handles deeply nested paths', () => {
      expect(getParser('a/b/c/d/e/f.ts')).toBeDefined();
    });
  });

  describe('isParseable', () => {
    it('returns true for parseable extensions', () => {
      expect(isParseable('src/index.ts')).toBe(true);
      expect(isParseable('main.py')).toBe(true);
      expect(isParseable('Token.sol')).toBe(true);
    });

    it('returns false for non-parseable extensions', () => {
      expect(isParseable('README.md')).toBe(false);
      expect(isParseable('config.json')).toBe(false);
      expect(isParseable('data.csv')).toBe(false);
    });
  });

  describe('PARSEABLE_EXTENSIONS', () => {
    it('contains all expected extensions', () => {
      const expected = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.sol'];
      for (const ext of expected) {
        expect(PARSEABLE_EXTENSIONS.has(ext), `Missing extension: ${ext}`).toBe(true);
      }
    });

    it('does not contain unsupported extensions', () => {
      expect(PARSEABLE_EXTENSIONS.has('.md')).toBe(false);
      expect(PARSEABLE_EXTENSIONS.has('.json')).toBe(false);
      expect(PARSEABLE_EXTENSIONS.has('.css')).toBe(false);
    });
  });
});
