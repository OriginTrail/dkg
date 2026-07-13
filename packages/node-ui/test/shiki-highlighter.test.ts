import { describe, expect, it } from 'vitest';
import { createHighlighter } from '../src/ui/components/chat/shikiHighlighter.js';

const supportedLanguages = [
  'ts', 'tsx', 'js', 'jsx', 'py', 'sh', 'bash', 'json', 'yaml',
  'sql', 'sparql', 'md', 'html', 'css', 'solidity', 'rust', 'go',
  'toml', 'diff', 'dockerfile', 'xml',
] as const;

describe('fine-grained Shiki highlighter', () => {
  it('loads every CodeBlock language alias and both UI themes', async () => {
    const highlighter = await createHighlighter();
    try {
      for (const lang of supportedLanguages) {
        expect(() => highlighter.codeToHtml('const value = 1;', {
          lang,
          theme: 'github-dark',
        }), lang).not.toThrow();
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
