/**
 * Code graph indexer — parses a monorepo into devgraph: RDF quads.
 *
 * Extracts:
 *   - Package (workspace deps) from package.json
 *   - CodeModule (source files) with import edges
 *   - Function / Class declarations with signatures
 *   - Contract (Solidity) with inheritance and events
 *   - Python module/class/function extraction (regex-based)
 *
 * Uses ts.createSourceFile (AST-only, no full compilation) for TypeScript/JavaScript
 * and regex-based extraction for Solidity/Python.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, relative, extname, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import ts from 'typescript';

const DEVGRAPH = 'https://ontology.dkg.io/devgraph#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

export interface Quad {
  subject: string;
  predicate: string;
  object: string;
  graph: string;
}

function uri(s: string): string { return s; }
function literal(s: string): string { return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`; }
function intLiteral(n: number): string { return `"${n}"^^<http://www.w3.org/2001/XMLSchema#integer>`; }

function moduleUri(repoRoot: string, filePath: string): string {
  const rel = relative(repoRoot, filePath).replace(/\\/g, '/');
  return `file:${rel}`;
}

function packageUri(name: string): string {
  return `pkg:${name.replace(/[^a-zA-Z0-9@/_-]/g, '_')}`;
}

function symbolUri(repoRoot: string, filePath: string, name: string, kind: string): string {
  const rel = relative(repoRoot, filePath).replace(/\\/g, '/');
  return `symbol:${rel}/${kind}/${encodeURIComponent(name)}`;
}

function moduleBaseQuads(repoRoot: string, filePath: string, pkgName: string, lineCount: number): Quad[] {
  const graph = 'did:dkg:paranet:dev-coordination';
  const modUri = uri(moduleUri(repoRoot, filePath));
  return [
    { subject: modUri, predicate: uri(RDF_TYPE), object: uri(`${DEVGRAPH}CodeModule`), graph },
    { subject: modUri, predicate: uri(`${DEVGRAPH}path`), object: literal(relative(repoRoot, filePath)), graph },
    { subject: modUri, predicate: uri(`${DEVGRAPH}lineCount`), object: intLiteral(lineCount), graph },
    { subject: modUri, predicate: uri(`${DEVGRAPH}containedIn`), object: uri(packageUri(pkgName)), graph },
  ];
}

// ---------------------------------------------------------------------------
// Package indexing
// ---------------------------------------------------------------------------

interface PkgInfo {
  name: string;
  path: string;
  deps: string[];
}

async function indexPackages(repoRoot: string): Promise<{ packages: PkgInfo[]; quads: Quad[] }> {
  const quads: Quad[] = [];
  const packages: PkgInfo[] = [];

  const workspaceYaml = join(repoRoot, 'pnpm-workspace.yaml');
  if (!existsSync(workspaceYaml)) return { packages, quads };

  const raw = await readFile(workspaceYaml, 'utf-8');

  // Parse workspace patterns — handles both quoted ("packages/*") and bare (- .) entries
  const patterns: string[] = [];
  for (const match of raw.matchAll(/^\s*-\s+"?([^"\n]+?)"?\s*$/gm)) {
    patterns.push(match[1].trim());
  }

  // Collect all workspace package names for dep resolution
  const workspacePkgNames = new Set<string>();

  async function addPackage(pkgDir: string) {
    const pkgJson = join(pkgDir, 'package.json');
    if (!existsSync(pkgJson)) return;
    try {
      const pkg = JSON.parse(await readFile(pkgJson, 'utf-8'));
      const name = pkg.name as string;
      if (!name) return;
      workspacePkgNames.add(name);

      const pkgPath = relative(repoRoot, pkgDir) || '.';
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      const deps = Object.entries(allDeps ?? {})
        .filter(([, v]) => typeof v === 'string' && (v as string).startsWith('workspace:'))
        .map(([k]) => k);

      packages.push({ name, path: pkgPath, deps });
    } catch { /* skip malformed package.json */ }
  }

  for (const pattern of patterns) {
    if (pattern.endsWith('/*')) {
      const baseDir = join(repoRoot, pattern.replace('/*', ''));
      if (!existsSync(baseDir)) continue;
      const entries = await readdir(baseDir);
      for (const entry of entries) {
        await addPackage(join(baseDir, entry));
      }
    } else {
      // Direct path (e.g., ".", "ui")
      await addPackage(join(repoRoot, pattern));
    }
  }

  // Second pass: also include deps that match any workspace package name
  for (const pkg of packages) {
    const pkgJson = join(repoRoot, pkg.path, 'package.json');
    try {
      const raw = JSON.parse(await readFile(pkgJson, 'utf-8'));
      const allDeps = { ...raw.dependencies, ...raw.devDependencies };
      for (const [depName, depVersion] of Object.entries(allDeps ?? {})) {
        if (workspacePkgNames.has(depName) && !pkg.deps.includes(depName)) {
          pkg.deps.push(depName);
        }
      }
    } catch { /* already loaded */ }
  }

  const graph = 'did:dkg:paranet:dev-coordination';
  for (const pkg of packages) {
    const subj = uri(packageUri(pkg.name));
    quads.push({ subject: subj, predicate: uri(RDF_TYPE), object: uri(`${DEVGRAPH}Package`), graph });
    quads.push({ subject: subj, predicate: uri(`${DEVGRAPH}name`), object: literal(pkg.name), graph });
    quads.push({ subject: subj, predicate: uri(`${DEVGRAPH}path`), object: literal(pkg.path), graph });

    for (const dep of pkg.deps) {
      const depName = dep.startsWith('workspace:') ? dep : dep;
      quads.push({ subject: subj, predicate: uri(`${DEVGRAPH}dependsOn`), object: uri(packageUri(depName)), graph });
    }
  }

  return { packages, quads };
}

// ---------------------------------------------------------------------------
// TypeScript file indexing
// ---------------------------------------------------------------------------

async function indexTypeScriptFile(
  repoRoot: string, filePath: string, pkgName: string,
): Promise<Quad[]> {
  const quads: Quad[] = [];
  const graph = 'did:dkg:paranet:dev-coordination';
  const modUri = uri(moduleUri(repoRoot, filePath));

  const source = await readFile(filePath, 'utf-8');
  const lineCount = source.split('\n').length;
  quads.push(...moduleBaseQuads(repoRoot, filePath, pkgName, lineCount));

  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);

  // Extract imports
  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const importPath = stmt.moduleSpecifier.text;
      if (importPath.startsWith('.')) {
        const resolved = resolveRelativeImport(filePath, importPath);
        const targetUri = uri(moduleUri(repoRoot, resolved));
        quads.push({ subject: modUri, predicate: uri(`${DEVGRAPH}imports`), object: targetUri, graph });
      }
    }
  }

  // Extract exported functions and classes
  for (const stmt of sourceFile.statements) {
    const isExported = ts.canHaveModifiers(stmt)
      ? (ts.getModifiers(stmt) ?? []).some(m => m.kind === ts.SyntaxKind.ExportKeyword)
      : false;
    if (!isExported) continue;

    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      const name = stmt.name.text;
      const symUri = uri(symbolUri(repoRoot, filePath, name, 'fn'));
      const sig = extractFunctionSignature(stmt, source);

      quads.push({ subject: symUri, predicate: uri(RDF_TYPE), object: uri(`${DEVGRAPH}Function`), graph });
      quads.push({ subject: symUri, predicate: uri(`${DEVGRAPH}name`), object: literal(name), graph });
      quads.push({ subject: symUri, predicate: uri(`${DEVGRAPH}definedIn`), object: modUri, graph });
      if (sig) quads.push({ subject: symUri, predicate: uri(`${DEVGRAPH}signature`), object: literal(sig), graph });

      for (const param of stmt.parameters) {
        const paramText = param.getText(sourceFile);
        quads.push({ subject: symUri, predicate: uri(`${DEVGRAPH}parameter`), object: literal(paramText), graph });
      }

      if (stmt.type) {
        quads.push({ subject: symUri, predicate: uri(`${DEVGRAPH}returnType`), object: literal(stmt.type.getText(sourceFile)), graph });
      }
    }

    if (ts.isClassDeclaration(stmt) && stmt.name) {
      const className = stmt.name.text;
      const classUri = uri(symbolUri(repoRoot, filePath, className, 'class'));

      quads.push({ subject: classUri, predicate: uri(RDF_TYPE), object: uri(`${DEVGRAPH}Class`), graph });
      quads.push({ subject: classUri, predicate: uri(`${DEVGRAPH}name`), object: literal(className), graph });
      quads.push({ subject: classUri, predicate: uri(`${DEVGRAPH}definedIn`), object: modUri, graph });

      // Heritage clauses (extends, implements)
      for (const clause of stmt.heritageClauses ?? []) {
        for (const type of clause.types) {
          const parentName = type.expression.getText(sourceFile);
          if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
            quads.push({ subject: classUri, predicate: uri(`${DEVGRAPH}extends`), object: literal(parentName), graph });
          } else {
            quads.push({ subject: classUri, predicate: uri(`${DEVGRAPH}implements`), object: literal(parentName), graph });
          }
        }
      }

      // Methods
      for (const member of stmt.members) {
        if (ts.isMethodDeclaration(member) && member.name) {
          const methodName = member.name.getText(sourceFile);
          const methodUri = uri(symbolUri(repoRoot, filePath, `${className}.${methodName}`, 'fn'));
          const methodSig = extractMethodSignature(member, sourceFile);

          quads.push({ subject: methodUri, predicate: uri(RDF_TYPE), object: uri(`${DEVGRAPH}Function`), graph });
          quads.push({ subject: methodUri, predicate: uri(`${DEVGRAPH}name`), object: literal(methodName), graph });
          quads.push({ subject: methodUri, predicate: uri(`${DEVGRAPH}definedIn`), object: modUri, graph });
          quads.push({ subject: classUri, predicate: uri(`${DEVGRAPH}hasMethod`), object: methodUri, graph });
          if (methodSig) quads.push({ subject: methodUri, predicate: uri(`${DEVGRAPH}signature`), object: literal(methodSig), graph });
        }
      }
    }
  }

  // Check for test file
  const rel = relative(repoRoot, filePath);
  const testCandidates = [
    rel.replace('/src/', '/test/').replace('.ts', '.test.ts'),
    rel.replace('/src/', '/test/').replace('.ts', '.spec.ts'),
  ];
  for (const tc of testCandidates) {
    if (existsSync(join(repoRoot, tc))) {
      quads.push({ subject: modUri, predicate: uri(`${DEVGRAPH}testFile`), object: uri(`file:${tc}`), graph });
      break;
    }
  }

  return quads;
}

async function indexJavaScriptFile(
  repoRoot: string, filePath: string, pkgName: string,
): Promise<Quad[]> {
  const graph = 'did:dkg:paranet:dev-coordination';
  const quads: Quad[] = [];
  const modUri = uri(moduleUri(repoRoot, filePath));

  const source = await readFile(filePath, 'utf-8');
  const lineCount = source.split('\n').length;
  quads.push(...moduleBaseQuads(repoRoot, filePath, pkgName, lineCount));

  const kind = filePath.endsWith('.jsx') ? ts.ScriptKind.JSX : ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, kind);

  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const importPath = stmt.moduleSpecifier.text;
      if (importPath.startsWith('.')) {
        const resolved = resolveRelativeImportWithExt(filePath, importPath, '.js');
        const targetUri = uri(moduleUri(repoRoot, resolved));
        quads.push({ subject: modUri, predicate: uri(`${DEVGRAPH}imports`), object: targetUri, graph });
      }
    }
  }

  for (const stmt of sourceFile.statements) {
    const isExported = ts.canHaveModifiers(stmt)
      ? (ts.getModifiers(stmt) ?? []).some(m => m.kind === ts.SyntaxKind.ExportKeyword)
      : false;
    if (!isExported) continue;

    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      const name = stmt.name.text;
      const fnUri = uri(symbolUri(repoRoot, filePath, name, 'fn'));
      const sig = extractFunctionSignature(stmt, source);
      quads.push({ subject: fnUri, predicate: uri(RDF_TYPE), object: uri(`${DEVGRAPH}Function`), graph });
      quads.push({ subject: fnUri, predicate: uri(`${DEVGRAPH}name`), object: literal(name), graph });
      quads.push({ subject: fnUri, predicate: uri(`${DEVGRAPH}definedIn`), object: modUri, graph });
      if (sig) quads.push({ subject: fnUri, predicate: uri(`${DEVGRAPH}signature`), object: literal(sig), graph });
    }

    if (ts.isClassDeclaration(stmt) && stmt.name) {
      const className = stmt.name.text;
      const classUri = uri(symbolUri(repoRoot, filePath, className, 'class'));
      quads.push({ subject: classUri, predicate: uri(RDF_TYPE), object: uri(`${DEVGRAPH}Class`), graph });
      quads.push({ subject: classUri, predicate: uri(`${DEVGRAPH}name`), object: literal(className), graph });
      quads.push({ subject: classUri, predicate: uri(`${DEVGRAPH}definedIn`), object: modUri, graph });
    }
  }

  const rel = relative(repoRoot, filePath);
  const testCandidates = [
    rel.replace('/src/', '/test/').replace(/\.jsx?$/, '.test.js'),
    rel.replace('/src/', '/test/').replace(/\.jsx?$/, '.spec.js'),
  ];
  for (const tc of testCandidates) {
    if (existsSync(join(repoRoot, tc))) {
      quads.push({ subject: modUri, predicate: uri(`${DEVGRAPH}testFile`), object: uri(`file:${tc}`), graph });
      break;
    }
  }

  return quads;
}

async function indexPythonFile(
  repoRoot: string, filePath: string, pkgName: string,
): Promise<Quad[]> {
  const graph = 'did:dkg:paranet:dev-coordination';
  const quads: Quad[] = [];
  const modUri = uri(moduleUri(repoRoot, filePath));

  const source = await readFile(filePath, 'utf-8');
  const lineCount = source.split('\n').length;
  quads.push(...moduleBaseQuads(repoRoot, filePath, pkgName, lineCount));

  const importRe = /^\s*(?:from\s+([.\w]+)\s+import|import\s+([.\w]+))/gm;
  let match: RegExpExecArray | null;
  while ((match = importRe.exec(source))) {
    const importPath = (match[1] ?? match[2] ?? '').trim();
    if (!importPath) continue;
    if (importPath.startsWith('.')) {
      const leadingDots = importPath.match(/^(\.+)/)![1];
      const depth = leadingDots.length - 1;
      const moduleName = importPath.slice(leadingDots.length);
      let baseDir = dirname(filePath);
      for (let d = 0; d < depth; d++) baseDir = dirname(baseDir);
      const modulePath = moduleName ? moduleName.replace(/\./g, '/') + '.py' : '__init__.py';
      const resolved = join(baseDir, modulePath);
      quads.push({ subject: modUri, predicate: uri(`${DEVGRAPH}imports`), object: uri(moduleUri(repoRoot, resolved)), graph });
    } else {
      quads.push({ subject: modUri, predicate: uri(`${DEVGRAPH}imports`), object: literal(importPath), graph });
    }
  }

  const classRe = /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)(?:\(([^)]*)\))?:/gm;
  while ((match = classRe.exec(source))) {
    const className = match[1];
    const bases = (match[2] ?? '').split(',').map(s => s.trim()).filter(Boolean);
    const classUri = uri(symbolUri(repoRoot, filePath, className, 'class'));
    quads.push({ subject: classUri, predicate: uri(RDF_TYPE), object: uri(`${DEVGRAPH}Class`), graph });
    quads.push({ subject: classUri, predicate: uri(`${DEVGRAPH}name`), object: literal(className), graph });
    quads.push({ subject: classUri, predicate: uri(`${DEVGRAPH}definedIn`), object: modUri, graph });
    for (const base of bases) {
      quads.push({ subject: classUri, predicate: uri(`${DEVGRAPH}extends`), object: literal(base), graph });
    }
  }

  const fnRe = /^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*(?:->\s*([^\n:]+))?:/gm;
  while ((match = fnRe.exec(source))) {
    const fnName = match[1];
    const params = (match[2] ?? '').trim();
    const ret = (match[3] ?? '').trim();
    const fnUri = uri(symbolUri(repoRoot, filePath, fnName, 'fn'));

    quads.push({ subject: fnUri, predicate: uri(RDF_TYPE), object: uri(`${DEVGRAPH}Function`), graph });
    quads.push({ subject: fnUri, predicate: uri(`${DEVGRAPH}name`), object: literal(fnName), graph });
    quads.push({ subject: fnUri, predicate: uri(`${DEVGRAPH}definedIn`), object: modUri, graph });
    if (params) {
      for (const p of params.split(',').map(s => s.trim()).filter(Boolean)) {
        quads.push({ subject: fnUri, predicate: uri(`${DEVGRAPH}parameter`), object: literal(p), graph });
      }
    }
    if (ret) quads.push({ subject: fnUri, predicate: uri(`${DEVGRAPH}returnType`), object: literal(ret), graph });
  }

  const rel = relative(repoRoot, filePath);
  const baseRel = rel.replace('/src/', '/test/').replace(/\.py$/, '');
  const testCandidates = [
    `${baseRel}_test.py`,
    `${baseRel}.test.py`,
    rel.replace('/src/', '/tests/'),
  ];
  for (const tc of testCandidates) {
    if (existsSync(join(repoRoot, tc))) {
      quads.push({ subject: modUri, predicate: uri(`${DEVGRAPH}testFile`), object: uri(`file:${tc}`), graph });
      break;
    }
  }

  return quads;
}

async function indexContentFile(
  repoRoot: string, filePath: string, pkgName: string,
): Promise<Quad[]> {
  const graph = 'did:dkg:paranet:dev-coordination';
  const source = await readFile(filePath, 'utf-8');
  const lineCount = source.split('\n').length;
  const wordCount = source.trim().length ? source.trim().split(/\s+/).length : 0;
  const modUri = uri(moduleUri(repoRoot, filePath));
  const quads: Quad[] = moduleBaseQuads(repoRoot, filePath, pkgName, lineCount);

  quads.push({ subject: modUri, predicate: uri(RDF_TYPE), object: uri(`${DEVGRAPH}Document`), graph });
  quads.push({ subject: modUri, predicate: uri(`${DEVGRAPH}wordCount`), object: intLiteral(wordCount), graph });

  const relPath = relative(repoRoot, filePath);
  const title = extractDocumentTitle(source, relPath);
  if (title) {
    quads.push({ subject: modUri, predicate: uri(`${DEVGRAPH}title`), object: literal(title), graph });
  }

  const links = extractMarkdownLinks(source);
  for (const link of links) {
    quads.push({ subject: modUri, predicate: uri(`${DEVGRAPH}references`), object: literal(link), graph });
  }

  return quads;
}

function resolveRelativeImport(fromFile: string, importPath: string): string {
  const dir = dirname(fromFile);
  let resolved = join(dir, importPath);
  if (!extname(resolved)) resolved += '.ts';
  resolved = resolved.replace(/\.js$/, '.ts');
  return resolved;
}

function resolveRelativeImportWithExt(fromFile: string, importPath: string, fallbackExt: string): string {
  const dir = dirname(fromFile);
  let resolved = join(dir, importPath);
  if (!extname(resolved)) resolved += fallbackExt;
  return resolved;
}

function extractDocumentTitle(source: string, fallbackPath: string): string {
  const h1 = source.match(/^\s*#\s+(.+?)\s*$/m);
  if (h1?.[1]) return h1[1].trim();

  const firstNonEmpty = source.split('\n').map(l => l.trim()).find(Boolean);
  if (firstNonEmpty) return firstNonEmpty.slice(0, 120);
  return fallbackPath;
}

function extractMarkdownLinks(source: string): string[] {
  const links = new Set<string>();
  const re = /\[[^\]]*?\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    if (match[1]) links.add(match[1].trim());
  }
  return [...links];
}

function extractFunctionSignature(node: ts.FunctionDeclaration, source: string): string | null {
  const start = node.getStart();
  const bodyStart = node.body?.getStart() ?? node.getEnd();
  const sig = source.slice(start, bodyStart).trim();
  return sig.length > 200 ? sig.slice(0, 200) + '...' : sig;
}

function extractMethodSignature(node: ts.MethodDeclaration, sourceFile: ts.SourceFile): string | null {
  const name = node.name.getText(sourceFile);
  const params = node.parameters.map(p => p.getText(sourceFile)).join(', ');
  const ret = node.type ? ': ' + node.type.getText(sourceFile) : '';
  return `${name}(${params})${ret}`;
}

// ---------------------------------------------------------------------------
// Solidity file indexing
// ---------------------------------------------------------------------------

async function indexSolidityFile(repoRoot: string, filePath: string, pkgName: string): Promise<Quad[]> {
  const quads: Quad[] = [];
  const graph = 'did:dkg:paranet:dev-coordination';
  const modUri = uri(moduleUri(repoRoot, filePath));

  const source = await readFile(filePath, 'utf-8');
  const lineCount = source.split('\n').length;
  quads.push(...moduleBaseQuads(repoRoot, filePath, pkgName, lineCount));

  // Imports
  const importRe = /import\s+.*?from\s+["'](.+?)["']/g;
  let match;
  while ((match = importRe.exec(source))) {
    const importPath = match[1];
    if (importPath.startsWith('.')) {
      const resolved = join(dirname(filePath), importPath);
      quads.push({ subject: modUri, predicate: uri(`${DEVGRAPH}imports`), object: uri(moduleUri(repoRoot, resolved)), graph });
    }
  }

  // Contracts
  const contractRe = /^\s*(?:abstract\s+)?contract\s+(\w+)(?:\s+is\s+([^{]+))?\s*\{/gm;
  while ((match = contractRe.exec(source))) {
    const contractName = match[1];
    const parents = match[2]?.split(',').map(s => s.trim()).filter(Boolean) ?? [];
    const contractUri = uri(symbolUri(repoRoot, filePath, contractName, 'contract'));

    quads.push({ subject: contractUri, predicate: uri(RDF_TYPE), object: uri(`${DEVGRAPH}Contract`), graph });
    quads.push({ subject: contractUri, predicate: uri(`${DEVGRAPH}name`), object: literal(contractName), graph });
    quads.push({ subject: contractUri, predicate: uri(`${DEVGRAPH}definedIn`), object: modUri, graph });

    for (const parent of parents) {
      quads.push({ subject: contractUri, predicate: uri(`${DEVGRAPH}inherits`), object: literal(parent), graph });
    }
  }

  // Functions
  const funcRe = /^\s*function\s+(\w+)\s*\(([^)]*)\)(?:\s+(?:external|public|internal|private))?\s*(?:(?:view|pure|payable)\s*)*(?:returns\s*\(([^)]*)\))?/gm;
  while ((match = funcRe.exec(source))) {
    const funcName = match[1];
    const params = match[2]?.trim() || '';
    const returns = match[3]?.trim() || '';
    const funcUri = uri(symbolUri(repoRoot, filePath, funcName, 'fn'));

    quads.push({ subject: funcUri, predicate: uri(RDF_TYPE), object: uri(`${DEVGRAPH}Function`), graph });
    quads.push({ subject: funcUri, predicate: uri(`${DEVGRAPH}name`), object: literal(funcName), graph });
    quads.push({ subject: funcUri, predicate: uri(`${DEVGRAPH}definedIn`), object: modUri, graph });
    if (params) quads.push({ subject: funcUri, predicate: uri(`${DEVGRAPH}parameter`), object: literal(params), graph });
    if (returns) quads.push({ subject: funcUri, predicate: uri(`${DEVGRAPH}returnType`), object: literal(returns), graph });
  }

  // Events
  const eventRe = /^\s*event\s+(\w+)\s*\(/gm;
  while ((match = eventRe.exec(source))) {
    const eventName = match[1];
    // Find the contract this event belongs to (nearest contract above this line)
    const linesBefore = source.slice(0, match.index);
    const contractMatch = [...linesBefore.matchAll(/contract\s+(\w+)/g)].pop();
    if (contractMatch) {
      const contractUri = uri(symbolUri(repoRoot, filePath, contractMatch[1], 'contract'));
      quads.push({ subject: contractUri, predicate: uri(`${DEVGRAPH}emitsEvent`), object: literal(eventName), graph });
    }
  }

  return quads;
}

// ---------------------------------------------------------------------------
// Directory walker
// ---------------------------------------------------------------------------

async function* walkFiles(dir: string, extensions: Set<string>): AsyncGenerator<string> {
  const skipDirs = new Set(['node_modules', 'dist', '.git', 'artifacts', 'cache', 'typechain-types', 'deployments']);

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      yield* walkFiles(full, extensions);
    } else if (entry.isFile() && extensions.has(extname(entry.name))) {
      yield full;
    }
  }
}

// ---------------------------------------------------------------------------
// Main indexer
// ---------------------------------------------------------------------------

export interface IndexResult {
  quads: Quad[];
  packageCount: number;
  moduleCount: number;
  functionCount: number;
  classCount: number;
  contractCount: number;
}

export interface IndexOptions {
  includeContent?: boolean;
}

interface LanguageExtractor {
  id: string;
  roots: string[];
  extensions: Set<string>;
  indexFile: (repoRoot: string, filePath: string, pkgName: string) => Promise<Quad[]>;
}

const CODE_EXTRACTORS: LanguageExtractor[] = [
  {
    id: 'typescript',
    roots: ['src'],
    extensions: new Set(['.ts', '.tsx']),
    indexFile: indexTypeScriptFile,
  },
  {
    id: 'javascript',
    roots: ['src'],
    extensions: new Set(['.js', '.jsx', '.mjs', '.cjs']),
    indexFile: indexJavaScriptFile,
  },
  {
    id: 'python',
    roots: ['src'],
    extensions: new Set(['.py']),
    indexFile: indexPythonFile,
  },
  {
    id: 'solidity',
    roots: ['contracts'],
    extensions: new Set(['.sol']),
    indexFile: indexSolidityFile,
  },
];

const CONTENT_EXTRACTOR: LanguageExtractor = {
  id: 'content',
  roots: ['.'],
  extensions: new Set(['.md', '.txt', '.json', '.yaml', '.yml']),
  indexFile: indexContentFile,
};

export async function indexRepository(repoRoot: string, options: IndexOptions = {}): Promise<IndexResult> {
  const allQuads: Quad[] = [];
  let moduleCount = 0;
  let functionCount = 0;
  let classCount = 0;
  let contractCount = 0;
  const includeContent = options.includeContent ?? false;

  // Index packages
  const { packages, quads: pkgQuads } = await indexPackages(repoRoot);
  allQuads.push(...pkgQuads);

  // Build a map of directory → package name
  const dirToPkg = new Map<string, string>();
  for (const pkg of packages) {
    dirToPkg.set(join(repoRoot, pkg.path), pkg.name);
  }

  function findPackage(filePath: string): string {
    let dir = dirname(filePath);
    while (dir.length >= repoRoot.length) {
      const pkgName = dirToPkg.get(dir);
      if (pkgName) return pkgName;
      dir = dirname(dir);
    }
    return 'unknown';
  }

  for (const extractor of CODE_EXTRACTORS) {
    for (const pkg of packages) {
      for (const relRoot of extractor.roots) {
        const rootDir = join(repoRoot, pkg.path, relRoot);
        if (!existsSync(rootDir)) continue;

        for await (const file of walkFiles(rootDir, extractor.extensions)) {
          if (file.endsWith('.d.ts')) continue;
          try {
            const quads = await extractor.indexFile(repoRoot, file, pkg.name);
            allQuads.push(...quads);
            moduleCount++;
            functionCount += quads.filter(q => q.object === uri(`${DEVGRAPH}Function`)).length;
            classCount += quads.filter(q => q.object === uri(`${DEVGRAPH}Class`)).length;
            contractCount += quads.filter(q => q.object === uri(`${DEVGRAPH}Contract`)).length;
          } catch (err) {
            process.stderr.write(`Warning [${extractor.id}]: could not index ${relative(repoRoot, file)}: ${err}\n`);
          }
        }
      }
    }
  }

  if (includeContent) {
    for await (const file of walkFiles(repoRoot, CONTENT_EXTRACTOR.extensions)) {
      try {
        const quads = await CONTENT_EXTRACTOR.indexFile(repoRoot, file, 'repo');
        allQuads.push(...quads);
        moduleCount++;
      } catch (err) {
        process.stderr.write(`Warning [content]: could not index ${relative(repoRoot, file)}: ${err}\n`);
      }
    }
  }

  return {
    quads: allQuads,
    packageCount: packages.length,
    moduleCount,
    functionCount,
    classCount,
    contractCount,
  };
}
