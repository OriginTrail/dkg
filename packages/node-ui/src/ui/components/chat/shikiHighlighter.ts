import { createHighlighterCore } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';
import githubDark from 'shiki/themes/github-dark.mjs';
import githubLight from 'shiki/themes/github-light.mjs';
import { loadShikiLanguageRegistrations } from './shikiLanguages.js';

// The root `shiki` entry constructs its full bundle and therefore exposes a
// dynamic import edge for every bundled language and theme to Vite. Core plus
// the explicit registry keeps this lazy chunk limited to CodeBlock languages.
export async function createHighlighter() {
  return createHighlighterCore({
    engine: createOnigurumaEngine(import('shiki/wasm')),
    themes: [githubDark, githubLight],
    langs: await loadShikiLanguageRegistrations(),
  });
}
