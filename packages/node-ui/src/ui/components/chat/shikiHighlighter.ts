import { createHighlighterCore } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';
import bash from 'shiki/langs/bash.mjs';
import css from 'shiki/langs/css.mjs';
import diff from 'shiki/langs/diff.mjs';
import dockerfile from 'shiki/langs/dockerfile.mjs';
import go from 'shiki/langs/go.mjs';
import html from 'shiki/langs/html.mjs';
import javascript from 'shiki/langs/javascript.mjs';
import json from 'shiki/langs/json.mjs';
import jsx from 'shiki/langs/jsx.mjs';
import markdown from 'shiki/langs/markdown.mjs';
import python from 'shiki/langs/python.mjs';
import rust from 'shiki/langs/rust.mjs';
import solidity from 'shiki/langs/solidity.mjs';
import sparql from 'shiki/langs/sparql.mjs';
import sql from 'shiki/langs/sql.mjs';
import toml from 'shiki/langs/toml.mjs';
import tsx from 'shiki/langs/tsx.mjs';
import typescript from 'shiki/langs/typescript.mjs';
import xml from 'shiki/langs/xml.mjs';
import yaml from 'shiki/langs/yaml.mjs';
import githubDark from 'shiki/themes/github-dark.mjs';
import githubLight from 'shiki/themes/github-light.mjs';

// The root `shiki` entry constructs its full bundle and therefore exposes a
// dynamic import edge for every bundled language and theme to Vite. Supplying
// an allow-list to that constructor only limits runtime initialization; it
// does not shrink the build graph. Core plus explicit grammar/theme imports
// keeps this lazy chunk limited to the languages CodeBlock accepts.
// Shiki 4's fine-grained language defaults are registration arrays (usually
// one entry). Flattening the groups also remains safe if a future Shiki module
// exports a single registration object instead.
const languages = [
  bash,
  css,
  diff,
  dockerfile,
  go,
  html,
  javascript,
  json,
  jsx,
  markdown,
  python,
  rust,
  solidity,
  sparql,
  sql,
  toml,
  tsx,
  typescript,
  xml,
  yaml,
].flat().filter((language, index, all) =>
  all.findIndex((candidate) => candidate.name === language.name) === index,
);

export function createHighlighter() {
  return createHighlighterCore({
    engine: createOnigurumaEngine(import('shiki/wasm')),
    themes: [githubDark, githubLight],
    langs: languages,
  });
}
