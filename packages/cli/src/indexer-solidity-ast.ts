/**
 * Solidity AST indexer — consumes Hardhat build-info JSON to produce a
 * richer devgraph: representation than the regex-based pass in indexer.ts.
 *
 * Input:  `<pkgDir>/artifacts/build-info/*.json` (Hardhat combined solc input/output).
 * Output: `Quad[]` extending the existing Contract/Function/Event vocabulary with:
 *   - StateVariable / Event / Error / Modifier as first-class classes
 *   - visibility, stateMutability, functionKind, isAbstract, isConstant,
 *     isImmutable, isVirtual, contractKind, license, solidityVersion, docstring
 *   - usesModifier (Function → Modifier), emitsEvent legacy string kept for
 *     back-compat, plus emits (Function → Event) when the body emits a known
 *     event definition
 *   - calls (Function → Function) within the same build-info via AST node id
 *     resolution — covers internal calls; cross-contract calls resolve when
 *     the callee is in the same build-info
 *
 * URI scheme (stable across regex and AST passes for Contract / Function):
 *   - Contract:      symbol:<repo-rel-path>/contract/<name>
 *   - Function:      symbol:<repo-rel-path>/fn/<name>#<astId>
 *   - Event:         symbol:<repo-rel-path>/event/<name>#<astId>
 *   - Error:         symbol:<repo-rel-path>/error/<name>#<astId>
 *   - Modifier:      symbol:<repo-rel-path>/modifier/<name>#<astId>
 *   - StateVariable: symbol:<repo-rel-path>/var/<name>#<astId>
 *
 * The AST id suffix on functions disambiguates overloads and anonymous kinds
 * (constructor/receive/fallback) while leaving a stable, reproducible URI.
 */

import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  Quad,
  DEVGRAPH_NS, RDF_TYPE_IRI, DEFAULT_GRAPH,
  uri, literal, intLiteral, boolLiteral,
  moduleUri, packageUri,
} from './indexer.js';

// ---------------------------------------------------------------------------
// solc AST shapes (loose — we only read the subset we need)
// ---------------------------------------------------------------------------

interface AstNode {
  id: number;
  nodeType: string;
  src?: string;
  [key: string]: unknown;
}

interface SourceUnit extends AstNode {
  nodeType: 'SourceUnit';
  absolutePath: string;
  license?: string;
  nodes: AstNode[];
}

interface BuildInfo {
  solcVersion: string;
  output: { sources: Record<string, { ast: SourceUnit; id?: number }> };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function astSymbolUri(repoRelPath: string, kind: string, name: string, astId: number): string {
  return `symbol:${repoRelPath}/${kind}/${encodeURIComponent(name || '_')}#${astId}`;
}

function contractUri(repoRelPath: string, name: string): string {
  return `symbol:${repoRelPath}/contract/${encodeURIComponent(name)}`;
}

function natSpec(node: AstNode): string | null {
  const doc = node.documentation;
  if (!doc) return null;
  if (typeof doc === 'string') return doc;
  if (typeof doc === 'object' && doc !== null && 'text' in doc) {
    const text = (doc as { text?: unknown }).text;
    return typeof text === 'string' ? text.trim() : null;
  }
  return null;
}

function paramListToString(parameters: AstNode | undefined): string {
  if (!parameters) return '';
  const maybe = (parameters as unknown as { parameters?: AstNode[] }).parameters;
  if (!Array.isArray(maybe)) return '';
  return maybe.map(p => {
    const td = (p as { typeDescriptions?: { typeString?: string } }).typeDescriptions;
    const t = td?.typeString ?? (p as { typeName?: { name?: string } }).typeName?.name ?? '<?>';
    const n = (p as { name?: string }).name ?? '';
    return n ? `${t} ${n}` : t;
  }).join(', ');
}

function typeString(node: AstNode): string | null {
  const td = (node as { typeDescriptions?: { typeString?: string } }).typeDescriptions;
  return td?.typeString ?? null;
}

// Walk an AST subtree and invoke `visitor` on each descendant. Safe against
// the handful of non-node shapes that show up (arrays, primitives, nulls).
function walk(node: unknown, visitor: (n: AstNode) => void): void {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visitor);
    return;
  }
  if (typeof node !== 'object') return;
  const asNode = node as AstNode;
  if (typeof asNode.nodeType === 'string') visitor(asNode);
  for (const key of Object.keys(node as Record<string, unknown>)) {
    if (key === 'typeDescriptions' || key === 'src' || key === 'nodeType' || key === 'nameLocation') continue;
    walk((node as Record<string, unknown>)[key], visitor);
  }
}

function extractPragmaVersion(sourceUnit: SourceUnit): string | null {
  for (const n of sourceUnit.nodes) {
    if (n.nodeType === 'PragmaDirective') {
      const literals = (n as { literals?: string[] }).literals;
      if (Array.isArray(literals) && literals[0] === 'solidity') {
        return literals.slice(1).join(' ').replace(/\s+/g, ' ').trim();
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main pass — per build-info file
// ---------------------------------------------------------------------------

interface IndexContext {
  repoRoot: string;
  pkgDir: string;       // e.g. /abs/packages/evm-module
  pkgName: string;
  quads: Quad[];
  /** Map AST node id → canonical symbol URI, built in pass 1 for call-graph. */
  idToUri: Map<number, string>;
  /** Map AST node id → canonical symbol kind ('fn' | 'event' | …), for quick lookup. */
  idToKind: Map<number, string>;
}

function emit(ctx: IndexContext, q: Quad): void {
  ctx.quads.push(q);
}

function t(ctx: IndexContext, subject: string, predicate: string, object: string): Quad {
  return { subject, predicate, object, graph: DEFAULT_GRAPH };
}

function typeUri(cls: string): string { return `${DEVGRAPH_NS}${cls}`; }
function predUri(p: string): string { return `${DEVGRAPH_NS}${p}`; }

function filePathFromAbsolute(ctx: IndexContext, absolutePath: string): string | null {
  // Hardhat's `absolutePath` is relative to the Hardhat root (= pkgDir).
  // Skip anything outside `contracts/` — that's dependency code (OZ, solady…).
  if (!absolutePath.startsWith('contracts/')) return null;
  const full = join(ctx.pkgDir, absolutePath);
  return relative(ctx.repoRoot, full).replace(/\\/g, '/');
}

// ---- Pass 1: register every top-level symbol's astId → URI ----

function registerSymbols(ctx: IndexContext, src: SourceUnit, repoRelPath: string): void {
  for (const node of src.nodes) {
    if (node.nodeType !== 'ContractDefinition') continue;
    const contract = node as AstNode & { name: string; nodes: AstNode[] };
    const cUri = contractUri(repoRelPath, contract.name);
    ctx.idToUri.set(contract.id, cUri);
    ctx.idToKind.set(contract.id, 'contract');

    for (const member of contract.nodes) {
      const m = member as AstNode & { name?: string };
      switch (m.nodeType) {
        case 'FunctionDefinition': {
          const kind = (m as { kind?: string }).kind ?? 'function';
          const name = m.name || kind; // constructor / receive / fallback carry empty names
          const u = astSymbolUri(repoRelPath, 'fn', name, m.id);
          ctx.idToUri.set(m.id, u);
          ctx.idToKind.set(m.id, 'fn');
          break;
        }
        case 'EventDefinition': {
          const u = astSymbolUri(repoRelPath, 'event', m.name ?? '_', m.id);
          ctx.idToUri.set(m.id, u);
          ctx.idToKind.set(m.id, 'event');
          break;
        }
        case 'ErrorDefinition': {
          const u = astSymbolUri(repoRelPath, 'error', m.name ?? '_', m.id);
          ctx.idToUri.set(m.id, u);
          ctx.idToKind.set(m.id, 'error');
          break;
        }
        case 'ModifierDefinition': {
          const u = astSymbolUri(repoRelPath, 'modifier', m.name ?? '_', m.id);
          ctx.idToUri.set(m.id, u);
          ctx.idToKind.set(m.id, 'modifier');
          break;
        }
        case 'VariableDeclaration': {
          const u = astSymbolUri(repoRelPath, 'var', m.name ?? '_', m.id);
          ctx.idToUri.set(m.id, u);
          ctx.idToKind.set(m.id, 'var');
          break;
        }
      }
    }
  }
}

// ---- Pass 2: emit quads (uses idToUri for cross-references) ----

function emitSourceQuads(ctx: IndexContext, src: SourceUnit, repoRelPath: string): void {
  const modUri = uri(moduleUri(ctx.repoRoot, join(ctx.pkgDir, src.absolutePath)));
  const solcVersion = extractPragmaVersion(src);

  emit(ctx, t(ctx, modUri, RDF_TYPE_IRI, typeUri('CodeModule')));
  emit(ctx, t(ctx, modUri, predUri('path'), literal(repoRelPath)));
  emit(ctx, t(ctx, modUri, predUri('containedIn'), uri(packageUri(ctx.pkgName))));
  if (src.license) emit(ctx, t(ctx, modUri, predUri('license'), literal(src.license)));
  if (solcVersion) emit(ctx, t(ctx, modUri, predUri('solidityVersion'), literal(solcVersion)));

  for (const node of src.nodes) {
    if (node.nodeType !== 'ContractDefinition') continue;
    emitContractQuads(ctx, node as AstNode & {
      name: string; nodes: AstNode[];
      baseContracts?: Array<{ baseName?: { name?: string; referencedDeclaration?: number } }>;
      contractKind?: string; abstract?: boolean;
      linearizedBaseContracts?: number[];
    }, modUri, repoRelPath, solcVersion);
  }
}

function emitContractQuads(
  ctx: IndexContext,
  contract: AstNode & {
    name: string; nodes: AstNode[];
    baseContracts?: Array<{ baseName?: { name?: string; referencedDeclaration?: number } }>;
    contractKind?: string; abstract?: boolean;
  },
  modUri: string,
  repoRelPath: string,
  solcVersion: string | null,
): void {
  const cUri = contractUri(repoRelPath, contract.name);

  emit(ctx, t(ctx, cUri, RDF_TYPE_IRI, typeUri('Contract')));
  emit(ctx, t(ctx, cUri, predUri('name'), literal(contract.name)));
  emit(ctx, t(ctx, cUri, predUri('definedIn'), modUri));
  if (contract.contractKind) emit(ctx, t(ctx, cUri, predUri('contractKind'), literal(contract.contractKind)));
  if (typeof contract.abstract === 'boolean') emit(ctx, t(ctx, cUri, predUri('isAbstract'), boolLiteral(contract.abstract)));
  if (solcVersion) emit(ctx, t(ctx, cUri, predUri('solidityVersion'), literal(solcVersion)));
  const doc = natSpec(contract);
  if (doc) emit(ctx, t(ctx, cUri, predUri('docstring'), literal(doc)));

  // Inheritance — resolve to Contract URIs via idToUri when possible; fall
  // back to string literal (matches the existing regex indexer's behaviour).
  for (const base of contract.baseContracts ?? []) {
    const refId = base.baseName?.referencedDeclaration;
    const target = refId != null ? ctx.idToUri.get(refId) : undefined;
    if (target) {
      emit(ctx, t(ctx, cUri, predUri('inherits'), target));
    } else if (base.baseName?.name) {
      emit(ctx, t(ctx, cUri, predUri('inherits'), literal(base.baseName.name)));
    }
  }

  for (const member of contract.nodes) {
    switch (member.nodeType) {
      case 'VariableDeclaration':
        emitStateVariableQuads(ctx, member, cUri, modUri, repoRelPath);
        break;
      case 'EventDefinition':
        emitEventQuads(ctx, member, cUri, modUri, repoRelPath);
        break;
      case 'ErrorDefinition':
        emitErrorQuads(ctx, member, cUri, modUri, repoRelPath);
        break;
      case 'ModifierDefinition':
        emitModifierQuads(ctx, member, cUri, modUri, repoRelPath);
        break;
      case 'FunctionDefinition':
        emitFunctionQuads(ctx, member, cUri, modUri, repoRelPath);
        break;
    }
  }
}

function emitStateVariableQuads(ctx: IndexContext, node: AstNode, cUri: string, modUri: string, repoRelPath: string): void {
  const v = node as AstNode & {
    name?: string; constant?: boolean; mutability?: string; visibility?: string;
  };
  const u = astSymbolUri(repoRelPath, 'var', v.name ?? '_', v.id);
  emit(ctx, t(ctx, u, RDF_TYPE_IRI, typeUri('StateVariable')));
  if (v.name) emit(ctx, t(ctx, u, predUri('name'), literal(v.name)));
  emit(ctx, t(ctx, u, predUri('definedIn'), modUri));
  emit(ctx, t(ctx, cUri, predUri('hasMethod'), u)); // not literally a method — reuse the 'member of class' slot
  const type = typeString(node);
  if (type) emit(ctx, t(ctx, u, predUri('variableType'), literal(type)));
  if (v.visibility) emit(ctx, t(ctx, u, predUri('visibility'), literal(v.visibility)));
  emit(ctx, t(ctx, u, predUri('isConstant'), boolLiteral(v.constant === true)));
  emit(ctx, t(ctx, u, predUri('isImmutable'), boolLiteral(v.mutability === 'immutable')));
  const doc = natSpec(node);
  if (doc) emit(ctx, t(ctx, u, predUri('docstring'), literal(doc)));
}

function emitEventQuads(ctx: IndexContext, node: AstNode, cUri: string, modUri: string, repoRelPath: string): void {
  const e = node as AstNode & { name?: string; parameters?: AstNode };
  const u = astSymbolUri(repoRelPath, 'event', e.name ?? '_', e.id);
  emit(ctx, t(ctx, u, RDF_TYPE_IRI, typeUri('Event')));
  if (e.name) emit(ctx, t(ctx, u, predUri('name'), literal(e.name)));
  emit(ctx, t(ctx, u, predUri('definedIn'), modUri));
  emit(ctx, t(ctx, cUri, predUri('hasMethod'), u));
  // Retain the legacy string form on the Contract for back-compat with existing queries.
  if (e.name) emit(ctx, t(ctx, cUri, predUri('emitsEvent'), literal(e.name)));
  const params = paramListToString(e.parameters);
  if (params) emit(ctx, t(ctx, u, predUri('parameter'), literal(params)));
  const doc = natSpec(node);
  if (doc) emit(ctx, t(ctx, u, predUri('docstring'), literal(doc)));
}

function emitErrorQuads(ctx: IndexContext, node: AstNode, cUri: string, modUri: string, repoRelPath: string): void {
  const e = node as AstNode & { name?: string; parameters?: AstNode };
  const u = astSymbolUri(repoRelPath, 'error', e.name ?? '_', e.id);
  emit(ctx, t(ctx, u, RDF_TYPE_IRI, typeUri('Error')));
  if (e.name) emit(ctx, t(ctx, u, predUri('name'), literal(e.name)));
  emit(ctx, t(ctx, u, predUri('definedIn'), modUri));
  emit(ctx, t(ctx, cUri, predUri('hasMethod'), u));
  const params = paramListToString(e.parameters);
  if (params) emit(ctx, t(ctx, u, predUri('parameter'), literal(params)));
  const doc = natSpec(node);
  if (doc) emit(ctx, t(ctx, u, predUri('docstring'), literal(doc)));
}

function emitModifierQuads(ctx: IndexContext, node: AstNode, cUri: string, modUri: string, repoRelPath: string): void {
  const m = node as AstNode & { name?: string; parameters?: AstNode; virtual?: boolean };
  const u = astSymbolUri(repoRelPath, 'modifier', m.name ?? '_', m.id);
  emit(ctx, t(ctx, u, RDF_TYPE_IRI, typeUri('Modifier')));
  if (m.name) emit(ctx, t(ctx, u, predUri('name'), literal(m.name)));
  emit(ctx, t(ctx, u, predUri('definedIn'), modUri));
  emit(ctx, t(ctx, cUri, predUri('hasMethod'), u));
  const params = paramListToString(m.parameters);
  if (params) emit(ctx, t(ctx, u, predUri('parameter'), literal(params)));
  if (typeof m.virtual === 'boolean') emit(ctx, t(ctx, u, predUri('isVirtual'), boolLiteral(m.virtual)));
  const doc = natSpec(node);
  if (doc) emit(ctx, t(ctx, u, predUri('docstring'), literal(doc)));
}

function emitFunctionQuads(ctx: IndexContext, node: AstNode, cUri: string, modUri: string, repoRelPath: string): void {
  const f = node as AstNode & {
    name?: string; visibility?: string; stateMutability?: string;
    kind?: string; virtual?: boolean;
    parameters?: AstNode; returnParameters?: AstNode;
    modifiers?: Array<{ modifierName?: { referencedDeclaration?: number; name?: string } }>;
    body?: unknown;
  };
  const kind = f.kind ?? 'function';
  const name = f.name || kind;
  const u = astSymbolUri(repoRelPath, 'fn', name, f.id);

  emit(ctx, t(ctx, u, RDF_TYPE_IRI, typeUri('Function')));
  emit(ctx, t(ctx, u, predUri('name'), literal(name)));
  emit(ctx, t(ctx, u, predUri('definedIn'), modUri));
  emit(ctx, t(ctx, cUri, predUri('hasMethod'), u));
  if (f.visibility) emit(ctx, t(ctx, u, predUri('visibility'), literal(f.visibility)));
  if (f.stateMutability) emit(ctx, t(ctx, u, predUri('stateMutability'), literal(f.stateMutability)));
  emit(ctx, t(ctx, u, predUri('functionKind'), literal(kind)));
  if (typeof f.virtual === 'boolean') emit(ctx, t(ctx, u, predUri('isVirtual'), boolLiteral(f.virtual)));

  const params = paramListToString(f.parameters);
  if (params) emit(ctx, t(ctx, u, predUri('parameter'), literal(params)));
  const returns = paramListToString(f.returnParameters);
  if (returns) emit(ctx, t(ctx, u, predUri('returnType'), literal(returns)));
  const doc = natSpec(node);
  if (doc) emit(ctx, t(ctx, u, predUri('docstring'), literal(doc)));

  // Modifiers applied to this function (resolve to Modifier nodes when possible).
  for (const mod of f.modifiers ?? []) {
    const refId = mod.modifierName?.referencedDeclaration;
    const target = refId != null ? ctx.idToUri.get(refId) : undefined;
    if (target) {
      emit(ctx, t(ctx, u, predUri('usesModifier'), target));
    } else if (mod.modifierName?.name) {
      emit(ctx, t(ctx, u, predUri('usesModifier'), literal(mod.modifierName.name)));
    }
  }

  // Call graph: walk body looking for FunctionCall / EmitStatement with
  // resolved referencedDeclarations; emit `calls` / `emits` edges.
  if (f.body) {
    const seen = new Set<number>();
    walk(f.body, (n) => {
      if (n.nodeType === 'FunctionCall') {
        const expr = (n as { expression?: AstNode }).expression;
        const ref = resolveFunctionCallTarget(expr);
        if (ref != null && !seen.has(ref)) {
          seen.add(ref);
          const target = ctx.idToUri.get(ref);
          const targetKind = ctx.idToKind.get(ref);
          if (target && targetKind === 'fn') {
            emit(ctx, t(ctx, u, predUri('calls'), target));
          }
        }
      }
      if (n.nodeType === 'EmitStatement') {
        const call = (n as { eventCall?: { expression?: AstNode } }).eventCall;
        const ref = resolveFunctionCallTarget(call?.expression);
        if (ref != null) {
          const target = ctx.idToUri.get(ref);
          const targetKind = ctx.idToKind.get(ref);
          if (target && targetKind === 'event') {
            emit(ctx, t(ctx, u, predUri('emits'), target));
          }
        }
      }
    });
  }
}

function resolveFunctionCallTarget(expr: AstNode | undefined): number | null {
  if (!expr) return null;
  const e = expr as { referencedDeclaration?: number };
  if (typeof e.referencedDeclaration === 'number') return e.referencedDeclaration;
  // MemberAccess (e.g. `foo.bar()`) carries referencedDeclaration on the MemberAccess itself.
  if (expr.nodeType === 'MemberAccess') {
    const ma = expr as { referencedDeclaration?: number };
    if (typeof ma.referencedDeclaration === 'number') return ma.referencedDeclaration;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

export interface SolidityAstIndexResult {
  quads: Quad[];
  contractCount: number;
  functionCount: number;
  eventCount: number;
  errorCount: number;
  modifierCount: number;
  stateVariableCount: number;
  sourceCount: number;
  skippedDependencyCount: number;
}

export async function indexSolidityBuildInfo(
  repoRoot: string, pkgDir: string, pkgName: string,
): Promise<SolidityAstIndexResult> {
  const ctx: IndexContext = {
    repoRoot, pkgDir, pkgName,
    quads: [],
    idToUri: new Map(), idToKind: new Map(),
  };
  const result: SolidityAstIndexResult = {
    quads: ctx.quads,
    contractCount: 0, functionCount: 0, eventCount: 0,
    errorCount: 0, modifierCount: 0, stateVariableCount: 0,
    sourceCount: 0, skippedDependencyCount: 0,
  };

  const buildInfoDir = join(pkgDir, 'artifacts', 'build-info');
  if (!existsSync(buildInfoDir)) return result;

  const entries = await readdir(buildInfoDir);
  const files = entries.filter(f => f.endsWith('.json'));

  // Pass 1: register all symbol ids from all build-infos so call-graph can
  // resolve targets even if the caller and callee were compiled in different
  // build-info files.
  const processed: Array<{ src: SourceUnit; repoRel: string }> = [];
  for (const file of files) {
    const raw = await readFile(join(buildInfoDir, file), 'utf-8');
    let info: BuildInfo;
    try { info = JSON.parse(raw) as BuildInfo; }
    catch (err) {
      process.stderr.write(`Warning [solidity-ast]: could not parse ${file}: ${err}\n`);
      continue;
    }
    for (const sourcePath of Object.keys(info.output?.sources ?? {})) {
      const entry = info.output.sources[sourcePath];
      const ast = entry?.ast;
      if (!ast || ast.nodeType !== 'SourceUnit') continue;
      const repoRel = filePathFromAbsolute(ctx, ast.absolutePath);
      if (!repoRel) { result.skippedDependencyCount++; continue; }
      registerSymbols(ctx, ast, repoRel);
      processed.push({ src: ast, repoRel });
    }
  }

  // Pass 2: emit quads, using the id map built in pass 1.
  const seenSources = new Set<string>();
  for (const { src, repoRel } of processed) {
    if (seenSources.has(repoRel)) continue; // a source may appear in multiple build-infos
    seenSources.add(repoRel);
    emitSourceQuads(ctx, src, repoRel);
    result.sourceCount++;
  }

  result.contractCount  = ctx.quads.filter(q => q.object === typeUri('Contract')).length;
  result.functionCount  = ctx.quads.filter(q => q.object === typeUri('Function')).length;
  result.eventCount     = ctx.quads.filter(q => q.object === typeUri('Event')).length;
  result.errorCount     = ctx.quads.filter(q => q.object === typeUri('Error')).length;
  result.modifierCount  = ctx.quads.filter(q => q.object === typeUri('Modifier')).length;
  result.stateVariableCount = ctx.quads.filter(q => q.object === typeUri('StateVariable')).length;

  return result;
}
