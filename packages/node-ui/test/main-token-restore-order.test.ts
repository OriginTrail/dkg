import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A token entered earlier in this tab must be restored before any module can
// issue an API call. ES imports are evaluated in source order, so the restore
// has to run from a side-effect import placed first in main.tsx — a later body
// call would run after the whole module graph has been evaluated. This guards
// that ordering, which is otherwise enforced only by a comment.
describe('main.tsx restores the API token first', () => {
  const source = readFileSync(new URL('../src/ui/main.tsx', import.meta.url), 'utf-8');

  it('imports the token-restore side effect before any other import', () => {
    const firstImport = source
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('import '));
    expect(firstImport).toBe("import './lib/restoreApiToken.js';");
  });

  it('restoreApiToken runs the restore as an import side effect', () => {
    const restore = readFileSync(new URL('../src/ui/lib/restoreApiToken.ts', import.meta.url), 'utf-8');
    expect(restore).toMatch(/restoreEnteredApiToken\(\)\s*;/);
  });
});
