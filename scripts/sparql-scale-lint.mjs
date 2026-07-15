#!/usr/bin/env node
/**
 * SPARQL scalability lint — blocks PRs that ADD store-melting query shapes.
 *
 * Why this exists: several production incidents traced back to SPARQL that is
 * O(store) instead of O(result) — the legacy `SELECT DISTINCT ?g WHERE
 * { GRAPH ?g { ?s ?p ?o } }` listGraphs scan (#1597 sync storm), the unbounded
 * SWM-slice CONSTRUCT over a bucket graph (#1609), and OFFSET-paged iteration
 * that re-scans O(offset) rows per page (sync responder). Each looked fine in
 * review and only failed at fleet scale. This lint encodes those shapes.
 *
 * Rules (each finding names its rule):
 *   R1 unscoped-all-var-scan   ?s ?p ?o with no bound term, outside any
 *                              GRAPH <iri> scope → scans the whole store.
 *   R2 graph-var-scan          an all-variable triple inside GRAPH ?g → scans
 *                              every graph × every triple (the #1597 shape).
 *   R3 offset-pagination       OFFSET n (n>0 or interpolated) → O(offset) per
 *                              page, O(n²) for a full walk, and torn reads on
 *                              mutable data. Use a keyset/seek cursor instead.
 *   R4 bucket-graph-scan       an all-variable triple over a KNOWN-UNBOUNDED
 *                              graph family (bucket `_shared_memory`, `_meta`,
 *                              data graph, catalog…) with no LIMIT → O(graph)
 *                              where the graph grows with fleet usage (#1609).
 *
 * What does NOT trigger:
 *   - plain ASK { ?s ?p ?o } with no FILTER (first-match short-circuit);
 *   - all-var triples inside FILTER [NOT] EXISTS / MINUS (per-binding
 *     existence probes — the FIXED #1597 listGraphs form lives here);
 *   - queries with LIMIT and no ORDER BY (bounded materialization) for R1/R2;
 *   - GRAPH ?g bound by VALUES ?g { … };
 *   - whole-graph reads of exact per-KA graphs (bounded by one assertion).
 *
 * Escape hatch: a query that is legitimately safe (small bounded graph,
 * startup-only migration, etc.) can be acknowledged with a justification —
 * either a SPARQL comment inside the query:
 *       # sparql-scan-allow: R4 -- catalog floor is capped at 64 triples
 * or a JS comment within 3 lines above the template literal:
 *       // sparql-scan-allow: R3 -- startup-only migration, store is idle
 * The rule id must match and the justification must be non-empty. The pragma
 * is diffable review surface: allowing a scan is a decision, not a default.
 *
 * Ratchet: in --diff mode only NEW findings fail the run. A finding's
 * fingerprint is (rule, normalized query text) — whitespace/interpolation
 * insensitive, so moving a pre-existing query or reindenting it does not
 * re-flag it, while editing the query re-evaluates it.
 *
 * Modes:
 *   node scripts/sparql-scale-lint.mjs --diff <baseSha> <headSha>   (CI)
 *   node scripts/sparql-scale-lint.mjs --all                        (audit)
 *   node scripts/sparql-scale-lint.mjs --files a.ts b.ts            (spot)
 *   node scripts/sparql-scale-lint.mjs --self-test                  (fixtures)
 *
 * Zero dependencies; plain string analysis (queries here are TS template
 * literals full of ${…}, so a real SPARQL parser cannot see them anyway).
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import process from 'node:process';

const SCANNED_EXTENSIONS = /\.(ts|mts|cts|js|mjs|cjs)$/;
const EXCLUDED_PATH = /(^|\/)(node_modules|dist|coverage|bench|e2e)\/|(^|\/)test(s)?\/|\.(test|spec|bench)\.[a-z]+$|^docs\/|^scripts\/sparql-scale-lint\.mjs$/;

const RULES = {
  R1: {
    id: 'R1',
    name: 'unscoped-all-var-scan',
    message:
      'All-variable triple pattern with no graph scope scans the ENTIRE store. ' +
      'Scope it to an exact named graph, bind at least one term, or add LIMIT (without ORDER BY).',
  },
  R2: {
    id: 'R2',
    name: 'graph-var-scan',
    message:
      'All-variable triple inside GRAPH ?var enumerates every graph × every triple ' +
      '(the #1597 listGraphs-storm shape). Bind the graph (VALUES/exact IRI), bind a term, ' +
      'or use a FILTER EXISTS existence probe.',
  },
  R3: {
    id: 'R3',
    name: 'offset-pagination',
    message:
      'OFFSET pagination re-scans O(offset) rows per page (O(n²) for a full walk) and tears ' +
      'on mutable data. Use a keyset/seek cursor, a retained snapshot, or acknowledge with a pragma.',
  },
  R4: {
    id: 'R4',
    name: 'bucket-graph-scan',
    message:
      'Unbounded scan over a graph family that grows with fleet usage (SWM bucket / _meta / ' +
      'data graph / catalog — the #1609 shape). Read the exact per-KA graph, add LIMIT/paging ' +
      'by key, or acknowledge with a pragma.',
  },
};

const UNBOUNDED_GRAPH_EXPR = /bucket|sharedMemoryUri|sharedMemoryMetaUri|dataGraphUri|contextGraphDataUri|metaGraphUri|contextGraphMetaUri|metaGraph|workspaceMetaGraph|wsMetaGraph|catalogGraph|ontologyGraph/i;
const UNBOUNDED_GRAPH_LITERAL = /(\/_shared_memory|\/_shared_memory_meta|\/_meta|\/_catalog)\s*$|^did:dkg:context-graph:[^/]+$/;

// ---------------------------------------------------------------------------
// Template-literal extraction (handles nesting, escapes, ${ … } expressions)
// ---------------------------------------------------------------------------

/**
 * Extract every template literal from JS/TS source.
 * Returns { raw, parts, exprs, startLine } where `parts` is the literal text
 * with each interpolation replaced by `⟪i⟫` (index into exprs).
 */
const REGEX_PRECEDING_KEYWORD = /(^|[^\w$])(return|typeof|instanceof|in|of|new|delete|void|do|else|case|yield|await)\s*$/;

export function extractTemplateLiterals(source) {
  const literals = [];
  let i = 0;
  let line = 1;
  let lastSignificant = ''; // trailing window of code, for regex-vs-division
  const n = source.length;
  const note = (ch) => {
    if (!/\s/.test(ch)) lastSignificant = (lastSignificant + ch).slice(-24);
  };
  while (i < n) {
    const ch = source[i];
    if (ch === '\n') { line++; i++; continue; }
    // Skip line comments, block comments, normal string literals, and REGEX
    // literals so quotes/backticks inside them cannot open phantom strings
    // (an IRI-safety regex like /[<>"{}|^`\\]/ otherwise poisons the walk).
    if (ch === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') line++;
        i++;
      }
      i += 2;
      continue;
    }
    if (ch === '/') {
      // Regex when the previous significant token cannot end an expression;
      // otherwise it is division. Operators/keywords start expression position.
      const prev = lastSignificant.slice(-1);
      const regexPosition = prev === '' ||
        '(,=:[!&|?{};+-*%<>~^'.includes(prev) ||
        REGEX_PRECEDING_KEYWORD.test(lastSignificant);
      if (regexPosition) {
        i++;
        let inClass = false;
        while (i < n) {
          const r = source[i];
          if (r === '\\') { i += 2; continue; }
          if (r === '\n') { line++; break; } // not a regex after all — bail
          if (r === '[') inClass = true;
          else if (r === ']') inClass = false;
          else if (r === '/' && !inClass) { i++; break; }
          i++;
        }
        while (i < n && /[a-z]/i.test(source[i])) i++; // flags
        lastSignificant = (lastSignificant + '/').slice(-24);
        continue;
      }
      note(ch);
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\') i++;
        else if (source[i] === '\n') line++; // unterminated/JSX edge — bail per line
        i++;
      }
      i++;
      note(quote);
      continue;
    }
    if (ch === '`') {
      const startLine = line;
      i++;
      let text = '';
      const exprs = [];
      let closed = false;
      while (i < n) {
        const c = source[i];
        if (c === '\\') {
          text += source.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (c === '`') { i++; closed = true; break; }
        if (c === '$' && source[i + 1] === '{') {
          // capture the expression with brace/backtick awareness
          let depth = 1;
          let j = i + 2;
          let expr = '';
          while (j < n && depth > 0) {
            const e = source[j];
            if (e === '{') depth++;
            else if (e === '}') { depth--; if (depth === 0) break; }
            else if (e === '`') {
              // nested template: skip it wholesale (rare in this codebase)
              j++;
              while (j < n && source[j] !== '`') {
                if (source[j] === '\\') j++;
                if (source[j] === '\n') line++;
                j++;
              }
            } else if (e === '\n') line++;
            expr += e;
            j++;
          }
          text += `⟪${exprs.length}⟫`;
          exprs.push(expr.trim());
          i = j + 1;
          continue;
        }
        if (c === '\n') line++;
        text += c;
        i++;
      }
      if (closed) literals.push({ text, exprs, startLine });
      note('`');
      continue;
    }
    note(ch);
    i++;
  }
  return literals;
}

// ---------------------------------------------------------------------------
// SPARQL-shape analysis on the extracted literal text
// ---------------------------------------------------------------------------

const SPARQL_HINT = /\b(SELECT|CONSTRUCT|DESCRIBE|ASK|INSERT|DELETE)\b[\s\S]*\{|\b(DROP|CLEAR|MOVE|COPY)\s+(SILENT\s+)?GRAPH\b/i;

function looksLikeSparql(text) {
  return SPARQL_HINT.test(text);
}

/** Strip SPARQL string literals + comments so tokens inside them are inert. */
function stripLiteralsAndComments(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      out += quote;
      i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\') i++;
        i++;
      }
      out += quote;
      i++;
      continue;
    }
    if (ch === '#') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Walk the query text and classify each all-variable triple pattern by its
 * enclosing context: default graph, GRAPH <bound>, or GRAPH ?var — while
 * tracking FILTER [NOT] EXISTS / MINUS probe scopes.
 */
function analyzeQuery(queryText, exprs) {
  const stripped = stripLiteralsAndComments(queryText);
  const findings = [];

  const hasLimit = /\bLIMIT\s+(\d+|⟪\d+⟫)/i.test(stripped);
  const hasOrderBy = /\bORDER\s+BY\b/i.test(stripped);
  const boundedNoSort = hasLimit && !hasOrderBy;
  const isPlainAsk = /^\s*ASK\b/i.test(stripped.replace(/^\s*(PREFIX[^\n]*\n|BASE[^\n]*\n)*/i, ''))
    && !/\bFILTER\b/i.test(stripped);

  // VALUES-bound graph variables are effectively constants.
  const valuesBound = new Set();
  for (const m of stripped.matchAll(/\bVALUES\s+\?(\w+)/gi)) valuesBound.add(m[1]);

  // Context walk.
  const stack = [];
  let i = 0;
  const graphHeader = /GRAPH\s+(\?(\w+)|<([^<>]*)>|⟪(\d+)⟫)\s*$/i;
  const probeHeader = /(FILTER\s+(NOT\s+)?EXISTS|MINUS|NOT\s+EXISTS)\s*$/i;
  let pending = '';

  // Evaluate the accumulated statement for an all-variable triple
  // (`?a ?b ?c` — the keyword predicate `a` and any prefixed/IRI term count
  // as bound and therefore never match).
  const checkPending = (offset) => {
    const statement = pending.trim();
    pending = '';
    if (!/(^|[\s{])\?\w+\s+\?\w+\s+\?\w+$/.test(statement)) return;
    // CONSTRUCT/INSERT/DELETE templates describe OUTPUT, not a scan.
    if (stack.some((f) => f.kind === 'probe' || f.kind === 'template')) return;
    const graphFrame = [...stack].reverse().find((f) => f.kind.startsWith('graph'));
    if (!graphFrame) {
      if (!boundedNoSort && !isPlainAsk) findings.push({ rule: 'R1', offset });
      return;
    }
    if (graphFrame.kind === 'graph-var') {
      if (!boundedNoSort) findings.push({ rule: 'R2', offset });
      return;
    }
    const ref = graphFrame.ref ?? '';
    const phMatch = ref.match(/⟪(\d+)⟫/);
    const exprText = phMatch ? (exprs[Number(phMatch[1])] ?? '') : '';
    const literalRef = ref.replace(/⟪\d+⟫/g, '');
    const unbounded = (exprText !== '' && UNBOUNDED_GRAPH_EXPR.test(exprText))
      || UNBOUNDED_GRAPH_LITERAL.test(literalRef);
    if (unbounded && !hasLimit) findings.push({ rule: 'R4', offset });
  };

  while (i < stripped.length) {
    const ch = stripped[i];
    if (ch === '{') {
      const head = pending.trimEnd();
      const graphMatch = head.match(graphHeader);
      const probeMatch = head.match(probeHeader);
      // `CONSTRUCT { … }`, `INSERT [DATA] { … }`, `DELETE [DATA] { … }` blocks
      // are output templates, not scan patterns. `DELETE WHERE { … }` and any
      // WHERE-headed block remain patterns.
      const templateMatch = head.match(/\b(CONSTRUCT|INSERT(\s+DATA)?|DELETE(\s+DATA)?)\s*$/i);
      let frame = { kind: 'group' };
      if (probeMatch) {
        frame = { kind: 'probe' };
      } else if (templateMatch) {
        frame = { kind: 'template' };
      } else if (graphMatch) {
        if (graphMatch[2] !== undefined) {
          frame = valuesBound.has(graphMatch[2])
            ? { kind: 'graph-bound', ref: `?${graphMatch[2]}` }
            : { kind: 'graph-var', ref: `?${graphMatch[2]}` };
        } else if (graphMatch[3] !== undefined) {
          frame = { kind: 'graph-bound', ref: graphMatch[3] };
        } else {
          frame = { kind: 'graph-bound', ref: `⟪${graphMatch[4]}⟫` };
        }
      }
      stack.push(frame);
      pending = '';
      i++;
      continue;
    }
    if (ch === '}') {
      checkPending(i); // a triple can end at the group close with no dot
      stack.pop();
      i++;
      continue;
    }
    if (ch === '.' || ch === ';') {
      checkPending(i);
      i++;
      continue;
    }
    pending += ch === '\n' ? ' ' : ch;
    i++;
  }

  // R3: OFFSET with a nonzero or interpolated operand.
  for (const m of stripped.matchAll(/\bOFFSET\s+(\d+|⟪\d+⟫)/gi)) {
    if (m[1] !== '0') findings.push({ rule: 'R3', offset: m.index ?? 0 });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Pragmas, fingerprints, per-file scan
// ---------------------------------------------------------------------------

const PRAGMA = /sparql-scan-allow:\s*(R\d)\s*--\s*(\S.*)/;

function collectPragmas(literalText, source, literalStartLine) {
  const allowed = new Set();
  for (const line of literalText.split('\n')) {
    const m = line.match(PRAGMA);
    if (m) allowed.add(m[1]);
  }
  const lines = source.split('\n');
  for (let l = Math.max(0, literalStartLine - 4); l < literalStartLine; l++) {
    const m = (lines[l] ?? '').match(PRAGMA);
    if (m) allowed.add(m[1]);
  }
  return allowed;
}

function normalizeForFingerprint(text) {
  return text
    .replace(/⟪\d+⟫/g, '@')
    .replace(/#[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function scanSource(filePath, source) {
  const findings = [];
  for (const literal of extractTemplateLiterals(source)) {
    if (!looksLikeSparql(literal.text)) continue;
    const raw = analyzeQuery(literal.text, literal.exprs);
    if (raw.length === 0) continue;
    const allowed = collectPragmas(literal.text, source, literal.startLine);
    const fingerprintBase = normalizeForFingerprint(literal.text);
    for (const f of raw) {
      const line = literal.startLine + literal.text.slice(0, f.offset).split('\n').length - 1;
      const fingerprint = createHash('sha1')
        .update(`${f.rule} ${fingerprintBase}`)
        .digest('hex');
      findings.push({
        file: filePath,
        line,
        rule: f.rule,
        allowed: allowed.has(f.rule),
        fingerprint,
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}

function listTrackedSourceFiles() {
  return git(['ls-files'])
    .split('\n')
    .filter((f) => f && SCANNED_EXTENSIONS.test(f) && !EXCLUDED_PATH.test(f));
}

function changedSourceFiles(baseSha, headSha) {
  return git(['diff', '--name-only', '--diff-filter=ACMR', baseSha, headSha])
    .split('\n')
    .filter((f) => f && SCANNED_EXTENSIONS.test(f) && !EXCLUDED_PATH.test(f));
}

function fileAt(sha, path) {
  try {
    return git(['show', `${sha}:${path}`]);
  } catch {
    return null; // added file — no baseline
  }
}

function report(finding, { status, level }) {
  const rule = RULES[finding.rule];
  console.log(
    `::${level} file=${finding.file},line=${finding.line},title=sparql-scale-lint ${rule.id} ${rule.name}::` +
    `${rule.message} [${status}] To acknowledge: "sparql-scan-allow: ${rule.id} -- <why this is bounded>"`,
  );
}

function runDiff(baseSha, headSha) {
  const files = changedSourceFiles(baseSha, headSha);
  if (files.length === 0) {
    console.log('sparql-scale-lint: no scannable source changes.');
    return 0;
  }
  const baseline = new Set();
  for (const file of files) {
    const baseSource = fileAt(baseSha, file);
    if (!baseSource) continue;
    for (const f of scanSource(file, baseSource)) baseline.add(f.fingerprint);
  }
  let blocking = 0;
  let acknowledged = 0;
  let grandfathered = 0;
  for (const file of files) {
    const headSource = fileAt(headSha, file);
    if (headSource === null) continue;
    for (const f of scanSource(file, headSource)) {
      const isNew = !baseline.has(f.fingerprint);
      if (f.allowed) {
        acknowledged++;
        report(f, { status: 'acknowledged by pragma', level: 'notice' });
      } else if (isNew) {
        blocking++;
        report(f, { status: 'NEW — blocks merge', level: 'error' });
      } else {
        grandfathered++;
        report(f, { status: 'pre-existing (grandfathered; fix when touched)', level: 'notice' });
      }
    }
  }
  console.log(
    `sparql-scale-lint: ${blocking} new blocking, ${acknowledged} acknowledged, ` +
    `${grandfathered} grandfathered (files scanned: ${files.length}).`,
  );
  if (blocking > 0) {
    console.log(
      '\nA newly added SPARQL query matches a known store-melting shape. Restructure it ' +
      '(exact graph scope, bound term, keyset paging, LIMIT) or — if it is provably bounded — ' +
      'acknowledge it in code with `sparql-scan-allow: <rule> -- <justification>` so reviewers see the decision.',
    );
    return 1;
  }
  return 0;
}

function runAll(files) {
  let total = 0;
  for (const file of files) {
    let source;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const f of scanSource(file, source)) {
      report(f, {
        status: f.allowed ? 'acknowledged by pragma' : 'unacknowledged (audit)',
        level: 'notice',
      });
      if (!f.allowed) total++;
    }
  }
  console.log(`sparql-scale-lint: ${total} unacknowledged findings across ${files.length} files.`);
  return 0; // audit mode never fails — the ratchet is the gate
}

// ---------------------------------------------------------------------------
// Self-test fixtures (run in CI before the scan so the gate can't rot)
// ---------------------------------------------------------------------------

const FIXTURES = [
  {
    name: 'R1 unscoped scan',
    source: 'const q = `SELECT ?s WHERE { ?s ?p ?o }`;',
    expect: ['R1'],
  },
  {
    name: 'R1 exempt: LIMIT without ORDER BY',
    source: 'const q = `SELECT ?s WHERE { ?s ?p ?o } LIMIT 10`;',
    expect: [],
  },
  {
    name: 'R1 still fires: LIMIT with ORDER BY materializes everything',
    source: 'const q = `SELECT ?s WHERE { ?s ?p ?o } ORDER BY ?s LIMIT 10`;',
    expect: ['R1'],
  },
  {
    name: 'R1 exempt: plain ASK short-circuits',
    source: 'const q = `ASK { ?s ?p ?o }`;',
    expect: [],
  },
  {
    name: 'R2 legacy listGraphs storm shape (#1597)',
    source: 'const q = `SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } }`;',
    expect: ['R2'],
  },
  {
    name: 'R2 exempt: fixed #1597 form — existence probe',
    source: 'const q = `SELECT ?g WHERE { GRAPH ?g {} FILTER EXISTS { GRAPH ?g { ?s ?p ?o } } }`;',
    expect: [],
  },
  {
    name: 'R2 exempt: VALUES-bound graph variable',
    source: 'const q = `SELECT ?s WHERE { VALUES ?g { <urn:a> } GRAPH ?g { ?s ?p ?o } }`;',
    expect: [],
  },
  {
    name: 'bound-subject pattern inside GRAPH ?g is fine',
    source: 'const q = `SELECT ?v WHERE { GRAPH ?g { <urn:x> <urn:p> ?v } }`;',
    expect: [],
  },
  {
    name: 'R3 offset pagination',
    source: 'const q = `SELECT ?s WHERE { GRAPH <urn:g> { ?s <urn:p> ?o } } LIMIT 100 OFFSET ${offset}`;',
    expect: ['R3'],
  },
  {
    name: 'R3 exempt: OFFSET 0 literal',
    source: 'const q = `SELECT ?s WHERE { GRAPH <urn:g> { ?s <urn:p> ?o } } LIMIT 100 OFFSET 0`;',
    expect: [],
  },
  {
    name: 'R4 bucket scan (#1609 SWM-slice shape)',
    source: 'const q = `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${this.graphManager.sharedMemoryUri(cgId)}> { ?s ?p ?o } }`;',
    expect: ['R4'],
  },
  {
    name: 'R4 meta-graph literal scan',
    source: 'const q = `SELECT ?s ?p ?o WHERE { GRAPH <did:dkg:context-graph:x/_meta> { ?s ?p ?o } }`;',
    expect: ['R4'],
  },
  {
    name: 'R4 exempt: per-KA exact graph is bounded',
    source: 'const q = `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${swmGraph}> { ?s ?p ?o } }`;',
    expect: [],
  },
  {
    name: 'R4 exempt with LIMIT',
    source: 'const q = `SELECT ?s WHERE { GRAPH <${metaGraph}> { ?s ?p ?o } } LIMIT 500`;',
    expect: [],
  },
  {
    name: 'pragma acknowledges (JS comment above)',
    source: '// sparql-scan-allow: R4 -- catalog floor capped at 64 triples\nconst q = `SELECT ?s WHERE { GRAPH <${catalogGraph}> { ?s ?p ?o } }`;',
    expect: ['R4:allowed'],
  },
  {
    name: 'pragma inside the query text',
    source: 'const q = `# sparql-scan-allow: R1 -- startup migration, single-node\nSELECT ?s WHERE { ?s ?p ?o }`;',
    expect: ['R1:allowed'],
  },
  {
    name: 'pragma without justification does NOT acknowledge',
    source: '// sparql-scan-allow: R1 --\nconst q = `SELECT ?s WHERE { ?s ?p ?o }`;',
    expect: ['R1'],
  },
  {
    name: 'non-SPARQL template untouched',
    source: 'const msg = `hello ${name}, WHERE were you?`;',
    expect: [],
  },
  {
    name: 'update DELETE WHERE unscoped all-var',
    source: 'const q = `DELETE WHERE { ?s ?p ?o }`;',
    expect: ['R1'],
  },
  {
    name: 'interpolated graph pattern with bound predicate is fine',
    source: 'const q = `SELECT ?op ?root WHERE { GRAPH <${wsMetaGraph}> { ?op <${DKG_NS}rootEntity> ?root } }`;',
    expect: [],
  },
];

function selfTest() {
  let failures = 0;
  for (const fixture of FIXTURES) {
    const found = scanSource('fixture.ts', fixture.source)
      .map((f) => (f.allowed ? `${f.rule}:allowed` : f.rule))
      .sort();
    const expected = [...fixture.expect].sort();
    const pass = JSON.stringify(found) === JSON.stringify(expected);
    if (!pass) {
      failures++;
      console.error(`SELF-TEST FAIL: ${fixture.name}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(found)}`);
    }
  }
  console.log(`sparql-scale-lint self-test: ${FIXTURES.length - failures}/${FIXTURES.length} fixtures pass.`);
  return failures === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------

import { pathToFileURL } from 'node:url';
const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main();
}

function main() {
const argv = process.argv.slice(2);
let exitCode = 0;
if (argv[0] === '--self-test') {
  exitCode = selfTest();
} else if (argv[0] === '--diff') {
  const [, baseSha, headSha] = argv;
  if (!baseSha || !headSha) {
    console.error('usage: sparql-scale-lint.mjs --diff <baseSha> <headSha>');
    exitCode = 2;
  } else {
    exitCode = selfTest() || runDiff(baseSha, headSha);
  }
} else if (argv[0] === '--all') {
  exitCode = runAll(listTrackedSourceFiles());
} else if (argv[0] === '--files') {
  exitCode = runAll(argv.slice(1));
} else {
  console.error('usage: sparql-scale-lint.mjs --diff <base> <head> | --all | --files <paths…> | --self-test');
  exitCode = 2;
}
process.exit(exitCode);
}
