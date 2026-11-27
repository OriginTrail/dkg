import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { posix } from 'node:path';
import { parseAst, type Plugin } from 'vite';

// Rollup parses every module a package's entry re-exports before tree-shaking
// drops the ones nothing uses. `import { X } from 'lucide-react'` loads all
// ~1,700 icon modules, and force-graph's `import { throttle } from 'lodash-es'`
// all ~640 lodash modules. That is about 80 MB of the UI build's 896 MB heap.
const PACKAGES = ['lucide-react', 'lodash-es'];

type Target = { file: string; name: string };
/** The entry's re-exports, or why the package's imports can't be rewritten. */
type Entry = Map<string, Target> | string;
type Program = ReturnType<typeof parseAst>;
type Statement = Program['body'][number] & { start: number; end: number };
type Name = { type: string; name?: string; value?: unknown };

/**
 * In production builds, import each name from the module that defines it
 * instead of from the package's entry. Only packages that declare
 * `"sideEffects": false` are rewritten, so the bundle keeps the same code; an
 * import this can't map in full is left as written. A listed package that
 * can't be rewritten at all gets a build warning, since its whole entry is
 * parsed again.
 */
export function directBarrelImportsPlugin(packages: readonly string[] = PACKAGES): Plugin {
  const entries = new Map<string, Entry>();
  const warned = new Set<string>();
  return {
    name: 'dkg-direct-barrel-imports',
    apply: 'build',
    transform(code, importer) {
      if (importer.startsWith('\0') || importer.includes('?')) return null;
      if (!packages.some(name => code.includes(`'${name}'`) || code.includes(`"${name}"`))) return null;
      let program: Program;
      try { program = parseAst(code); } catch { return null; }
      let rewritten = '';
      let copied = 0;
      for (const node of program.body as Statement[]) {
        if (node.type !== 'ImportDeclaration') continue;
        const source = String(node.source.value);
        if (!packages.includes(source) || node.specifiers.length === 0) continue;
        const exports = packageExports(entries, source, importer);
        if (typeof exports === 'string') {
          if (!warned.has(source)) this.warn(`imports from ${source} load its whole entry: ${exports}`);
          warned.add(source);
          continue;
        }
        const imports = node.specifiers.map(specifier => specifier.type === 'ImportSpecifier'
          ? { local: specifier.local.name, target: exports.get(nameOf(specifier.imported)) }
          : undefined);
        if (imports.some(entry => !entry?.target)) continue;
        // One line per declaration, then the declaration's own line breaks, so
        // every later line keeps its number.
        const statement = imports.map(entry =>
          `import { ${exportName(entry!.target!.name)} as ${entry!.local} } from ${JSON.stringify(entry!.target!.file)};`).join(' ');
        const lineBreaks = code.slice(node.start, node.end).split('\n').length - 1;
        rewritten += code.slice(copied, node.start) + statement + '\n'.repeat(lineBreaks);
        copied = node.end;
      }
      if (copied === 0) return null;
      return { code: rewritten + code.slice(copied), map: null };
    },
  };
}

/**
 * The names a package's entry re-exports. The package is the nearest
 * `node_modules/<name>` above the importer, as the bundler finds it. This
 * deliberately doesn't ask Rollup to resolve the package: the CommonJS plugin
 * loads whatever a `.js` resolution points at, which would parse the whole
 * entry anyway.
 */
function packageExports(cache: Map<string, Entry>, packageName: string, importer: string): Entry {
  for (let dir = posix.dirname(importer); ; dir = posix.dirname(dir)) {
    const candidate = `${dir}/node_modules/${packageName}`;
    if (existsSync(`${candidate}/package.json`)) {
      const root = realpathSync(candidate).replaceAll('\\', '/');
      if (!cache.has(root)) cache.set(root, readEntry(root));
      return cache.get(root)!;
    }
    if (posix.dirname(dir) === dir) return `no node_modules/${packageName} above the importer`;
  }
}

/** Map each name the entry re-exports from a relative module to that module's export. */
function readEntry(root: string): Entry {
  const manifest = JSON.parse(readFileSync(`${root}/package.json`, 'utf8')) as Record<string, unknown>;
  if (manifest.sideEffects !== false) return 'its package.json does not declare "sideEffects": false';
  // A package with `exports` or `browser` may resolve to another entry than `module`.
  if (manifest.exports !== undefined || manifest.browser !== undefined) return 'its package.json has an "exports" or "browser" field';
  if (typeof manifest.module !== 'string') return 'its package.json has no "module" entry';
  const entry = posix.join(root, manifest.module);
  const exports = new Map<string, Target>();
  for (const node of parseAst(readFileSync(entry, 'utf8')).body) {
    if (node.type !== 'ExportNamedDeclaration' || !node.source) continue;
    const from = String(node.source.value);
    if (!from.startsWith('./') && !from.startsWith('../')) continue;
    const file = posix.join(posix.dirname(entry), from);
    for (const specifier of node.specifiers) {
      exports.set(nameOf(specifier.exported), { file, name: nameOf(specifier.local) });
    }
  }
  return exports;
}

function nameOf(node: Name): string {
  return node.type === 'Identifier' ? String(node.name) : String(node.value);
}

function exportName(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
}
