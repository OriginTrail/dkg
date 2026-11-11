// One inventory of the UI's source for the design-rule suites: which files there are,
// their text (read once per run), where a finding is, and how findings are reported.
// Suites keep only their own rule: what to look for and what to let through.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/** The package root (packages/node-ui) and the UI source under it. */
export const ROOT = join(__dirname, '../..');
export const UI = join(ROOT, 'src/ui');

/** Every file under a directory. */
export const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (
  e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]
));

export const uiFiles = walk(UI);
export const cssFiles = uiFiles.filter((f) => f.endsWith('.css'));
export const tsxFiles = uiFiles.filter((f) => f.endsWith('.tsx'));
/** TypeScript and TSX: the code that renders and formats. */
export const codeFiles = uiFiles.filter((f) => /\.tsx?$/.test(f));

const texts = new Map<string, string>();
/** A file's text, read once per run. Takes an absolute path or one relative to src/ui. */
export function read(file: string): string {
  const path = file.startsWith(UI) || file.startsWith(ROOT) ? file : join(UI, file);
  let text = texts.get(path);
  if (text === undefined) { text = readFileSync(path, 'utf8'); texts.set(path, text); }
  return text;
}

/** A file's place in the UI source, with forward slashes, as findings name it. */
export const where = (file: string): string => relative(UI, file).replace(/\\/g, '/');

/** CSS without its comments, so a rule written in a comment doesn't count. */
export const withoutCssComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

export interface FindOptions {
  /** Turns a file's text into what is searched (drop comments, say). */
  prepare?: (text: string) => string;
  /** Which matches are findings; all of them by default. */
  keep?: (m: RegExpMatchArray) => boolean;
  /** How a finding shows its match; the first 70 characters by default. */
  show?: (m: RegExpMatchArray) => string;
}

/** Every finding of `pattern` (with the g flag) across `files`, as "path: match". */
export function findAll(files: string[], pattern: RegExp, { prepare = (t) => t, keep = () => true, show = (m) => m[0].slice(0, 70) }: FindOptions = {}): string[] {
  return files.flatMap((file) => [...prepare(read(file)).matchAll(pattern)].filter(keep).map((m) => `${where(file)}: ${show(m)}`));
}
