import type { LanguageRegistration } from 'shiki/core';

type ShikiLanguageModule = { default: LanguageRegistration[] };

type ShikiLanguageDefinition = {
  aliases: Readonly<Record<string, string>>;
  load: () => Promise<ShikiLanguageModule>;
};

function defineShikiLanguageRegistry<
  const Registry extends readonly ShikiLanguageDefinition[],
>(registry: Registry): Registry {
  return registry;
}

/**
 * The single source of truth for every fenced-code label accepted by
 * CodeBlock, its normalized Shiki language, and the grammar loaded for it.
 * Explicit dynamic imports retain the lazy highlighter boundary without
 * pulling Shiki's full language registry into the Vite build graph.
 */
export const SHIKI_LANGUAGE_REGISTRY = defineShikiLanguageRegistry([
  {
    aliases: { sh: 'sh', shell: 'sh', zsh: 'sh', bash: 'bash' },
    load: () => import('shiki/langs/bash.mjs'),
  },
  { aliases: { css: 'css' }, load: () => import('shiki/langs/css.mjs') },
  { aliases: { diff: 'diff', patch: 'diff' }, load: () => import('shiki/langs/diff.mjs') },
  {
    aliases: { dockerfile: 'dockerfile', docker: 'dockerfile' },
    load: () => import('shiki/langs/dockerfile.mjs'),
  },
  { aliases: { go: 'go', golang: 'go' }, load: () => import('shiki/langs/go.mjs') },
  { aliases: { html: 'html' }, load: () => import('shiki/langs/html.mjs') },
  { aliases: { js: 'js', javascript: 'js' }, load: () => import('shiki/langs/javascript.mjs') },
  { aliases: { json: 'json' }, load: () => import('shiki/langs/json.mjs') },
  { aliases: { jsx: 'jsx' }, load: () => import('shiki/langs/jsx.mjs') },
  { aliases: { md: 'md', markdown: 'md' }, load: () => import('shiki/langs/markdown.mjs') },
  { aliases: { py: 'py', python: 'py' }, load: () => import('shiki/langs/python.mjs') },
  { aliases: { rust: 'rust', rs: 'rust' }, load: () => import('shiki/langs/rust.mjs') },
  {
    aliases: { solidity: 'solidity', sol: 'solidity' },
    load: () => import('shiki/langs/solidity.mjs'),
  },
  { aliases: { sparql: 'sparql' }, load: () => import('shiki/langs/sparql.mjs') },
  { aliases: { sql: 'sql' }, load: () => import('shiki/langs/sql.mjs') },
  { aliases: { toml: 'toml' }, load: () => import('shiki/langs/toml.mjs') },
  { aliases: { tsx: 'tsx' }, load: () => import('shiki/langs/tsx.mjs') },
  { aliases: { ts: 'ts', typescript: 'ts' }, load: () => import('shiki/langs/typescript.mjs') },
  { aliases: { xml: 'xml' }, load: () => import('shiki/langs/xml.mjs') },
  { aliases: { yaml: 'yaml', yml: 'yaml' }, load: () => import('shiki/langs/yaml.mjs') },
] as const);

type UnionToIntersection<Union> = (
  Union extends unknown ? (value: Union) => void : never
) extends (value: infer Intersection) => void ? Intersection : never;

type ShikiLanguageAliases = UnionToIntersection<
  typeof SHIKI_LANGUAGE_REGISTRY[number]['aliases']
>;

export const SHIKI_LANGUAGE_ALIASES = Object.freeze(Object.assign(
  {},
  ...SHIKI_LANGUAGE_REGISTRY.map(({ aliases }) => aliases),
)) as Readonly<ShikiLanguageAliases>;

export type ShikiLanguageAlias = keyof ShikiLanguageAliases;
export type SupportedShikiLanguage = ShikiLanguageAliases[ShikiLanguageAlias];

export const SUPPORTED_SHIKI_LANGUAGE_ALIASES = Object.freeze(
  Object.keys(SHIKI_LANGUAGE_ALIASES) as ShikiLanguageAlias[],
);

export function normalizeShikiLanguage(raw: string | undefined): SupportedShikiLanguage | null {
  if (!raw) return null;
  const label = raw.toLowerCase().trim() as ShikiLanguageAlias;
  return SHIKI_LANGUAGE_ALIASES[label] ?? null;
}

export async function loadShikiLanguageRegistrations(): Promise<LanguageRegistration[]> {
  const registrations = (await Promise.all(
    SHIKI_LANGUAGE_REGISTRY.map(({ load }) => load()),
  )).flatMap(({ default: grammar }) => grammar);

  return registrations.filter((grammar, index, all) =>
    all.findIndex((candidate) => candidate.name === grammar.name) === index,
  );
}
