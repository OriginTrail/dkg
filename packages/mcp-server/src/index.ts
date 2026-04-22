#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { DkgClient } from './connection.js';
import { escapeSparqlLiteral } from '@origintrail-official/dkg-core';

const CONTEXT_GRAPH = 'dev-coordination';
const DG = 'https://ontology.dkg.io/devgraph#';

let _client: DkgClient | null = null;

async function getClient(): Promise<DkgClient> {
  if (!_client) {
    _client = await DkgClient.connect();
  }
  return _client;
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// Result formatting — strip verbose URIs, return compact markdown
// ---------------------------------------------------------------------------

type Bindings = Array<Record<string, string>>;

function parseBindings(raw: unknown): Bindings {
  const obj = raw as { bindings?: Bindings };
  return obj?.bindings ?? [];
}

/** Strip datatype suffixes and URI prefixes from SPARQL result values */
function cleanValue(v: string): string {
  // Typed literals: "42"^^<http://...#integer> → 42
  const typedMatch = v.match(/^"(.+?)"\^\^<.+>$/);
  if (typedMatch) return typedMatch[1];
  // Plain literals: "foo" → foo
  if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
  // URIs: strip known prefixes
  return v
    .replace(DG, '')
    .replace('file:', '')
    .replace('symbol:', '')
    .replace('pkg:', '');
}

/** Format SPARQL bindings as a compact markdown table */
function toTable(bindings: Bindings, columns?: string[]): string {
  if (bindings.length === 0) return '(no results)';
  const cols = columns ?? Object.keys(bindings[0]);
  const rows = bindings.map(row =>
    '| ' + cols.map(c => cleanValue(row[c] ?? '')).join(' | ') + ' |'
  );
  const header = '| ' + cols.join(' | ') + ' |';
  const sep = '| ' + cols.map(() => '---').join(' | ') + ' |';
  return [header, sep, ...rows].join('\n');
}

async function sparql(query: string): Promise<Bindings> {
  const client = await getClient();
  const result = await client.query(query, CONTEXT_GRAPH);
  return parseBindings(result.result);
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const };
}

const SPARQL_ONLY = process.env.DKG_SPARQL_ONLY === '1';

const server = new McpServer({
  name: 'dkg',
  version: '9.2.0',
});

// ---------------------------------------------------------------------------
// dkg_find_modules — Find code modules by keyword in path
// ---------------------------------------------------------------------------

if (!SPARQL_ONLY) server.registerTool(
  'dkg_find_modules',
  {
    title: 'Find Code Modules',
    description:
      'Search the code graph for source files matching a keyword in their path. ' +
      'Returns file paths, line counts, and containing package.',
    inputSchema: {
      keyword: z.string().describe('Substring to match in file paths (case-insensitive)'),
      limit: z.number().optional().default(30).describe('Max results (default 30)'),
    },
  },
  async ({ keyword, limit }) => {
    try {
      const q = `SELECT ?path ?lines ?pkg WHERE {
        ?m a <${DG}CodeModule> ; <${DG}path> ?path ; <${DG}lineCount> ?lines ; <${DG}containedIn> ?p .
        ?p <${DG}name> ?pkg .
        FILTER(CONTAINS(LCASE(?path), LCASE("${esc(keyword)}")))
      } ORDER BY ?path LIMIT ${limit ?? 30}`;
      const rows = await sparql(q);
      return ok(`Found ${rows.length} modules matching "${keyword}":\n\n${toTable(rows, ['path', 'lines', 'pkg'])}`);
    } catch (e) { return err(`Error: ${formatError(e)}`); }
  },
);

// ---------------------------------------------------------------------------
// dkg_find_functions — Find functions/methods by name
// ---------------------------------------------------------------------------

if (!SPARQL_ONLY) server.registerTool(
  'dkg_find_functions',
  {
    title: 'Find Functions',
    description:
      'Search the code graph for functions or methods matching a name keyword. ' +
      'Returns function name, signature, file path, and optional return type.',
    inputSchema: {
      keyword: z.string().describe('Substring to match in function names'),
      module: z.string().optional().describe('Optional path substring to narrow to specific files'),
      limit: z.number().optional().default(20).describe('Max results (default 20)'),
    },
  },
  async ({ keyword, module, limit }) => {
    try {
      const moduleFilter = module
        ? `FILTER(CONTAINS(LCASE(?path), LCASE("${esc(module)}")))`
        : '';
      const q = `SELECT ?name ?sig ?path ?ret WHERE {
        ?f a <${DG}Function> ; <${DG}name> ?name ; <${DG}definedIn> ?mod .
        ?mod <${DG}path> ?path .
        OPTIONAL { ?f <${DG}signature> ?sig }
        OPTIONAL { ?f <${DG}returnType> ?ret }
        FILTER(CONTAINS(LCASE(?name), LCASE("${esc(keyword)}")))
        ${moduleFilter}
      } ORDER BY ?path ?name LIMIT ${limit ?? 20}`;
      const rows = await sparql(q);
      return ok(`Found ${rows.length} functions matching "${keyword}":\n\n${toTable(rows, ['name', 'sig', 'path'])}`);
    } catch (e) { return err(`Error: ${formatError(e)}`); }
  },
);

// ---------------------------------------------------------------------------
// dkg_find_classes — Find classes by name
// ---------------------------------------------------------------------------

if (!SPARQL_ONLY) server.registerTool(
  'dkg_find_classes',
  {
    title: 'Find Classes',
    description:
      'Search the code graph for classes matching a name keyword. ' +
      'Returns class name, file path, parent class (extends), and interfaces (implements).',
    inputSchema: {
      keyword: z.string().optional().default('').describe('Substring to match in class names (empty = all classes)'),
      module: z.string().optional().describe('Optional path substring to narrow to specific files'),
      limit: z.number().optional().default(30).describe('Max results (default 30)'),
    },
  },
  async ({ keyword, module, limit }) => {
    try {
      const nameFilter = keyword
        ? `FILTER(CONTAINS(LCASE(?name), LCASE("${esc(keyword)}")))`
        : '';
      const moduleFilter = module
        ? `FILTER(CONTAINS(LCASE(?path), LCASE("${esc(module)}")))`
        : '';
      const q = `SELECT ?name ?path ?extends ?implements WHERE {
        ?c a <${DG}Class> ; <${DG}name> ?name ; <${DG}definedIn> ?mod .
        ?mod <${DG}path> ?path .
        OPTIONAL { ?c <${DG}extends> ?extends }
        OPTIONAL { ?c <${DG}implements> ?implements }
        ${nameFilter}
        ${moduleFilter}
      } ORDER BY ?name LIMIT ${limit ?? 30}`;
      const rows = await sparql(q);
      return ok(`Found ${rows.length} classes:\n\n${toTable(rows, ['name', 'path', 'extends', 'implements'])}`);
    } catch (e) { return err(`Error: ${formatError(e)}`); }
  },
);

// ---------------------------------------------------------------------------
// dkg_find_packages — List packages and their dependencies
// ---------------------------------------------------------------------------

if (!SPARQL_ONLY) server.registerTool(
  'dkg_find_packages',
  {
    title: 'Find Packages',
    description:
      'Search the code graph for workspace packages. ' +
      'Returns package names, paths, and their workspace dependencies.',
    inputSchema: {
      keyword: z.string().optional().default('').describe('Substring to match in package names (empty = all packages)'),
    },
  },
  async ({ keyword }) => {
    try {
      const nameFilter = keyword
        ? `FILTER(CONTAINS(LCASE(?name), LCASE("${esc(keyword)}")))`
        : '';
      const q = `SELECT ?name ?pkgPath ?dep WHERE {
        ?p a <${DG}Package> ; <${DG}name> ?name ; <${DG}path> ?pkgPath .
        OPTIONAL { ?p <${DG}dependsOn> ?d . ?d <${DG}name> ?dep }
        ${nameFilter}
      } ORDER BY ?name`;
      const rows = await sparql(q);

      // Group deps by package for compact output
      const byPkg = new Map<string, { path: string; deps: string[] }>();
      for (const row of rows) {
        const name = cleanValue(row.name ?? '');
        const existing = byPkg.get(name);
        if (!existing) {
          byPkg.set(name, { path: cleanValue(row.pkgPath ?? ''), deps: [] });
        }
        const dep = row.dep ? cleanValue(row.dep) : '';
        if (dep && !byPkg.get(name)!.deps.includes(dep)) {
          byPkg.get(name)!.deps.push(dep);
        }
      }

      const lines = [...byPkg.entries()].map(([name, info]) =>
        `- **${name}** (${info.path})${info.deps.length ? `\n  deps: ${info.deps.join(', ')}` : ''}`
      );
      return ok(`Found ${byPkg.size} packages:\n\n${lines.join('\n')}`);
    } catch (e) { return err(`Error: ${formatError(e)}`); }
  },
);

// ---------------------------------------------------------------------------
// dkg_file_summary — Get a compact summary of a file without reading it
// ---------------------------------------------------------------------------

if (!SPARQL_ONLY) server.registerTool(
  'dkg_file_summary',
  {
    title: 'File Summary',
    description:
      'Get a compact summary of a source file from the code graph: its functions, ' +
      'classes, imports, line count, and containing package — without reading the full file.',
    inputSchema: {
      path: z.string().describe('Exact or partial file path (e.g. "extensions/discord/src/plugin.ts")'),
    },
  },
  async ({ path: filePath }) => {
    try {
      const escaped = esc(filePath);

      // Module metadata
      const modQ = `SELECT ?path ?lines ?pkg WHERE {
        ?m a <${DG}CodeModule> ; <${DG}path> ?path ; <${DG}lineCount> ?lines ; <${DG}containedIn> ?p .
        ?p <${DG}name> ?pkg .
        FILTER(CONTAINS(?path, "${escaped}"))
      } LIMIT 1`;
      const mods = await sparql(modQ);
      if (mods.length === 0) return ok(`No module found matching "${filePath}".`);

      const exactPath = cleanValue(mods[0].path);

      // Functions in this module
      const fnQ = `SELECT ?name ?sig ?ret WHERE {
        ?f a <${DG}Function> ; <${DG}name> ?name ; <${DG}definedIn> ?mod .
        ?mod <${DG}path> "${exactPath}" .
        OPTIONAL { ?f <${DG}signature> ?sig }
        OPTIONAL { ?f <${DG}returnType> ?ret }
      } ORDER BY ?name`;
      const fns = await sparql(fnQ);

      // Classes in this module
      const clsQ = `SELECT ?name ?extends ?implements WHERE {
        ?c a <${DG}Class> ; <${DG}name> ?name ; <${DG}definedIn> ?mod .
        ?mod <${DG}path> "${exactPath}" .
        OPTIONAL { ?c <${DG}extends> ?extends }
        OPTIONAL { ?c <${DG}implements> ?implements }
      }`;
      const classes = await sparql(clsQ);

      // Imports
      const impQ = `SELECT ?imp WHERE {
        ?mod a <${DG}CodeModule> ; <${DG}path> "${exactPath}" ; <${DG}imports> ?i .
        ?i <${DG}path> ?imp .
      }`;
      const imports = await sparql(impQ);

      const parts: string[] = [];
      parts.push(`**${exactPath}** (${cleanValue(mods[0].lines)} lines, package: ${cleanValue(mods[0].pkg)})`);

      if (fns.length > 0) {
        parts.push(`\n**Functions (${fns.length}):**`);
        for (const fn of fns) {
          const sig = fn.sig ? cleanValue(fn.sig) : cleanValue(fn.name);
          parts.push(`- ${sig}`);
        }
      }

      if (classes.length > 0) {
        parts.push(`\n**Classes (${classes.length}):**`);
        for (const cls of classes) {
          let line = `- ${cleanValue(cls.name)}`;
          if (cls.extends) line += ` extends ${cleanValue(cls.extends)}`;
          if (cls.implements) line += ` implements ${cleanValue(cls.implements)}`;
          parts.push(line);
        }
      }

      if (imports.length > 0) {
        parts.push(`\n**Imports (${imports.length}):** ${imports.map(i => cleanValue(i.imp)).join(', ')}`);
      }

      return ok(parts.join('\n'));
    } catch (e) { return err(`Error: ${formatError(e)}`); }
  },
);

// ---------------------------------------------------------------------------
// dkg_query — Advanced SPARQL fallback
// ---------------------------------------------------------------------------

server.registerTool(
  'dkg_query',
  {
    title: SPARQL_ONLY ? 'DKG Code Graph Query' : 'SPARQL Query (advanced)',
    description: SPARQL_ONLY
      ? 'Execute a SPARQL query against the indexed code graph. ' +
        'The graph contains the full codebase structure. ' +
        'Prefix: devgraph = <https://ontology.dkg.io/devgraph#>. ' +
        'Types: CodeModule, Function, Class, Package, Contract. ' +
        'Properties: path, name, lineCount, signature, definedIn, containedIn, ' +
        'imports, dependsOn, extends, implements, hasMethod, parameter, returnType. ' +
        'Results are returned as compact markdown tables.'
      : 'Execute a raw SPARQL query against the code graph. Use this only when the ' +
        'other tools (dkg_find_modules, dkg_find_functions, dkg_find_classes, ' +
        'dkg_find_packages, dkg_file_summary) cannot express your query. ' +
        'Common prefixes: devgraph = <https://ontology.dkg.io/devgraph#>, ' +
        'types: CodeModule, Function, Class, Package, Contract. ' +
        'Properties: path, name, lineCount, signature, definedIn, containedIn, ' +
        'imports, dependsOn, extends, implements, hasMethod, parameter, returnType.',
    inputSchema: {
      sparql: z.string().describe('The SPARQL SELECT query to execute'),
    },
  },
  async ({ sparql: query }) => {
    try {
      const rows = await sparql(query);
      return ok(toTable(rows));
    } catch (e) { return err(`Query error: ${formatError(e)}`); }
  },
);

// ---------------------------------------------------------------------------
// dkg_publish — Publish knowledge to the graph
// ---------------------------------------------------------------------------

server.registerTool(
  'dkg_publish',
  {
    title: 'Publish to DKG',
    description:
      'Publish RDF quads (knowledge) to the dev-coordination context graph. ' +
      'Use this to record architectural decisions, session summaries, or other knowledge.',
    inputSchema: {
      quads: z.array(z.object({
        subject: z.string().describe('Subject URI'),
        predicate: z.string().describe('Predicate URI'),
        object: z.string().describe('Object URI or literal value'),
        graph: z.string().describe('Named graph URI'),
      })).describe('Array of RDF quads to publish'),
    },
  },
  async ({ quads }) => {
    try {
      const client = await getClient();
      const result = await client.publish(CONTEXT_GRAPH, quads);
      return ok(`Published ${quads.length} quads. KC: ${result.kcId}, status: ${result.status}`);
    } catch (e) { return err(`Publish error: ${formatError(e)}`); }
  },
);

// ---------------------------------------------------------------------------
// mcp_auth — credentialing & connection state (BUGS_FOUND.md K-2)
// ---------------------------------------------------------------------------
//
// Spec requirement: every MCP server that talks to a remote DKG node MUST
// expose an `mcp_auth` tool so the host (Claude / Cursor / openclaw) can
// programmatically inspect the active credential, swap/rotate it, and
// confirm the daemon is reachable with that credential — without forcing
// the user to read DKG_NODE_TOKEN environment variables out-of-band.
//
// Operations:
//
//   - status   → current node URL, sanitized credential fingerprint,
//                /api/status liveness probe, server version
//   - set      → install a new bearer token in-process (overrides
//                DKG_NODE_TOKEN for the lifetime of the server)
//   - whoami   → minimal identity echo derived from the credential —
//                ALWAYS returns a fingerprint (sha256[:8]) of the token,
//                never the raw token, so transcripts can't leak it.
//
// The whole flow is read-only with respect to the underlying DKG node;
// rotation against the daemon's on-disk auth.token is handled by the CLI
// `dkg auth rotate` subcommand (CLI-11) — exposing rotation here would
// mean leaking the token surface area into the MCP transcript.

server.registerTool(
  'mcp_auth',
  {
    title: 'MCP DKG Authentication',
    description:
      'Inspect or update the bearer credential the MCP server uses to reach the DKG node. ' +
      'Use op="status" for a liveness probe + sanitized credential fingerprint; ' +
      'op="set" to install a new bearer token in-process; ' +
      'op="whoami" to echo the active credential fingerprint without the raw value.',
    inputSchema: {
      op: z
        .enum(['status', 'set', 'whoami'])
        .describe('Operation to perform: status | set | whoami'),
      token: z
        .string()
        .optional()
        .describe('Bearer token to install (required when op="set")'),
    },
  },
  async ({ op, token }) => {
    try {
      if (op === 'set') {
        if (!token || token.trim().length < 8) {
          return err(
            'mcp_auth: op="set" requires a non-empty `token` argument (>= 8 chars).',
          );
        }
        process.env.DKG_NODE_TOKEN = token;
        _client = null;
        return ok(
          `Bearer credential rotated in-process. Fingerprint: ${fingerprintCredential(token)}.\n` +
            'The next DKG tool invocation will reconnect with the new token.',
        );
      }

      const url = process.env.DKG_NODE_URL ?? 'http://127.0.0.1:7777';
      const cred = process.env.DKG_NODE_TOKEN ?? '';
      const fingerprint = cred ? fingerprintCredential(cred) : '∅ (no credential configured)';

      if (op === 'whoami') {
        return ok(
          `node = ${url}\n` +
            `credential fingerprint = ${fingerprint}\n` +
            `(raw token deliberately not returned — use op="status" for the liveness probe)`,
        );
      }

      const status = await probeStatus(url, cred);
      return ok(
        `node = ${url}\n` +
          `credential fingerprint = ${fingerprint}\n` +
          `status probe = ${status.ok ? 'OK' : 'FAILED'} ${status.code ? `(${status.code})` : ''}\n` +
          (status.body ? `body = ${status.body}\n` : ''),
      );
    } catch (e) {
      return err(`mcp_auth error: ${formatError(e)}`);
    }
  },
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const esc = escapeSparqlLiteral;

function fingerprintCredential(token: string): string {
  const hash = createHash('sha256').update(token, 'utf8').digest('hex');
  return `sha256:${hash.slice(0, 12)}…`;
}

async function probeStatus(
  url: string,
  token: string,
): Promise<{ ok: boolean; code?: number; body?: string }> {
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`${url.replace(/\/$/, '')}/api/status`, { headers });
    const text = await res.text().catch(() => '');
    return { ok: res.ok, code: res.status, body: text.slice(0, 240) };
  } catch (e) {
    return { ok: false, body: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Adapter loading — DKG_ADAPTERS=autoresearch,other,...
// ---------------------------------------------------------------------------

type AdapterRegisterFn = (
  server: McpServer,
  getClient: () => Promise<DkgClient>,
  contextGraphId?: string,
) => void;

const ADAPTER_MAP: Record<string, string> = {
  autoresearch: '@origintrail-official/dkg-adapter-autoresearch',
};

async function loadAdapters() {
  const raw = process.env.DKG_ADAPTERS ?? '';
  const names = raw.split(',').map(s => s.trim()).filter(Boolean);
  for (const name of names) {
    const pkg = ADAPTER_MAP[name] ?? name;
    try {
      const mod = await import(pkg) as { registerTools?: AdapterRegisterFn };
      if (typeof mod.registerTools === 'function') {
        mod.registerTools(server, getClient);
        process.stderr.write(`[dkg-mcp] adapter loaded: ${name}\n`);
      } else {
        process.stderr.write(`[dkg-mcp] adapter ${name}: no registerTools export, skipped\n`);
      }
    } catch (e) {
      process.stderr.write(`[dkg-mcp] adapter ${name} failed to load: ${formatError(e)}\n`);
    }
  }
}

// ---------------------------------------------------------------------------
// Start the server
// ---------------------------------------------------------------------------

async function main() {
  await loadAdapters();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`DKG MCP server fatal error: ${formatError(err)}\n`);
  process.exit(1);
});
