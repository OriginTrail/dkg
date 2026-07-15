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
 * Extraction uses the TypeScript compiler API (already a root devDependency);
 * the SPARQL-shape analysis itself is plain string analysis, because the
 * queries are template literals full of ${…} that no SPARQL parser accepts.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import ts from 'typescript';

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
/**
 * Extract every template literal from JS/TS source using the TypeScript
 * compiler API (a root devDependency — no new install weight). Each literal
 * is returned as { text, exprs, startLine } with interpolations replaced by
 * `⟪i⟫` placeholders (index into exprs, which hold the expression source
 * text for the R4 graph-family heuristic).
 *
 * A real parser here is load-bearing: a hand lexer must re-solve JS
 * tokenization (regex-vs-division, nested templates, escapes) and an early
 * version of this tool was desynced by an IRI-safety regex containing a
 * quote. Template literals nested inside interpolations are visited as their
 * own nodes, so SPARQL built inside SPARQL is analyzed too.
 */
export function extractTemplateLiterals(source, fileName = 'source.ts') {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  const literals = [];
  const startLineOf = (node) =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const visit = (node) => {
    if (ts.isNoSubstitutionTemplateLiteral(node)) {
      literals.push({ text: node.text, exprs: [], startLine: startLineOf(node) });
    } else if (ts.isTemplateExpression(node)) {
      let text = node.head.text;
      const exprs = [];
      for (const span of node.templateSpans) {
        text += `⟪${exprs.length}⟫`;
        exprs.push(span.expression.getText(sourceFile).trim());
        text += span.literal.text;
      }
      literals.push({ text, exprs, startLine: startLineOf(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
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
      // Keep the quotes (term-shape matters) but DROP the contents, so a
      // literal like "has FILTER inside" cannot confuse keyword detection.
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

  // Solution modifiers count only at the TOP level of the query: a LIMIT
  // inside a subquery bounds that subquery, not an outer store-wide scan.
  // (Fail-closed corollary: an all-var triple inside a LIMITed subquery still
  // flags — acknowledge with a pragma when the inner bound is intentional.)
  let topLevelLimit = false;
  let topLevelOrderBy = false;
  {
    let depth = 0;
    const tokenRe = /[{}]|\bLIMIT\s+(?:\d+|⟪\d+⟫)|\bORDER\s+BY\b/gi;
    let m;
    while ((m = tokenRe.exec(stripped)) !== null) {
      if (m[0] === '{') depth++;
      else if (m[0] === '}') depth--;
      else if (depth === 0 && /^LIMIT/i.test(m[0])) topLevelLimit = true;
      else if (depth === 0) topLevelOrderBy = true;
    }
  }
  const hasLimit = topLevelLimit;
  const boundedNoSort = topLevelLimit && !topLevelOrderBy;
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
    let statement = pending.trim();
    pending = '';
    // SPARQL allows a triples block to run straight into FILTER/BIND/… with
    // no dot; strip the trailing clause so the triple itself is still seen.
    statement = statement
      .replace(/\b(FILTER|OPTIONAL|BIND|VALUES|SERVICE|MINUS|UNION|GRAPH|EXISTS)\b[\s\S]*$/i, '')
      .trim();
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
      // A triple can run straight into `OPTIONAL {`/`FILTER EXISTS {` with no
      // dot — evaluate it before the new frame swallows the pending text.
      // (checkPending strips the trailing keyword clause itself; save/restore
      // pending because the header text is still needed below.)
      const savedPending = pending;
      checkPending(i);
      pending = savedPending;
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
        .update(`${f.rule}:${fingerprintBase}`)
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

function git(args, cwd = process.cwd()) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd });
}

function listTrackedSourceFiles() {
  return git(['ls-files'])
    .split('\n')
    .filter((f) => f && SCANNED_EXTENSIONS.test(f) && !EXCLUDED_PATH.test(f));
}

function changedSourceFiles(baseSha, headSha, cwd = process.cwd()) {
  return git(['diff', '--name-only', '--diff-filter=ACMR', baseSha, headSha], cwd)
    .split('\n')
    .filter((f) => f && SCANNED_EXTENSIONS.test(f) && !EXCLUDED_PATH.test(f));
}

function fileAt(sha, path, cwd = process.cwd()) {
  try {
    return git(['show', `${sha}:${path}`], cwd);
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

/**
 * Pure diff-gate core (exported for the self-test): compare head findings
 * against the base version of each changed file.
 *
 * The baseline is a MULTISET (fingerprint → count), not a set: a PR that
 * duplicates an existing grandfathered query adds one more O(store) scan and
 * must block, even though the copy's normalized text is identical. Each head
 * occurrence consumes one baseline occurrence; the surplus is new.
 */
export function computeDiffFindings(baseSha, headSha, cwd = process.cwd()) {
  const files = changedSourceFiles(baseSha, headSha, cwd);
  const baseline = new Map();
  for (const file of files) {
    const baseSource = fileAt(baseSha, file, cwd);
    if (!baseSource) continue;
    for (const f of scanSource(file, baseSource)) {
      baseline.set(f.fingerprint, (baseline.get(f.fingerprint) ?? 0) + 1);
    }
  }
  const results = [];
  for (const file of files) {
    const headSource = fileAt(headSha, file, cwd);
    if (headSource === null) continue;
    for (const f of scanSource(file, headSource)) {
      if (f.allowed) {
        results.push({ ...f, verdict: 'acknowledged' });
        continue;
      }
      const remaining = baseline.get(f.fingerprint) ?? 0;
      if (remaining > 0) {
        baseline.set(f.fingerprint, remaining - 1);
        results.push({ ...f, verdict: 'grandfathered' });
      } else {
        results.push({ ...f, verdict: 'new' });
      }
    }
  }
  return { files, results };
}

function runDiff(baseSha, headSha) {
  const { files, results } = computeDiffFindings(baseSha, headSha);
  if (files.length === 0) {
    console.log('sparql-scale-lint: no scannable source changes.');
    return 0;
  }
  let blocking = 0;
  let acknowledged = 0;
  let grandfathered = 0;
  for (const f of results) {
    if (f.verdict === 'acknowledged') {
      acknowledged++;
      report(f, { status: 'acknowledged by pragma', level: 'notice' });
    } else if (f.verdict === 'new') {
      blocking++;
      report(f, { status: 'NEW — blocks merge', level: 'error' });
    } else {
      grandfathered++;
      report(f, { status: 'pre-existing (grandfathered; fix when touched)', level: 'notice' });
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
    name: 'R1 fires when FILTER follows the triple with no dot',
    source: 'const q = `SELECT ?s WHERE { ?s ?p ?o FILTER(?p = <urn:p>) }`;',
    expect: ['R1'],
  },
  {
    name: 'R2 fires when FILTER follows the triple with no dot inside GRAPH ?g',
    source: 'const q = `SELECT ?s WHERE { GRAPH ?g { ?s ?p ?o FILTER(?o > 1) } }`;',
    expect: ['R2'],
  },
  {
    name: 'R1 fires when OPTIONAL follows the triple with no dot',
    source: 'const q = `SELECT ?s WHERE { ?s ?p ?o OPTIONAL { ?s <urn:p> ?x } }`;',
    expect: ['R1'],
  },
  {
    name: 'R1 fires despite an unrelated LIMITed subquery (outer scan unbounded)',
    source: 'const q = `SELECT ?s WHERE { ?s ?p ?o . { SELECT ?x WHERE { <urn:a> <urn:b> ?x } LIMIT 1 } }`;',
    expect: ['R1'],
  },
  {
    name: 'fail-closed: a subquery-local LIMIT does not exempt its own all-var scan',
    // Deliberate: per-group LIMIT binding is not modeled; a bounded inner scan
    // that trips this should carry a pragma. Top-level LIMIT remains exempt.
    source: 'const q = `SELECT ?s WHERE { { SELECT ?x WHERE { ?x ?p ?o } LIMIT 5 } }`;',
    expect: ['R1'],
  },
  {
    name: 'top-level LIMIT still exempts when a subquery also has one',
    source: 'const q = `SELECT ?s WHERE { ?s ?p ?o . { SELECT ?x WHERE { <urn:a> <urn:b> ?x } LIMIT 1 } } LIMIT 10`;',
    expect: [],
  },
  {
    name: 'string literal containing keywords does not confuse the walker',
    source: 'const q = `SELECT ?s WHERE { ?s <urn:p> "FILTER LIMIT GRAPH" }`;',
    expect: [],
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

/**
 * Integration self-test for the RATCHET itself — the layer that decides
 * whether a PR blocks. Builds a throwaway git repo and asserts:
 *   1. duplicating a grandfathered query blocks with exactly ONE new finding
 *      (multiset semantics — membership alone would let copies through);
 *   2. reindenting/rewrapping the same query stays grandfathered;
 *   3. adding a genuinely new offending query blocks.
 */
function diffGateSelfTest() {
  const dir = mkdtempSync(join(tmpdir(), 'sparql-lint-selftest-'));
  const g = (...args) => git(args, dir);
  const BAD = 'const a = `SELECT ?s WHERE { ?s ?p ?o }`;\n';
  try {
    g('init', '-q');
    g('config', 'user.email', 'selftest@example.invalid');
    g('config', 'user.name', 'sparql-lint-selftest');
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/a.ts'), BAD);
    g('add', '-A');
    g('commit', '-qm', 'base');
    const base = g('rev-parse', 'HEAD').trim();

    // 1. duplicate of the grandfathered query → exactly one NEW finding
    writeFileSync(join(dir, 'src/a.ts'), BAD + 'const b = `SELECT ?s WHERE { ?s ?p ?o }`;\n');
    g('commit', '-aqm', 'dup');
    const dupHead = g('rev-parse', 'HEAD').trim();
    const dup = computeDiffFindings(base, dupHead, dir).results;
    const dupNew = dup.filter((f) => f.verdict === 'new').length;
    const dupOld = dup.filter((f) => f.verdict === 'grandfathered').length;
    if (dupNew !== 1 || dupOld !== 1) {
      console.error(`DIFF-GATE FAIL: duplicated query → new=${dupNew} grandfathered=${dupOld} (want 1/1)`);
      return false;
    }

    // 2. reindent/rewrap only → still grandfathered, nothing new
    writeFileSync(join(dir, 'src/a.ts'), 'const a = `SELECT ?s\n  WHERE {\n    ?s ?p ?o\n  }`;\n');
    g('commit', '-aqm', 'reindent');
    const reHead = g('rev-parse', 'HEAD').trim();
    const re = computeDiffFindings(base, reHead, dir).results;
    if (re.some((f) => f.verdict === 'new') || re.filter((f) => f.verdict === 'grandfathered').length !== 1) {
      console.error(`DIFF-GATE FAIL: reindent → ${JSON.stringify(re.map((f) => f.verdict))} (want one grandfathered)`);
      return false;
    }

    // 3. a genuinely new shape blocks
    writeFileSync(join(dir, 'src/a.ts'), BAD + 'const c = `SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } }`;\n');
    g('commit', '-aqm', 'new-shape');
    const newHead = g('rev-parse', 'HEAD').trim();
    const fresh = computeDiffFindings(base, newHead, dir).results;
    if (fresh.filter((f) => f.verdict === 'new').length !== 1) {
      console.error(`DIFF-GATE FAIL: new shape → ${JSON.stringify(fresh.map((f) => f.verdict))} (want one new)`);
      return false;
    }
    return true;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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
  const gateOk = diffGateSelfTest();
  console.log(
    `sparql-scale-lint self-test: ${FIXTURES.length - failures}/${FIXTURES.length} fixtures pass, ` +
    `diff-gate ${gateOk ? 'pass' : 'FAIL'}.`,
  );
  return failures === 0 && gateOk ? 0 : 1;
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
