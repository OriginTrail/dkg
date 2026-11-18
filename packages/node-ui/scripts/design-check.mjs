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

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UI = join(PKG, 'src/ui');
const THEME = join(UI, 'styles/00-theme.css');
const EXTENSIONS = new Set(['.css', '.html', '.htm', '.tsx', '.jsx']);

// ── The system ──────────────────────────────────────────────────────────────

/** Tokens from 00-theme.css: every custom property and its literal value (the first, dark, value wins). */
export function readTokens(css = readFileSync(THEME, 'utf8')) {
  const tokens = new Map();
  const all = [];
  for (const m of stripComments(css).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    if (!tokens.has(m[1])) tokens.set(m[1], m[2].trim());
    all.push([m[1], m[2].trim()]);
  }
  tokens.all = all; // every value, so a colour can match its dark or its light value
  return tokens;
}

/** The scales the rules check against, built from the tokens. */
export function buildSystem(tokens) {
  const px = (prefix) => [...tokens].filter(([n, v]) => n.startsWith(prefix) && /^\d+px$/.test(v))
    .map(([name, v]) => ({ name, value: parseInt(v, 10) }));
  const colours = [];
  for (const [name, v] of tokens.all ?? tokens) {
    const rgb = parseColour(v);
    if (rgb && !/^--(data|log)-/.test(name)) colours.push({ name, rgb, text: v });
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

export function parseColour(text) {
  const t = text.trim().toLowerCase();
  let m = t.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  m = t.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
  if (m) return [m[1], m[2], m[3]].map(Number);
  m = t.match(/^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/);
  if (m) return hslToRgb(Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100);
  return null;
}

function hslToRgb(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
}

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

/** The closest step. On a tie, `up` picks the larger one (DESIGN.md · Spacing: padding rounds up, gaps and margins down). */
const nearest = (scale, value, up = false) => scale.reduce((best, t) => {
  if (!best) return t;
  const [d, bd] = [Math.abs(t.value - value), Math.abs(best.value - value)];
  return d < bd || (d === bd && (up ? t.value > best.value : t.value < best.value)) ? t : best;
}, null);

// ── Rules ───────────────────────────────────────────────────────────────────
// Each rule looks at one declaration (property, value) and returns findings:
// { kind, value, use } where `use` is the suggestion.

const ADD = 'or, if this is a new rule, add a token (DESIGN.md · Adding to the system)';

function scaleRule(kind, scale, value, unit = 'px', up = false) {
  const hit = scale.find((t) => t.value === value);
  if (hit) return { kind, use: `var(${hit.name})` };
  const near = nearest(scale, value, up);
  return { kind, use: near ? `nearest is var(${near.name}) (${near.value}${unit}), ${ADD}` : ADD, offScale: true };
}

export function checkDeclaration(system, prop, value, { known, mockup = false } = {}) {
  const out = [];
  const p = prop.toLowerCase();
  const v = value.replace(/!important/, '').trim();
  const pxValues = () => [...v.matchAll(/(?<![\w.#-])(-?\d*\.?\d+)px\b/g)].map((m) => Number(m[1]));

  // Colour, wherever it appears. A mock-up's own variables are checked where they are
  // defined, so `--surface: #141414` says which node UI token it stands for.
  if (!p.startsWith('--') || (mockup && !system.tokens.has(p))) {
    for (const m of v.matchAll(COLOUR)) {
      const rgb = parseColour(m[0]);
      if (!rgb) continue;
      // Prefer a token with the same job (a fill for a fill, text for text), if one is close.
      const role = colourRole(p);
      const sameRole = role ? system.colours.filter((t) => ROLES[role].test(t.name)) : [];
      const pick = (list) => list.reduce((b, t) => {
        const d = colourDistance(rgb, t.rgb);
        return !b || d < b.d ? { t, d } : b;
      }, null);
      const inRole = pick(sameRole);
      const best = inRole && inRole.d < 10 ? inRole : system.colours.reduce((b, t) => {
        const d = colourDistance(rgb, t.rgb);
        return !b || d < b.d ? { t, d } : b;
      }, null);
      const alpha = /rgba|hsla|#[0-9a-f]{8}\b/i.test(m[0]) && !/,\s*1\s*\)$/.test(m[0]);
      let use;
      if (best && best.d < 2) use = `var(${best.t.name})`;
      else if (best && best.d < 10) use = `nearest is var(${best.t.name}) (${best.t.text}), ${ADD}`;
      else use = `no token is close. If the colour has a job of its own, add a token with a value for both themes; if it only needs to stand out, use contrast and weight (DESIGN.md · Principles 2)`;
      if (alpha && !(best && best.d < 2)) use += '. For a wash, use a tint token (--tint-*, --*-bg) or color-mix() on a token';
      out.push({ kind: 'colour', value: m[0], use, offScale: !(best && best.d < 2) });
    }
  }

  // Tokens that don't exist (a mock-up's own variables, or a typo).
  for (const m of v.matchAll(/var\(\s*(--[\w-]+)/g)) {
    if (!system.tokens.has(m[1]) && !known?.has(m[1])) {
      out.push({ kind: 'token', value: m[1], use: 'not a node UI token: use one from 00-theme.css (see the reference page), or add it there and to DESIGN.md', offScale: true });
    }
  }
  if (v.includes('var(')) return out;

  if (/^border(-[a-z]+)*-radius$/.test(p)) {
    for (const n of pxValues()) if (n !== 0 && n < 100) out.push({ value: `${n}px`, ...scaleRule('corner', system.radius, n) });
    if (/\b(999|9999)px\b/.test(v)) out.push({ kind: 'corner', value: v, use: 'var(--radius-pill)' });
  } else if (/^(padding|margin|gap|row-gap|column-gap)(-[a-z]+)*$/.test(p)) {
    // Negative margins pull an element back by a known amount and stay as numbers.
    for (const n of pxValues()) if (n > 1) out.push({ value: `${n}px`, ...scaleRule('spacing', system.space, n, 'px', p.startsWith('padding')) });
  } else if (p === 'font-size' || p === 'font') {
    // `font: 15px/1.5 …` carries a size too; only its first px value is the size.
    for (const n of p === 'font' ? pxValues().slice(0, 1) : pxValues()) out.push({ value: `${n}px`, ...scaleRule('type size', system.fontSize, n) });
    if (/\d(r?em|pt)\b/.test(v) && v !== '1em') out.push({ kind: 'type size', value: v, use: 'type sizes are px tokens (--fs-*)', offScale: true });
  } else if (p === 'font-weight') {
    if (/^\d+$/.test(v) && !['400', '500', '600', '700'].includes(v)) out.push({ kind: 'weight', value: v, use: 'weights are 400, 500, 600 or 700', offScale: true });
  } else if (p === 'line-height') {
    const n = Number(v);
    if (!Number.isNaN(n) && n !== 1 && n !== 0) out.push({ value: v, ...scaleRule('line height', system.lineHeight, n, '') });
  } else if (p === 'z-index') {
    const n = Number(v);
    if (n > 10) out.push({ value: v, ...scaleRule('layer', system.z, n, '') });
  } else if (/^(height|min-height)$/.test(p)) {
    // Only sizes that are already a control or badge height: anything else may be layout.
    for (const n of pxValues()) {
      const hit = system.height.find((t) => t.value === n);
      if (hit) out.push({ kind: 'height', value: `${n}px`, use: `var(${hit.name}), if this is a control, badge or row` });
    }
  } else if (/^transition(-duration)?$/.test(p)) {
    // Transitions only: a looping animation (a spinner, a pulse) has its own length.
    for (const m of v.matchAll(/(?<![\w.-])(\d*\.?\d+)(m?s)\b/g)) {
      const ms = Number(m[1]) * (m[2] === 's' ? 1000 : 1);
      if (ms > 0.5) out.push({ value: m[0], ...scaleRule('motion', system.motion, ms, 'ms') });
    }
  } else if (p === 'box-shadow' && mockup && /\d+px/.test(v) && !/^inset\b/.test(v)) {
    out.push({ kind: 'shadow', value: v.slice(0, 40), use: `one shadow per kind of surface: ${system.shadows.map((s) => `var(${s})`).join(', ')}`, offScale: true });
  }
  return out;
}

// Components: markup that rebuilds something the system already has.
const COMPONENT_RULES = [
  { re: /<button\b(?![^>]*\bds-btn\b)(?![^>]*\bds-(tab|seg-item|filter)\b)[^>]*>/gi, use: '<Button> (or class="ds-btn"), see DESIGN.md · Button' },
  { re: /<(input|select|textarea)\b(?![^>]*type=["'](checkbox|radio|hidden|file|range)["'])(?![^>]*\bds-input\b)[^>]*>/gi, use: 'class="ds-input" (ds-sm in dense rows), see DESIGN.md · Inputs' },
  { re: /<[a-z]+\b[^>]*class(Name)?=["'][^"']*\b[\w-]*card\b(?![\w-])[^"']*["'](?![^>]*\bds-card)[^>]*>/gi, use: 'class="ds-card" (ds-card-nested inside a card), see DESIGN.md · Card padding' },
  { re: /<[a-z]+\b[^>]*class(Name)?=["'][^"']*\b[\w-]*(badge|pill|chip|tag)\b(?![\w-])[^"']*["'](?![^>]*\bds-)[^>]*>/gi, use: '<Badge>, <LayerBadge>, <Count> or <ContextGraphChip>, see DESIGN.md · Labels' },
  { re: /<(?:div|section)\b[^>]*\b(role=["']dialog["']|class(Name)?=["'][^"']*\b[\w-]*(modal|dialog)(-box)?(?![\w-]))(?![^>]*\bds-overlay\b)[^>]*>/gi, use: 'class="ds-overlay", see DESIGN.md · Layout and overlays' },
];

function checkMarkup(text, lineOf, keepLine) {
  const out = [];
  for (const rule of COMPONENT_RULES) {
    for (const m of text.matchAll(rule.re)) {
      if (/^<Button\b/.test(m[0])) continue;
      const line = lineOf(m.index);
      if (!keepLine(line)) continue;
      out.push({ line, kind: 'component', value: m[0].slice(0, 60), use: rule.use, offScale: true });
    }
  }
  return out;
}

// ── Files ───────────────────────────────────────────────────────────────────

function stripComments(css) { return css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')); }

const camelToKebab = (s) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** Every declaration in a file with its line: CSS, <style> blocks, style="" and style={{}}. */
export function declarations(text, ext) {
  const lineAt = lineIndex(text);
  const out = [];
  const add = (prop, value, index) => out.push({ prop, value, line: lineAt(index) });
  const cssIn = (css, offset) => {
    for (const m of stripComments(css).matchAll(/(?<![\w-])(--[\w-]+|[a-z-]+)\s*:\s*([^;{}]+?)\s*(?=;|}|$)/gm)) {
      if (/^(https?|data)$/.test(m[1])) continue;
      add(m[1], m[2], offset + m.index);
    }
  };
  if (ext === '.css') { cssIn(text, 0); return out; }
  for (const m of text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) cssIn(m[1], m.index + m[0].indexOf(m[1]));
  for (const m of text.matchAll(/\bstyle="([^"]*)"/g)) cssIn(m[1], m.index);
  for (const m of text.matchAll(/\bstyle=\{\{([\s\S]*?)\}\}/g)) {
    for (const d of m[1].matchAll(/['"]?([\w-]+)['"]?\s*:\s*(['"`])([^'"`]*)\2/g)) add(camelToKebab(d[1]), d[3], m.index + d.index);
    for (const d of m[1].matchAll(/\b(fontSize|borderRadius|padding|margin|gap|zIndex|fontWeight|lineHeight)\s*:\s*(\d*\.?\d+)\b/g)) {
      const unitless = ['zIndex', 'fontWeight', 'lineHeight'].includes(d[1]);
      add(camelToKebab(d[1]), unitless ? d[2] : `${d[2]}px`, m.index + d.index);
    }
  }
  return out;
}

function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return (index) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= index) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
}

/** Files the rules skip: the tokens themselves, canvas palettes (graph-viz can't read CSS variables) and the reference page. */
const skipFile = (file) => /00-theme\.css$|-colors\.ts$|design-system[\w-]*\.(tsx|html)$/.test(file.replace(/\\/g, '/'));

export function checkText(system, text, file, { known, mockup = false, keepLine = () => true } = {}) {
  const ext = extname(file).toLowerCase();
  const findings = [];
  for (const d of declarations(text, ext)) {
    if (!keepLine(d.line)) continue;
    for (const f of checkDeclaration(system, d.prop, d.value, { known, mockup })) findings.push({ line: d.line, prop: d.prop, ...f });
  }
  // In shipped code, test/ds-classes.test.ts and test/button-classes.test.ts already check
  // components with the context they need. A mock-up has no such tests, so it gets the hints here.
  if (mockup && ext !== '.css') findings.push(...checkMarkup(text, lineIndex(text), keepLine));
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
        for (const f of r.findings) console.log(`  ${String(f.line).padStart(4)}  ${f.kind.padEnd(10)} ${(f.prop ? `${f.prop}: ` : '') + f.value}\n        → ${f.use}`);
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
