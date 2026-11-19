#!/usr/bin/env node
// Checks a design against the node UI design system and says, for every value
// that isn't on it, which token or component to use instead, or that the
// system needs a new one (DESIGN.md · Adding to the system).
//
// Works on node UI code (CSS, TSX) and on mock-ups (HTML with <style> blocks or
// style attributes), so a new design can be checked before anyone builds it.
// The scale is read from src/ui/styles/00-theme.css on every run, so it never
// falls behind the tokens.
//
//   pnpm design:check path/to/mockup.html          one design
//   pnpm design:check src/ui/pages                  a folder
//   pnpm design:check --changed                     only lines this branch adds (vs origin/testnet-canary)
//   pnpm design:check --changed origin/main         ... vs another base
//   flags: --json  machine-readable output   --no-fail  always exit 0
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseColour } from './colour.mjs';
import { classify, declarations, lineIndex, literals, maskHtmlComments, resolveVars, stripComments } from './design-rules.mjs';
import { ADD, suggest } from './design-suggest.mjs';

export { declarations, parseColour };

// DESIGN_CHECK_PKG points the check at another copy of the package: the tests use it
// to run --changed against a git repository of their own.
const PKG = process.env.DESIGN_CHECK_PKG ? resolve(process.env.DESIGN_CHECK_PKG) : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UI = join(PKG, 'src/ui');
const THEME = join(UI, 'styles/00-theme.css');
const EXTENSIONS = new Set(['.css', '.html', '.htm', '.tsx', '.jsx']);

// ── The system ──────────────────────────────────────────────────────────────

/**
 * @typedef {object} TokenInventory
 * @property {Map<string, string>} byName       each token's first value (the dark one, where a theme redefines it)
 * @property {Array<[string, string]>} allValues every definition in every theme, in file order
 */

/** Tokens from 00-theme.css. @returns {TokenInventory} */
export function readTokens(css = readFileSync(THEME, 'utf8')) {
  const byName = new Map();
  const allValues = [];
  for (const m of stripComments(css).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    if (!byName.has(m[1])) byName.set(m[1], m[2].trim());
    allValues.push([m[1], m[2].trim()]);
  }
  return { byName, allValues };
}

/** The scales the rules check against. @param {TokenInventory} inventory */
export function buildSystem(inventory) {
  const { byName, allValues } = inventory ?? {};
  if (!(byName instanceof Map) || !Array.isArray(allValues)) throw new TypeError('buildSystem takes the { byName, allValues } that readTokens returns');
  const tokens = byName;
  const px = (prefix) => [...tokens].filter(([n, v]) => n.startsWith(prefix) && /^\d+px$/.test(v))
    .map(([name, v]) => ({ name, value: parseInt(v, 10) }));
  // Colours match against every theme's value, so a colour can match its dark or its light one.
  const colours = [];
  for (const [name, v] of allValues) {
    const c = parseColour(v);
    if (c && !/^--(data|log)-/.test(name)) colours.push({ name, rgb: c.rgb, alpha: c.alpha, text: v });
  }
  return {
    tokens,
    radius: px('--radius-').filter((t) => t.name !== '--radius-pill'),
    space: px('--space-'),
    fontSize: px('--fs-'),
    height: [...px('--h-'), ...px('--header-h'), ...px('--tab-h')],
    lineHeight: [...tokens].filter(([n]) => n.startsWith('--lh-')).map(([name, v]) => ({ name, value: Number(v) })),
    z: [...tokens].filter(([n]) => n.startsWith('--z-')).map(([name, v]) => ({ name, value: Number(v) })),
    motion: [...tokens].filter(([n]) => n.startsWith('--motion-')).map(([name, v]) => ({ name, value: parseFloat(v) * 1000 })),
    shadows: [...tokens].filter(([n]) => n.startsWith('--shadow-')).map(([name]) => name),
    colours,
  };
}

/** Custom properties a stylesheet in the UI defines at runtime (--cg-color and the like), which are fine to read. */
export function runtimeProps() {
  const names = new Set();
  for (const file of walk(UI)) {
    if (!/\.(css|tsx?)$/.test(file)) continue;
    for (const m of readFileSync(file, 'utf8').matchAll(/['"[]?(--[\w-]+)['"]?(?:\s+as\s+\w+)?\]?\s*:/g)) names.add(m[1]);
  }
  return names;
}

// ── Values ──────────────────────────────────────────────────────────────────

const COLOUR = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b|\b(?:rgba?|hsla?)\([^)]*\)/gi;

/** CIE76 distance in Lab: under ~2 reads as the same colour, under ~10 as a close one. */
export function colourDistance(a, b) {
  const lab = (rgb) => {
    const [r, g, bl] = rgb.map((c) => { const v = c / 255; return v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92; });
    const x = (r * 0.4124 + g * 0.3576 + bl * 0.1805) / 0.95047;
    const y = r * 0.2126 + g * 0.7152 + bl * 0.0722;
    const z = (r * 0.0193 + g * 0.1192 + bl * 0.9505) / 1.08883;
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
  };
  const [p, q] = [lab(a), lab(b)];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

const ROLES = {
  fill: /^--(bg-|surface|tint-)|-bg(-strong)?$/,
  text: /^--text-|-text$/,
  border: /border/,
};

/** What a colour is for, from the property or, for a mock-up's own variable, from its name. */
function colourRole(prop) {
  if (prop.startsWith('--')) {
    if (/border|line|divider|stroke/.test(prop)) return 'border';
    if (/text|fg|muted|ink|foreground/.test(prop)) return 'text';
    if (/bg|surface|panel|card|background|fill/.test(prop)) return 'fill';
    return null;
  }
  if (/^(background|fill)/.test(prop)) return 'fill';
  if (/^(color|caret-color|-webkit-text-fill-color)$/.test(prop)) return 'text';
  if (/^(border|outline)/.test(prop)) return 'border';
  return null;
}

// ── Rules ───────────────────────────────────────────────────────────────────
// Each rule looks at one declaration (property, value) and returns findings:
// { kind, value, use } where `use` is the suggestion. Colours and unknown tokens are
// checked here; literal values go through classify() and suggest().

export function checkDeclaration(system, prop, value, { known, mockup = false } = {}) {
  const out = [];
  const p = prop.toLowerCase();
  const v = value.replace(/!important/, '').trim();

  // Colour, wherever it appears. A mock-up's own variables are checked where they are
  // defined, so `--surface: #141414` says which node UI token it stands for.
  if (!p.startsWith('--') || (mockup && !system.tokens.has(p))) {
    for (const m of v.matchAll(COLOUR)) {
      const c = parseColour(m[0]);
      if (!c) continue;
      // Opacity counts: a 10% white wash isn't an opaque white token.
      const score = (t) => colourDistance(c.rgb, t.rgb) + Math.abs(c.alpha - t.alpha) * 100;
      const pick = (list) => list.reduce((b, t) => {
        const d = score(t);
        return !b || d < b.d ? { t, d } : b;
      }, null);
      // Prefer a token with the same job (a fill for a fill, text for text), if one is close.
      const role = colourRole(p);
      const inRole = pick(role ? system.colours.filter((t) => ROLES[role].test(t.name)) : []);
      const best = inRole && inRole.d < 10 ? inRole : pick(system.colours);
      const exact = best && best.d < 2;
      let use;
      if (exact) use = `var(${best.t.name})`;
      else if (best && best.d < 10) use = `nearest is var(${best.t.name}) (${best.t.text}), ${ADD}`;
      else if (c.alpha < 1) {
        // A wash: keep the opacity on a token of the same colour, if there is one.
        const base = pick(system.colours.filter((t) => t.alpha === 1).map((t) => ({ ...t, alpha: c.alpha })));
        const pct = Math.round(c.alpha * 100);
        use = base && base.d < 2
          ? `a ${pct}% wash of var(${base.t.name}): use a tint token (--tint-*, --*-bg) if one fits, or color-mix(in srgb, var(${base.t.name}) ${pct}%, transparent)`
          : `no token is close. For a wash, use a tint token (--tint-*, --*-bg) or color-mix() on a token, ${ADD}`;
      } else use = `no token is close. If the colour has a job of its own, add a token with a value for both themes; if it only needs to stand out, use contrast and weight (DESIGN.md · Principles 2)`;
      out.push({ kind: 'colour', value: m[0], use, offScale: !exact });
    }
  }

  // Tokens that don't exist (a mock-up's own variables, or a typo).
  for (const m of v.matchAll(/var\(\s*(--[\w-]+)/g)) {
    if (!system.tokens.has(m[1]) && !known?.has(m[1])) {
      out.push({ kind: 'token', value: m[1], use: 'not a node UI token: use one from 00-theme.css (see the reference page), or add it there and to DESIGN.md', offScale: true });
    }
  }
  // Literal values, with the rules' exceptions applied in design-rules.mjs. A token in
  // the same declaration doesn't excuse the literals beside it (`padding: var(--space-4) 10px`).
  for (const hit of classify(p, v)) {
    const finding = suggest(system, hit);
    if (finding) out.push(finding);
  }
  const lit = literals(v);
  if (p === 'box-shadow' && mockup && /\d+px/.test(lit) && !/^inset\b/.test(v)) {
    out.push({ kind: 'shadow', value: v.slice(0, 40), use: `one shadow per kind of surface: ${system.shadows.map((s) => `var(${s})`).join(', ')}`, offScale: true });
  }
  return out;
}

// Components: markup that rebuilds something the system already has. Each rule reads
// the whole opening tag, so a tag that already has the shared class passes.
/** A class named for the thing (card, stat-card), not one that only starts with it (card-body). */
const endsWith = (classes, words) => classes.some((c) => new RegExp(`(${words})$`).test(c));
const COMPONENT_RULES = [
  {
    flags: (t) => t.name === 'button' && !t.classes.some((c) => /^ds-(btn|tab|seg-item|filter)$/.test(c)),
    use: '<Button> (or class="ds-btn"), see DESIGN.md · Button',
  },
  {
    flags: (t) => /^(input|select|textarea)$/.test(t.name) && !/\btype=["'](checkbox|radio|hidden|file|range)["']/i.test(t.tag) && !t.classes.includes('ds-input'),
    use: 'class="ds-input" (ds-sm in dense rows), see DESIGN.md · Inputs',
  },
  {
    flags: (t) => endsWith(t.classes, 'card') && !t.classes.some((c) => /^ds-card\b/.test(c)),
    use: 'class="ds-card" (ds-card-nested inside a card), see DESIGN.md · Card padding',
  },
  {
    flags: (t) => endsWith(t.classes, 'badge|pill|chip|tag') && !t.classes.some((c) => c.startsWith('ds-')),
    use: '<Badge>, <LayerBadge>, <Count> or <ContextGraphChip>, see DESIGN.md · Labels',
  },
  {
    flags: (t) => /^(div|section)$/.test(t.name) && (/\brole=["']dialog["']/i.test(t.tag) || t.classes.some((c) => /(modal|dialog)(-box)?$/.test(c))) && !t.classes.includes('ds-overlay'),
    use: 'class="ds-overlay", see DESIGN.md · Layout and overlays',
  },
];

/** Opening tags with their name and classes. A capitalised JSX component (<Button>) is a system part already. */
function openingTags(text) {
  return [...text.matchAll(/<([a-z][\w-]*)\b[^>]*>/g)].map((m) => {
    const cls = m[0].match(/\bclass(?:Name)?=(?:"([^"]*)"|'([^']*)'|\{\s*["'`]([^"'`]*)["'`]\s*\})/);
    return { name: m[1], tag: m[0], index: m.index, classes: (cls ? cls[1] ?? cls[2] ?? cls[3] : '').split(/\s+/).filter(Boolean) };
  });
}

function checkMarkup(text, lineOf, keepLine) {
  const out = [];
  for (const tag of openingTags(text)) {
    for (const rule of COMPONENT_RULES) {
      if (!rule.flags(tag)) continue;
      const line = lineOf(tag.index);
      if (keepLine(line)) out.push({ line, kind: 'component', value: tag.tag.slice(0, 60), use: rule.use, offScale: true });
    }
  }
  return out;
}

// ── Files ───────────────────────────────────────────────────────────────────

/** Files the rules skip: the tokens themselves, canvas palettes (graph-viz can't read CSS variables) and the reference page. */
const skipFile = (file) => /00-theme\.css$|-colors\.ts$|design-system[\w-]*\.(tsx|html)$/.test(file.replace(/\\/g, '/'));

export function checkText(system, text, file, { known, mockup = false, keepLine = () => true } = {}) {
  const ext = extname(file).toLowerCase();
  const findings = [];
  const decls = declarations(text, ext);
  // A mock-up's own variables (`--gap: 10px`) are checked where they're used, against the
  // scale of the property that uses them: `gap: var(--gap)` is a gap of 10px. Every
  // definition is kept with its scope, so a rule's own definition applies inside it.
  const defs = new Map();
  if (mockup) {
    for (const d of decls) {
      if (!d.prop.startsWith('--') || system.tokens.has(d.prop)) continue;
      if (!defs.has(d.prop)) defs.set(d.prop, []);
      defs.get(d.prop).push({ value: d.value, scope: d.scope });
    }
  }
  for (const d of decls) {
    // A declaration counts as changed when any line it spans is: `padding:\n  10px;` with only the value edited.
    let changed = false;
    for (let l = d.line; l <= (d.endLine ?? d.line) && !changed; l++) changed = keepLine(l);
    if (!changed) continue;
    // With several possible definitions, each value it could have is checked, once per finding.
    const values = defs.size && !d.prop.startsWith('--') ? resolveVars(d.value, defs, d.scope) : [d.value];
    const seen = new Set();
    for (const resolved of values) {
      for (const f of checkDeclaration(system, d.prop, resolved, { known, mockup })) {
        const key = `${f.kind}\0${f.value}\0${f.use}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({ line: d.line, prop: d.prop, ...f, ...(resolved !== d.value ? { written: d.value } : {}) });
      }
    }
  }
  // In shipped code, test/ds-classes.test.ts and test/button-classes.test.ts already check
  // components with the context they need. A mock-up has no such tests, so it gets the hints here.
  // Commented-out HTML renders nothing, so it isn't checked; offsets stay where they were.
  const markup = ext === '.html' || ext === '.htm' ? maskHtmlComments(text) : text;
  if (mockup && ext !== '.css') findings.push(...checkMarkup(markup, lineIndex(markup), keepLine));
  return findings.sort((a, b) => a.line - b.line);
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) return [];
    return e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)];
  });
}

/** Lines each file adds against `base`, from git. */
function changedLines(base) {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: PKG, encoding: 'utf8' }).trim();
  const diff = execFileSync('git', ['diff', '-U0', '--no-color', '--merge-base', base, '--', relative(root, UI)], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const files = new Map();
  let current = null;
  for (const line of diff.split('\n')) {
    const f = line.match(/^\+\+\+ b\/(.+)$/);
    if (f) { current = join(root, f[1]); files.set(current, new Set()); continue; }
    const h = line.match(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/);
    if (h && current) {
      const start = Number(h[1]); const count = h[2] === undefined ? 1 : Number(h[2]);
      for (let i = 0; i < count; i++) files.get(current).add(start + i);
    }
  }
  // Untracked files count in full.
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', UI], { cwd: PKG, encoding: 'utf8' })
    .split('\n').filter(Boolean).map((f) => join(PKG, f));
  for (const f of untracked) files.set(f, null);
  return files;
}

// ── Report ──────────────────────────────────────────────────────────────────

function main(argv) {
  const json = argv.includes('--json');
  const noFail = argv.includes('--no-fail');
  const args = argv.filter((a) => !a.startsWith('--'));
  const changedAt = argv.indexOf('--changed');
  const system = buildSystem(readTokens());
  const known = runtimeProps();

  let targets; // Map<file, Set<line> | null>
  if (changedAt !== -1) {
    const base = argv[changedAt + 1] && !argv[changedAt + 1].startsWith('--') ? argv[changedAt + 1] : 'origin/testnet-canary';
    targets = changedLines(base);
    args.splice(args.indexOf(base), args.includes(base) ? 1 : 0);
  } else {
    targets = new Map();
    for (const a of args.length ? args : [UI]) {
      const p = resolve(process.cwd(), a);
      if (!existsSync(p)) { console.error(`design-check: no such file: ${a}`); process.exit(2); }
      for (const f of statSync(p).isDirectory() ? walk(p) : [p]) targets.set(f, null);
    }
  }

  const results = [];
  for (const [file, lines] of targets) {
    if (!EXTENSIONS.has(extname(file).toLowerCase()) || skipFile(file) || !existsSync(file)) continue;
    const isMockup = !file.startsWith(UI);
    const text = readFileSync(file, 'utf8');
    const findings = checkText(system, text, file, {
      // A mock-up may read its own variables; their definitions are what get checked.
      known: isMockup ? new Set([...text.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1])) : known,
      mockup: isMockup,
      keepLine: lines ? (l) => lines.has(l) : undefined,
    });
    if (findings.length) results.push({ file: relative(process.cwd(), file).replace(/\\/g, '/'), findings });
  }

  const count = (pick) => {
    const kinds = {};
    for (const r of results) for (const f of r.findings) if (pick(f)) kinds[f.kind] = (kinds[f.kind] ?? 0) + 1;
    const n = Object.values(kinds).reduce((a, b) => a + b, 0);
    return { n, text: Object.entries(kinds).map(([k, c]) => `${c} ${k}`).join(', ') };
  };
  const off = count((f) => f.offScale);
  const named = count((f) => !f.offScale);

  if (json) {
    process.stdout.write(JSON.stringify(results, null, 2) + '\n');
  } else {
    // Off the system first: those need a decision. Then values on the scale written as numbers.
    for (const [title, pick] of [['Off the design system', (f) => f.offScale], ['On the scale, written as a number (use the token)', (f) => !f.offScale]]) {
      const rows = results.map((r) => ({ file: r.file, findings: r.findings.filter(pick) })).filter((r) => r.findings.length);
      if (!rows.length) continue;
      console.log(`\n── ${title} ──`);
      for (const r of rows) {
        console.log(`\n${r.file}`);
        for (const f of r.findings) console.log(`  ${String(f.line).padStart(4)}  ${f.kind.padEnd(10)} ${(f.prop ? `${f.prop}: ` : '') + f.value}${f.written ? ` (written ${f.written})` : ''}\n        → ${f.use}`);
      }
    }
    console.log('');
    if (off.n === 0 && named.n === 0) console.log('design-check: everything is on the design system.');
    if (named.n) console.log(`design-check: ${named.n} value${named.n === 1 ? '' : 's'} on the scale but written as a number (${named.text}).`);
    if (off.n) {
      console.log(`design-check: ${off.n} value${off.n === 1 ? '' : 's'} off the design system (${off.text}).`);
      console.log('Each one is either a mistake (use the suggestion) or a new rule. For a new rule, in the same PR:');
      console.log('  1. add the token to src/ui/styles/00-theme.css (colours: a value for both themes) or the component to src/ui/components/ds/');
      console.log('  2. describe its job in DESIGN.md');
      console.log('  3. show it on the reference page (ui/design-system.html)');
    }
  }
  // Only values off the system fail: a number that is on the scale is allowed in code today.
  process.exit(off.n && !noFail ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
