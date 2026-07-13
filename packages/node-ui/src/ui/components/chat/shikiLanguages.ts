/**
 * One contract for every fenced-code label accepted by CodeBlock and the
 * canonical Shiki language passed to the lazy highlighter.
 */
export const SHIKI_LANGUAGE_ALIASES = Object.freeze({
  ts: 'ts',
  typescript: 'ts',
  tsx: 'tsx',
  js: 'js',
  javascript: 'js',
  jsx: 'jsx',
  py: 'py',
  python: 'py',
  sh: 'sh',
  shell: 'sh',
  zsh: 'sh',
  bash: 'bash',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  sql: 'sql',
  sparql: 'sparql',
  md: 'md',
  markdown: 'md',
  html: 'html',
  css: 'css',
  solidity: 'solidity',
  sol: 'solidity',
  rust: 'rust',
  rs: 'rust',
  go: 'go',
  golang: 'go',
  toml: 'toml',
  diff: 'diff',
  patch: 'diff',
  dockerfile: 'dockerfile',
  docker: 'dockerfile',
  xml: 'xml',
} as const);

export type ShikiLanguageAlias = keyof typeof SHIKI_LANGUAGE_ALIASES;
export type SupportedShikiLanguage = typeof SHIKI_LANGUAGE_ALIASES[ShikiLanguageAlias];

export const SUPPORTED_SHIKI_LANGUAGE_ALIASES = Object.freeze(
  Object.keys(SHIKI_LANGUAGE_ALIASES) as ShikiLanguageAlias[],
);

export function normalizeShikiLanguage(raw: string | undefined): SupportedShikiLanguage | null {
  if (!raw) return null;
  const label = raw.toLowerCase().trim() as ShikiLanguageAlias;
  return SHIKI_LANGUAGE_ALIASES[label] ?? null;
}
