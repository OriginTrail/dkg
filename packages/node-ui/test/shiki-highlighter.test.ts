import { describe, expect, it } from 'vitest';
import { createHighlighter } from '../src/ui/components/chat/shikiHighlighter.js';
import {
  normalizeShikiLanguage,
  SUPPORTED_SHIKI_LANGUAGE_ALIASES,
} from '../src/ui/components/chat/shikiLanguages.js';

describe('fine-grained Shiki highlighter', () => {
  it('loads every CodeBlock language alias and both UI themes', async () => {
    const highlighter = await createHighlighter();
    try {
      for (const alias of SUPPORTED_SHIKI_LANGUAGE_ALIASES) {
        const lang = normalizeShikiLanguage(alias);
        expect(lang, alias).not.toBeNull();
        expect(() => highlighter.codeToHtml('const value = 1;', {
          lang: lang!,
          theme: 'github-dark',
        }), alias).not.toThrow();
      }

      expect(highlighter.codeToHtml('const value = 1;', {
        lang: 'ts',
        theme: 'github-light',
      })).toContain('github-light');
    } finally {
      highlighter.dispose();
    }
  });
});
