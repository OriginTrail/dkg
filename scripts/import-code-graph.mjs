#!/usr/bin/env node
/**
 * Build an AST-based code graph of the dkg-v9 monorepo and import it
 * into the `code` sub-graph of the `dkg-code-project` context graph.
 *
 * Produces N-Triples describing:
 *   - Packages  (monorepo packages under packages/)
 *   - Files     (.ts/.tsx source files under src/)
 *   - Classes / Interfaces / Functions / Type aliases / Enums
 *   - Imports   (file -> file or file -> external module)
 *
 * Usage:
 *   node scripts/import-code-graph.mjs
 *   node scripts/import-code-graph.mjs --project=dkg-code-project --subgraph=code
 *   node scripts/import-code-graph.mjs --api=http://localhost:9201 --max-files=50
 *   node scripts/import-code-graph.mjs --dry-run --out=/tmp/code.nt
 */

import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeClient, parseArgs, resolveToken } from './lib/dkg-daemon.mjs';
import {
  Code,
  Common,
  XSD,
  createTripleSink,
  uri,
  lit,
} from './lib/ontology.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const args = parseArgs();
const API_BASE = (args.api ?? process.env.DEVNET_API ?? 'http://localhost:9201').replace(/\/$/, '');
const PROJECT_ID = args.project ?? 'dkg-code-project';
const PROJECT_NAME = args.name ?? 'DKG Code memory';
const PROJECT_DESC =
  args.desc ??
  'Shared context graph for the dkg-v9 monorepo itself — code (AST), github (PRs/issues/commits), decisions, tasks, and a profile describing how this project is displayed.';
const SUBGRAPH = args.subgraph ?? 'code';
const ASSERTION_NAME = args.assertion ?? 'code-structure';
const MAX_FILES = args['max-files'] ? Number(args['max-files']) : Infinity;
const DRY_RUN = args['dry-run'] === 'true';
const OUT_FILE = args.out ?? null;

const EXCLUDED_PACKAGES = new Set([
  'origin-trail-game',
  'multi-agent-coding',
  'app-autoresearch',
]);

const sink = createTripleSink();
const { emit } = sink;

function pkgUri(name) { return Code.uri.package(name); }
function fileUri(pkgName, relPath) { return Code.uri.file(pkgName, relPath); }
function declUri(fileId, name, kind) { return Code.uri.decl(fileId, name, kind); }
function externalModuleUri(moduleName) { return Code.uri.module(moduleName); }

function listPackages() {
  const packagesDir = path.join(REPO_ROOT, 'packages');
  const entries = fs.readdirSync(packagesDir, { withFileTypes: true });
  const out = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (EXCLUDED_PACKAGES.has(ent.name)) continue;
    const pkgJsonPath = path.join(packagesDir, ent.name, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) continue;
    let pkgJson;
    try {
      pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    } catch {
      continue;
    }
    const srcDir = path.join(packagesDir, ent.name, 'src');
    if (!fs.existsSync(srcDir)) continue;
    out.push({
      folder: ent.name,
      name: pkgJson.name ?? ent.name,
      description: pkgJson.description ?? null,
      version: pkgJson.version ?? null,
      srcDir,
      rootDir: path.join(packagesDir, ent.name),
    });
  }
  return out;
}

function walkSrc(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name === '__tests__' || ent.name === 'coverage') continue;
      walkSrc(p, out);
    } else if (ent.isFile()) {
      if (!/\.(ts|tsx)$/.test(ent.name)) continue;
      if (/\.d\.ts$/.test(ent.name)) continue;
      if (/\.(test|spec)\.(ts|tsx)$/.test(ent.name)) continue;
      out.push(p);
    }
  }
  return out;
}

function extractFromFile(absPath, pkg) {
  const relToPkg = path.relative(pkg.rootDir, absPath);
  const relToRepo = path.relative(REPO_ROOT, absPath);
  const source = fs.readFileSync(absPath, 'utf8');
  const lineCount = source.split('\n').length;

  const scriptKind = absPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(absPath, source, ts.ScriptTarget.Latest, true, scriptKind);

  const fileId = fileUri(pkg.name, relToPkg);
  const fileName = path.basename(absPath);

  emit(uri(fileId), uri(Common.type), uri(Code.T.File));
  emit(uri(fileId), uri(Common.name), lit(fileName));
  emit(uri(fileId), uri(Common.label), lit(fileName));
  emit(uri(fileId), uri(Code.P.path), lit(relToRepo));
  emit(uri(fileId), uri(Code.P.package), lit(pkg.name));
  emit(uri(fileId), uri(Code.P.language), lit(absPath.endsWith('.tsx') ? 'tsx' : 'ts'));
  emit(uri(fileId), uri(Code.P.lineCount), lit(lineCount, XSD.int));

  const pkgId = pkgUri(pkg.name);
  emit(uri(pkgId), uri(Code.P.contains), uri(fileId));

  const declarations = [];
  function lineOf(pos) {
    return sf.getLineAndCharacterOfPosition(pos).line + 1;
  }
  function isNodeExported(node) {
    const mods = ts.getCombinedModifierFlags ? ts.getCombinedModifierFlags(node) : 0;
    return !!(mods & ts.ModifierFlags.Export) || node.parent?.kind === ts.SyntaxKind.SourceFile && !!(node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword));
  }
  function visit(node, inTopLevel) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      const target = resolveImport(absPath, pkg, spec);
      emit(uri(fileId), uri(Code.P.imports), uri(target));
    }
    if (!inTopLevel) {
      ts.forEachChild(node, c => visit(c, inTopLevel));
      return;
    }
    if (ts.isClassDeclaration(node) && node.name) {
      const name = node.name.text;
      const declId = declUri(fileId, name, 'class');
      declarations.push({ id: declId, name, type: Code.T.Class, startLine: lineOf(node.getStart(sf)), endLine: lineOf(node.getEnd()), kind: 'Class', isExported: isNodeExported(node) });
      for (const clause of node.heritageClauses ?? []) {
        const predicate = clause.token === ts.SyntaxKind.ExtendsKeyword ? Code.P.extends : Code.P.implements;
        for (const t of clause.types) {
          const base = getTypeName(t.expression);
          if (base) emit(uri(declId), uri(predicate), lit(base));
        }
      }
    } else if (ts.isInterfaceDeclaration(node)) {
      const name = node.name.text;
      const declId = declUri(fileId, name, 'interface');
      declarations.push({ id: declId, name, type: Code.T.Interface, startLine: lineOf(node.getStart(sf)), endLine: lineOf(node.getEnd()), kind: 'Interface', isExported: isNodeExported(node) });
      for (const clause of node.heritageClauses ?? []) {
        for (const t of clause.types) {
          const base = getTypeName(t.expression);
          if (base) emit(uri(declId), uri(Code.P.extends), lit(base));
        }
      }
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      const name = node.name.text;
      const declId = declUri(fileId, name, 'function');
      declarations.push({ id: declId, name, type: Code.T.Function, startLine: lineOf(node.getStart(sf)), endLine: lineOf(node.getEnd()), kind: 'Function', isExported: isNodeExported(node), isAsync: !!node.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword), paramCount: node.parameters.length });
    } else if (ts.isTypeAliasDeclaration(node)) {
      const name = node.name.text;
      const declId = declUri(fileId, name, 'type');
      declarations.push({ id: declId, name, type: Code.T.TypeAlias, startLine: lineOf(node.getStart(sf)), endLine: lineOf(node.getEnd()), kind: 'TypeAlias', isExported: isNodeExported(node) });
    } else if (ts.isEnumDeclaration(node)) {
      const name = node.name.text;
      const declId = declUri(fileId, name, 'enum');
      declarations.push({ id: declId, name, type: Code.T.Enum, startLine: lineOf(node.getStart(sf)), endLine: lineOf(node.getEnd()), kind: 'Enum', isExported: isNodeExported(node) });
    } else if (ts.isVariableStatement(node)) {
      const isExported = !!node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const name = decl.name.text;
        const init = decl.initializer;
        if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          const declId = declUri(fileId, name, 'function');
          declarations.push({ id: declId, name, type: Code.T.Function, startLine: lineOf(node.getStart(sf)), endLine: lineOf(node.getEnd()), kind: ts.isArrowFunction(init) ? 'ArrowFunction' : 'FunctionExpression', isExported, isAsync: !!init.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword), paramCount: init.parameters.length });
        }
      }
    }
  }
  ts.forEachChild(sf, c => visit(c, true));

  for (const d of declarations) {
    emit(uri(d.id), uri(Common.type), uri(d.type));
    emit(uri(d.id), uri(Common.name), lit(d.name));
    emit(uri(d.id), uri(Common.label), lit(d.name));
    emit(uri(d.id), uri(Code.P.definedIn), uri(fileId));
    emit(uri(fileId), uri(Code.P.contains), uri(d.id));
    emit(uri(d.id), uri(Code.P.startLine), lit(d.startLine, XSD.int));
    emit(uri(d.id), uri(Code.P.endLine), lit(d.endLine, XSD.int));
    emit(uri(d.id), uri(Code.P.kind), lit(d.kind));
    if (d.isExported) {
      emit(uri(d.id), uri(Code.P.isExported), lit('true', XSD.bool));
      emit(uri(fileId), uri(Code.P.exports), uri(d.id));
    }
    if (d.isAsync) emit(uri(d.id), uri(Code.P.isAsync), lit('true', XSD.bool));
    if (typeof d.paramCount === 'number') emit(uri(d.id), uri(Code.P.paramCount), lit(d.paramCount, XSD.int));
  }
  return { fileId, declarations, lineCount };
}

function getTypeName(expr) {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

const allFilesByAbs = new Map();

function resolveImport(fromAbs, fromPkg, spec) {
  if (spec.startsWith('.') || spec.startsWith('/')) {
    const baseDir = path.dirname(fromAbs);
    const stripped = spec.replace(/\.(js|jsx|mjs|cjs)$/, '');
    const candidates = [
      spec,
      stripped,
      stripped + '.ts',
      stripped + '.tsx',
      path.join(stripped, 'index.ts'),
      path.join(stripped, 'index.tsx'),
    ];
    for (const c of candidates) {
      const abs = path.resolve(baseDir, c);
      if (allFilesByAbs.has(abs)) return allFilesByAbs.get(abs).fileUri;
    }
    return externalModuleUri(spec);
  }
  for (const pkg of knownPkgsByName.values()) {
    if (spec === pkg.name || spec.startsWith(pkg.name + '/')) {
      return pkgUri(pkg.name);
    }
  }
  const parts = spec.split('/');
  const modName = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  return externalModuleUri(modName);
}

const packages = listPackages();
const knownPkgsByName = new Map(packages.map(p => [p.name, p]));
console.log(`[code-graph] Found ${packages.length} packages.`);

const allFiles = [];
for (const pkg of packages) {
  const files = walkSrc(pkg.srcDir);
  for (const abs of files) {
    const relToPkg = path.relative(pkg.rootDir, abs);
    const fUri = fileUri(pkg.name, relToPkg);
    allFilesByAbs.set(abs, { pkg, relToPkg, fileUri: fUri });
    allFiles.push({ abs, pkg, relToPkg });
  }
}
console.log(`[code-graph] Found ${allFiles.length} .ts/.tsx source files.`);

for (const pkg of packages) {
  const id = pkgUri(pkg.name);
  emit(uri(id), uri(Common.type), uri(Code.T.Package));
  emit(uri(id), uri(Common.name), lit(pkg.name));
  emit(uri(id), uri(Common.label), lit(pkg.folder));
  if (pkg.description) emit(uri(id), uri(Common.description), lit(pkg.description));
  if (pkg.version) emit(uri(id), uri(Code.P.path), lit(`packages/${pkg.folder}`));
}

let processed = 0;
const filesToProcess = MAX_FILES < allFiles.length ? allFiles.slice(0, MAX_FILES) : allFiles;
for (const f of filesToProcess) {
  try {
    extractFromFile(f.abs, f.pkg);
    processed++;
    if (processed % 50 === 0) {
      console.log(`[code-graph] ...parsed ${processed}/${filesToProcess.length} files, ${sink.size()} triples so far.`);
    }
  } catch (err) {
    console.warn(`[code-graph] Failed to parse ${f.abs}: ${err.message}`);
  }
}
console.log(`[code-graph] Parsed ${processed} files, produced ${sink.size()} unique triples.`);

if (OUT_FILE) {
  const nt = sink.triples.map(t => `${t.subject} ${t.predicate} ${t.object} .`).join('\n') + '\n';
  fs.writeFileSync(OUT_FILE, nt);
  console.log(`[code-graph] Wrote ${sink.size()} triples to ${OUT_FILE}`);
}

if (DRY_RUN) {
  console.log('[code-graph] --dry-run set; not importing.');
  process.exit(0);
}

const token = resolveToken(REPO_ROOT);
const client = makeClient({ apiBase: API_BASE, token });

const { cgId } = await client.ensureProject({
  id: PROJECT_ID,
  name: PROJECT_NAME,
  description: PROJECT_DESC,
});
await client.ensureSubGraph(cgId, SUBGRAPH);

await client.writeAssertion(
  {
    contextGraphId: cgId,
    assertionName: ASSERTION_NAME,
    subGraphName: SUBGRAPH,
    triples: sink.triples,
  },
  { label: 'code' },
);
console.log(`[code-graph] Done. Imported ${sink.size()} triples into ${cgId}/${SUBGRAPH}/${ASSERTION_NAME}.`);
