# Code Parsing Pipeline — Architecture Plan

## Overview

The GitHub Collaboration app currently syncs metadata (PRs, issues, commits, reviews, branches) but has no knowledge of actual source code. This plan adds a three-phase pipeline that indexes repository file trees, parses source code into AST-derived entities, and extracts cross-file relationships — all stored as RDF using the existing `ghcode:` ontology.

### Constraints

- **Self-contained:** The entire pipeline lives within `packages/github-collab`. No imports from `packages/mcp-server` or any MCP SDK dependency.
- **No MCP protocol:** No MCP tools, no MCP transport, no MCP server registration. Code parsing is triggered via the existing SyncEngine and HTTP API handler.
- **Inspiration only:** The MCP server's approach to mapping code entities to RDF (`devgraph:` vocabulary) was studied for patterns. The implementation here is independent, using the `ghcode:` vocabulary and the GitHub REST API as its data source instead of local disk reads.

---

## Architecture Diagram

```
                         GitHub REST API
                              |
             +----------------+----------------+
             |                |                |
      Phase A: Trees    Phase B: Blobs    Phase C: Diffs
     GET /git/trees     GET /git/blobs    (derived from B)
     ~1 API call        batched by need
             |                |                |
             v                v                v
      +-------------+  +-------------+  +-----------------+
      | Tree        |  | Code        |  | Relationship    |
      | Transformer |  | Parser      |  | Extractor       |
      | (file/dir   |  | (TS API +   |  | (imports->files |
      |  metadata)  |  |  regex for  |  |  inheritance,   |
      |             |  |  other lang) |  |  call edges)    |
      +------+------+  +------+------+  +--------+--------+
             |                |                   |
             v                v                   v
      +---------------------------------------------------+
      |              RDF Quad Generation                   |
      |   ghcode:File, ghcode:Directory, ghcode:Class,     |
      |   ghcode:Function, ghcode:Import, ghcode:Export,   |
      |   ghcode:inherits, ghcode:calls, etc.              |
      +---------------------------------------------------+
                              |
                              v
      +---------------------------------------------------+
      |           SyncEngine.writeQuads()                  |
      |     (existing path -> coordinator -> workspace)    |
      +---------------------------------------------------+
```

---

## Phase A: File Tree Indexing

### What
Index the entire repository file tree in a single API call, producing `ghcode:File` and `ghcode:Directory` entities with metadata (path, size, language). This gives agents immediate structural awareness.

### API Choice
**`GET /repos/{owner}/{repo}/git/trees/{tree_sha}?recursive=1`**

Rationale:
- Returns every path in the repo in a single request (one API call)
- Includes `path`, `type` (blob/tree), `size`, `sha` for each entry
- The `tree_sha` comes from the branch's HEAD commit (already synced)
- Handles repos with thousands of files without pagination
- Size is only available for blobs (files), not trees (directories)

Alternative considered: `/repos/{owner}/{repo}/contents/{path}` — requires one call per directory, so ~100+ calls for dkg-v9. Rejected.

### Implementation

**New file: `src/github/code-sync.ts`**

```typescript
export interface CodeSyncOptions {
  owner: string;
  repo: string;
  ref?: string;              // branch/tag/sha, defaults to default branch
  includePatterns?: string[]; // glob patterns to include (default: common source extensions)
  excludePatterns?: string[]; // glob patterns to exclude (default: node_modules, dist, etc.)
  maxFileSize?: number;       // bytes, default 100KB
  parseCode?: boolean;        // Phase B: parse file contents
  extractRelationships?: boolean; // Phase C: cross-file relationships
}
```

**New GitHub client methods:**

```typescript
// In client.ts
async getTree(owner: string, repo: string, treeSha: string, recursive = true): Promise<GitTree>
async getBlob(owner: string, repo: string, sha: string): Promise<GitBlob>
async getRef(owner: string, repo: string, ref: string): Promise<GitRef>
```

**New RDF transformer: `src/rdf/code-transformer.ts`**

```typescript
export function transformFileTree(tree: GitTreeEntry[], owner: string, repo: string, ref: string, graph: string): Quad[]
export function transformCodeEntities(entities: CodeEntity[], owner: string, repo: string, filePath: string, graph: string): Quad[]
export function transformRelationships(relationships: CodeRelationship[], owner: string, repo: string, graph: string): Quad[]
```

**New URI minters (in `uri.ts`):**

```typescript
export function fileUri(owner: string, repo: string, path: string, ref?: string): string {
  // urn:github:owner/repo/file/path/to/file.ts
  return `urn:github:${owner}/${repo}/file/${encodeURIComponent(path)}`;
}

export function dirUri(owner: string, repo: string, path: string): string {
  return `urn:github:${owner}/${repo}/dir/${encodeURIComponent(path)}`;
}

export function symbolUri(owner: string, repo: string, filePath: string, symbolName: string): string {
  return `urn:github:${owner}/${repo}/symbol/${encodeURIComponent(filePath)}#${encodeURIComponent(symbolName)}`;
}
```

### File Filtering Strategy

**Default include patterns** (by extension):
```
.ts, .tsx, .js, .jsx, .mjs, .cjs     — TypeScript/JavaScript
.sol                                   — Solidity
.py                                    — Python
.go                                    — Go
.rs                                    — Rust
.java                                  — Java
.json (package.json, tsconfig.json)    — Config (selective)
.toml (Cargo.toml)                     — Config (selective)
.yaml, .yml                            — CI/CD configs
```

**Default exclude patterns:**
```
node_modules/**, dist/**, build/**, .git/**
coverage/**, __pycache__/**, target/**
*.min.js, *.min.css, *.map
*.lock, package-lock.json, pnpm-lock.yaml
vendor/**, third_party/**
```

**Max file size:** 100KB default (filters out generated files, large data files). Configurable per-repo.

### Language Detection

Map file extension to language string for `ghcode:language`:

```typescript
const EXTENSION_LANGUAGE: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript',
  '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.sol': 'Solidity',
  '.py': 'Python',
  '.go': 'Go',
  '.rs': 'Rust',
  '.java': 'Java',
  '.json': 'JSON',
  '.yaml': 'YAML', '.yml': 'YAML',
  '.md': 'Markdown',
  '.css': 'CSS', '.scss': 'SCSS',
  '.html': 'HTML',
};
```

### RDF Output (per file)

```turtle
<urn:github:owner/repo/file/src%2Findex.ts> a ghcode:File ;
  ghcode:filePath "src/index.ts" ;
  ghcode:fileSize 2048 ;
  ghcode:language "TypeScript" ;
  ghcode:inDirectory <urn:github:owner/repo/dir/src> ;
  ghcode:inRepo <urn:github:owner/repo> ;
  ghcode:snapshotAt "2026-03-25T..." .
```

```turtle
<urn:github:owner/repo/dir/src> a ghcode:Directory ;
  ghcode:dirPath "src" ;
  ghcode:parentDir <urn:github:owner/repo/dir/> ;
  ghcode:inRepo <urn:github:owner/repo> .
```

### Quad Estimate

For dkg-v9 (~1000 source files, ~200 directories):
- Files: 1000 x 6 quads = ~6,000 quads
- Directories: 200 x 4 quads = ~800 quads
- **Total Phase A: ~7,000 quads, 1-2 API calls**

### Effort Estimate
- New client methods: small (3 methods)
- Tree transformer: small (~80 lines)
- URI minters: trivial (3 functions)
- Integration into SyncEngine: small (new `code_structure` scope)
- Tests: medium (transformer unit tests, integration test)
- **Total: ~1 day**

---

## Phase B: Source Code Parsing

### What
Fetch file contents and parse them into code entities (classes, functions, interfaces, imports, exports). This is the core feature that makes the code graph queryable.

### Parser Recommendation: Hybrid Approach

**Primary: TypeScript Compiler API (`ts.createSourceFile`) for TS/JS**

Rationale:
- TypeScript is already a devDependency — zero new dependencies
- `ts.createSourceFile` produces a full AST without a `tsconfig.json` or type-checking phase
- Handles both TypeScript and JavaScript (including JSX/TSX)
- Extracts classes, interfaces, functions, methods, imports, exports, type aliases, enums with full type information
- Line/column positions are exact
- ~200-300 lines of visitor code

```typescript
import ts from 'typescript';

function parseTypeScript(source: string, fileName: string): CodeEntity[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const entities: CodeEntity[] = [];

  function visit(node: ts.Node) {
    if (ts.isClassDeclaration(node)) { /* extract class */ }
    if (ts.isFunctionDeclaration(node)) { /* extract function */ }
    if (ts.isInterfaceDeclaration(node)) { /* extract interface */ }
    if (ts.isImportDeclaration(node)) { /* extract import */ }
    if (ts.isExportDeclaration(node)) { /* extract export */ }
    // ... etc
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return entities;
}
```

**Secondary: Regex-based extraction for Solidity, Python, Go, Rust, Java**

Rationale:
- tree-sitter WASM adds ~5MB of dependencies and build complexity
- For the "code graph" use case, we need symbol-level info (name, kind, location), not full ASTs
- Regex patterns are sufficient for top-level declarations in these languages
- Each language needs ~20-40 lines of regex patterns
- Can be upgraded to tree-sitter later if precision becomes critical

```typescript
// Example: Solidity regex patterns
const SOL_PATTERNS = {
  contract: /^\s*(?:abstract\s+)?contract\s+(\w+)(?:\s+is\s+([^{]+))?\s*\{/gm,
  function: /^\s*function\s+(\w+)\s*\(([^)]*)\)(?:\s+(?:public|external|internal|private|pure|view|payable|virtual|override|returns\s*\([^)]*\)))*\s*[{;]/gm,
  event: /^\s*event\s+(\w+)\s*\(/gm,
  modifier: /^\s*modifier\s+(\w+)/gm,
  import: /^\s*import\s+(?:{[^}]+}\s+from\s+)?["']([^"']+)["']/gm,
};
```

**Why not tree-sitter?**

- Adds significant dependency weight (WASM binaries per language: ~1-3MB each)
- Build complexity: WASM loading, async initialization, platform-specific issues
- The regex approach covers 80-90% of use cases for structural indexing
- Upgrade path: the `CodeParser` interface allows swapping regex for tree-sitter per-language later

### API Choice for File Contents

**`GET /repos/{owner}/{repo}/git/blobs/{sha}` — for individual files**

Rationale:
- The git tree from Phase A already provides the `sha` for every blob
- Supports files up to 100MB (vs 1MB limit on contents API)
- Returns base64-encoded content
- We only need to fetch files that pass the filter (extension + size)
- ETag support for conditional requests on re-sync

**Not tarball:** Downloading the entire repo as a tarball (~50MB for dkg-v9) wastes bandwidth when we only need ~200 parseable source files. The blob-by-blob approach fetches only what's needed and supports incremental updates.

### Rate Limiting Strategy

For dkg-v9 (~500 parseable source files after filtering):
- Phase A: 1-2 API calls (tree)
- Phase B: ~500 API calls (one per file)
- Total: ~502 calls << 5,000/hr rate limit

**Batching strategy:**
1. Fetch tree first (Phase A) — get all file SHAs
2. Filter to parseable files (extension + size check)
3. Fetch blobs in batches of 20, with 50ms delay between batches
4. Parse each file as it arrives (no need to wait for all)
5. Write quads in batches of 100 files

**Rate limit safety:**
- The existing `GitHubClient.checkRateLimit()` already pauses when remaining < 10
- Add a configurable concurrency limit (default: 5 parallel fetches)
- Progress reporting via `SyncJob.progress.codeFiles`

### Code Entity Model

```typescript
interface CodeEntity {
  kind: 'class' | 'interface' | 'function' | 'method' | 'constructor' |
        'enum' | 'type_alias' | 'struct' | 'trait' | 'variable' | 'constant';
  name: string;
  filePath: string;
  startLine: number;
  endLine?: number;
  language: string;

  // Type-specific
  signature?: string;         // full signature text
  parameters?: Parameter[];
  returnType?: string;
  isAsync?: boolean;
  isStatic?: boolean;
  isAbstract?: boolean;
  isExported?: boolean;
  visibility?: 'public' | 'private' | 'protected' | 'internal' | 'external';
  decorators?: string[];
  docComment?: string;

  // Relationships (populated in Phase C)
  extends?: string;
  implements?: string[];
  parentClass?: string;       // for methods: which class they belong to
}

interface ImportEntity {
  filePath: string;
  source: string;             // import specifier
  importedNames: string[];    // named imports
  isTypeOnly?: boolean;
  isDefault?: boolean;
  isNamespace?: boolean;
  startLine: number;
}

interface ExportEntity {
  filePath: string;
  exportedName: string;
  localName?: string;
  reExportSource?: string;
  isDefault?: boolean;
  isTypeOnly?: boolean;
  startLine: number;
}
```

### Parser Architecture

```typescript
// src/code/parser.ts — Parser interface and registry

interface LanguageParser {
  language: string;
  extensions: string[];
  parse(source: string, filePath: string): ParseResult;
}

interface ParseResult {
  entities: CodeEntity[];
  imports: ImportEntity[];
  exports: ExportEntity[];
}

// Registry
const parsers = new Map<string, LanguageParser>();
parsers.set('TypeScript', new TypeScriptParser());   // ts.createSourceFile
parsers.set('JavaScript', new TypeScriptParser());   // same parser, different target
parsers.set('Solidity', new RegexParser(SOL_PATTERNS));
parsers.set('Python', new RegexParser(PY_PATTERNS));
parsers.set('Go', new RegexParser(GO_PATTERNS));
parsers.set('Rust', new RegexParser(RS_PATTERNS));
parsers.set('Java', new RegexParser(JAVA_PATTERNS));

function getParser(filePath: string): LanguageParser | undefined {
  const ext = path.extname(filePath);
  const lang = EXTENSION_LANGUAGE[ext];
  return lang ? parsers.get(lang) : undefined;
}
```

### RDF Output (per entity)

```turtle
# Class
<urn:github:o/r/symbol/src%2Fgithub%2Fclient.ts#GitHubClient> a ghcode:Class ;
  ghcode:typeName "GitHubClient" ;
  ghcode:definedInFile <urn:github:o/r/file/src%2Fgithub%2Fclient.ts> ;
  ghcode:startLine 62 ;
  ghcode:endLine 334 ;
  ghcode:language "TypeScript" ;
  ghcode:visibility "public" .

# Method
<urn:github:o/r/symbol/src%2Fgithub%2Fclient.ts#GitHubClient.getRepository> a ghcode:Method ;
  ghcode:functionName "getRepository" ;
  ghcode:async true ;
  ghcode:definedInFile <urn:github:o/r/file/src%2Fgithub%2Fclient.ts> ;
  ghcode:startLine 79 ;
  ghcode:language "TypeScript" .

# Import
<urn:github:o/r/file/src%2Frdf%2Ftransformer.ts#import-0> a ghcode:Import ;
  ghcode:importSource "./uri.js" ;
  ghcode:importedName "GH" ;
  ghcode:importedName "RDF" ;
  ghcode:importType "named" ;
  ghcode:startLine 10 .
```

### Quad Estimate

For a typical TS file with 5 functions, 1 class, 3 imports, 2 exports:
- File entity: 6 quads (from Phase A)
- Class: ~8 quads (type, name, file, lines, language, visibility, exported)
- 5 functions: 5 x 6 = 30 quads
- 3 imports: 3 x 4 = 12 quads
- 2 exports: 2 x 3 = 6 quads
- **Per file: ~50-60 quads**

For 500 parseable files: **~25,000-30,000 quads**

Combined with Phase A: **~37,000 total quads** — well within workspace capacity.

### Effort Estimate
- TypeScript parser (ts.createSourceFile visitor): ~1 day
- Regex parser framework + Solidity patterns: ~0.5 days
- Python/Go/Rust/Java regex patterns: ~1 day
- Code transformer (entities -> quads): ~0.5 days
- Blob fetching + batching logic: ~0.5 days
- Integration into SyncEngine (new `code` scope): ~0.5 days
- Tests: ~1 day
- **Total: ~5 days**

---

## Phase C: Relationship Extraction

### What
Extract cross-file relationships: resolve import paths to target files, map class inheritance/implementation chains, and (best-effort) track intra-file function calls.

### Import Resolution

The most valuable relationship: mapping `import { Foo } from './bar.js'` to the actual target file.

```typescript
function resolveImport(
  importSource: string,
  importingFilePath: string,
  fileIndex: Map<string, string>, // normalized path -> file URI
): string | null {
  // 1. Relative imports: resolve against importing file's directory
  // 2. Strip .js/.ts extensions, try with .ts/.tsx/.js/.jsx
  // 3. Try /index.ts, /index.js for directory imports
  // 4. Package imports: match against package.json name fields
  // 5. Return null for external packages (npm, etc.)
}
```

**RDF output:**
```turtle
<urn:github:o/r/file/src%2Frdf%2Ftransformer.ts> ghcode:imports <urn:github:o/r/file/src%2Frdf%2Furi.ts> .
```

### Inheritance/Implementation

Already extracted by the parser in Phase B (the `extends`/`implements` fields). Phase C resolves these to symbol URIs:

```turtle
<urn:github:o/r/symbol/src%2Fgithub%2Fclient.ts#GitHubApiError> ghcode:inherits <urn:github:o/r/symbol/src%2Fgithub%2Fclient.ts#Error> .
```

For cross-file inheritance, use the import graph + export map to resolve the target:
1. Find the `extends` name in the current file's imports
2. Follow the import to the source file
3. Find the matching export → symbol URI

### Function Calls (Best-Effort)

Intra-file only for the initial implementation. Cross-file call resolution requires full type information which is infeasible without a type checker.

Strategy: Within a class, identify method calls to other methods of the same class. Within a module, identify calls to top-level functions defined in the same file.

```turtle
<urn:github:o/r/symbol/src%2Fgithub%2Fclient.ts#GitHubClient.get> ghcode:calls <urn:github:o/r/symbol/src%2Fgithub%2Fclient.ts#GitHubClient.request> .
```

### Bridging to devgraph: Ontology

The existing MCP server indexes the local codebase into `devgraph:CodeModule`, `devgraph:Function`, `devgraph:Class`. The ghcode: ontology already defines bridge properties:

- `ghcode:linksToModule` — `ghcode:File` -> `devgraph:CodeModule`
- `ghcode:linksToPackage` — `ghcode:Package` -> `devgraph:Package`

Phase C can emit these links when the paths match, allowing SPARQL queries to traverse both graphs.

### Effort Estimate
- Import resolution: ~1 day
- Inheritance resolution: ~0.5 days
- Intra-file call tracking: ~0.5 days
- devgraph: bridge linking: ~0.5 days
- Tests: ~0.5 days
- **Total: ~3 days**

---

## Incremental Sync Strategy

### Initial Sync
1. Fetch full tree (Phase A) — store tree SHA
2. Parse all matching files (Phase B)
3. Extract relationships (Phase C)
4. Store the commit SHA as `highWaterMark` for code sync

### Subsequent Syncs

**Option 1: Tree Diff (recommended)**
1. Fetch new tree for current HEAD
2. Compare with stored tree: new/modified/deleted entries by SHA
3. Only fetch blobs for changed files
4. Re-run Phase C relationship extraction for affected files

```typescript
function diffTrees(oldTree: GitTreeEntry[], newTree: GitTreeEntry[]): TreeDiff {
  const oldMap = new Map(oldTree.map(e => [e.path, e.sha]));
  const newMap = new Map(newTree.map(e => [e.path, e.sha]));

  return {
    added: newTree.filter(e => !oldMap.has(e.path)),
    modified: newTree.filter(e => oldMap.has(e.path) && oldMap.get(e.path) !== e.sha),
    deleted: [...oldMap.keys()].filter(p => !newMap.has(p)),
  };
}
```

**Cost:** 1 API call for tree + N calls for changed blobs. Typical PR changes 5-20 files = 6-21 API calls.

**Option 2: Commit Diff (for webhook/poll-driven updates)**
Use `GET /repos/{owner}/{repo}/commits/{sha}` which includes `files[]` with status and sha. Already called by the existing commit sync flow.

### Storage of Sync State

Add to `RepoSyncConfig`:
```typescript
interface CodeSyncState {
  lastTreeSha?: string;
  lastCommitSha?: string;
  fileIndex?: Map<string, string>; // path -> blob SHA
  syncedAt?: string;
}
```

Persist alongside existing config in `~/.dkg/apps/github-collab/config.json`.

---

## Integration Points

### SyncEngine Changes

Add `'code_structure'` to `SyncScope`:

```typescript
export type SyncScope = 'pull_requests' | 'issues' | 'reviews' | 'commits' | 'comments' | 'code_structure';
```

In `runFullSync()`, add a code sync phase after branches:

```typescript
if (scopes.includes('code_structure')) {
  job.progress.codeFiles = { total: 0, synced: 0 };
  await this.syncCodeStructure(job, config, client, graph);
}
```

### API Handler Changes

Add endpoint for triggering code sync specifically:

```
POST /api/apps/github-collab/sync/code
  body: { owner, repo, ref?, parseCode?: boolean }
  response: { ok, jobId, status }

GET /api/apps/github-collab/code/stats
  query: repo=owner/repo
  response: { files, directories, classes, functions, imports, totalQuads }
```

### Webhook Integration

On `push` events (already handled), trigger incremental code sync for changed files.

### UI Integration

The existing sync UI already shows progress per scope. Adding `code_structure` to the scope selector allows users to enable/disable code indexing.

---

## New Files Summary

```
src/
  code/
    parser.ts           — LanguageParser interface, registry, getParser()
    typescript-parser.ts — TypeScript/JavaScript parser using ts.createSourceFile
    regex-parser.ts     — Generic regex-based parser for Solidity/Python/Go/Rust/Java
    patterns/
      solidity.ts       — Solidity regex patterns
      python.ts         — Python regex patterns
      go.ts             — Go regex patterns
      rust.ts           — Rust regex patterns
      java.ts           — Java regex patterns
  github/
    code-sync.ts        — CodeSyncEngine: tree fetching, blob batching, incremental diff
  rdf/
    code-transformer.ts — transformFileTree(), transformCodeEntities(), transformRelationships()
```

Modifications to existing files:
- `src/github/client.ts` — add `getTree()`, `getBlob()`, `getRef()` methods
- `src/rdf/uri.ts` — add `fileUri()`, `dirUri()`, `symbolUri()` minters
- `src/dkg/sync-engine.ts` — add `code_structure` scope, wire up CodeSyncEngine
- `src/api/handler.ts` — add `/sync/code` and `/code/stats` endpoints
- `src/index.ts` — export new types

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Rate limit exhaustion on large repos | Low | Medium | Batch with delays; check remaining before batch; tree diff for incremental |
| Regex parser misses edge cases | Medium | Low | Start with common patterns; add patterns as issues arise; upgrade path to tree-sitter |
| Large files cause memory pressure | Low | Medium | 100KB default limit; stream blob content; parse-and-discard (don't hold source in memory) |
| Generated/vendored code inflates graph | Medium | Low | Exclude patterns filter most; size limit catches generated bundles |
| TypeScript parser fails on non-standard syntax | Low | Low | `ts.createSourceFile` with `Latest` target handles all current TS/JS; decorators, JSX work out of the box |
| Blob SHA changes on rebase causing full re-parse | Medium | Low | Only re-parse changed files; per-file SHA tracking makes this efficient |
| Quad count grows large for monorepos | Low | Medium | Configurable include/exclude; parse-on-demand (only parse files matching a pattern) |

---

## Implementation Order

### Sprint 1: Phase A — File Tree (1 day)
1. Add `getTree()`, `getBlob()`, `getRef()` to GitHubClient
2. Add `fileUri()`, `dirUri()`, `symbolUri()` to uri.ts
3. Implement `transformFileTree()` in code-transformer.ts
4. Implement `CodeSyncEngine.syncTree()` in code-sync.ts
5. Wire into SyncEngine with `code_structure` scope
6. Unit tests for transformer and filtering logic

### Sprint 2: Phase B — TS/JS Parser (2 days)
1. Implement `TypeScriptParser` using `ts.createSourceFile`
2. Implement `transformCodeEntities()` in code-transformer.ts
3. Implement blob fetching with batching in CodeSyncEngine
4. Wire parsing into the sync flow
5. Unit tests for parser output

### Sprint 3: Phase B — Other Languages (1.5 days)
1. Implement `RegexParser` framework
2. Add Solidity patterns (highest priority after TS)
3. Add Python, Go patterns
4. Add Rust, Java patterns
5. Tests per language

### Sprint 4: Phase C — Relationships (2 days)
1. Import resolution (relative paths, index files)
2. Inheritance/implementation resolution
3. Intra-file call tracking
4. devgraph: bridge links
5. Integration tests

### Sprint 5: Polish & Integration (1.5 days)
1. Incremental sync (tree diff)
2. API endpoints (`/sync/code`, `/code/stats`)
3. Webhook-triggered incremental updates
4. E2E test against a real (public) GitHub repo
5. Documentation

**Total estimated effort: ~8 days**

---

## Relationship to MCP Server Code Graph (Reference Only)

The MCP server (`packages/mcp-server/`) indexes the **local** codebase into `devgraph:` entities by reading files directly from disk. This pipeline is completely independent — it indexes **remote** repos from the GitHub API into `ghcode:` entities.

**There is no code dependency between the two.** No imports, no shared modules, no MCP SDK usage. The MCP server was studied only for design inspiration:
- How code entities map to RDF classes (the pattern of `CodeModule` -> quads with `path`, `lineCount`, `definedIn`)
- How SPARQL query shapes look for code navigation (find-by-name, file-summary)
- These patterns informed the `ghcode:` transformer design but share zero code

Key architectural differences:
| | MCP Server | GitHub Collab Code Pipeline |
|---|---|---|
| Data source | Local filesystem | GitHub REST API |
| Vocabulary | `devgraph:` | `ghcode:` |
| Scope | Current working directory | Any GitHub repository |
| Trigger | On-demand via MCP tools | SyncEngine / webhooks / HTTP API |
| Dependencies | `@modelcontextprotocol/sdk` | None beyond existing github-collab deps |

The `ghcode:linksToModule` and `ghcode:linksToPackage` bridge properties in the ontology allow cross-referencing when the same repo is indexed by both systems, but this is a data-level link, not a code-level dependency.
