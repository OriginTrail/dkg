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
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PKG, UI, buildSystem, checkText, inUi, isExempt, readTokens, runtimeProps, walk } from './design-core.mjs';

// The checks themselves are in design-core.mjs; this is the command line around them.
export * from './design-core.mjs';

const EXTENSIONS = new Set(['.css', '.html', '.htm', '.tsx', '.jsx']);

/** Lines each file adds against `base`, from git. */
function changedLines(base) {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: PKG, encoding: 'utf8' }).trim();
  // Headers the parser below can rely on, whatever the user's git config says: a/ and b/
  // prefixes (diff.noprefix, diff.mnemonicPrefix), paths from the repository root
  // (diff.relative), unquoted paths (core.quotePath), and no external diff tools.
  const diff = execFileSync('git', [
    '-c', 'core.quotePath=false',
    'diff', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--no-relative', '--src-prefix=a/', '--dst-prefix=b/',
    '--merge-base', base, '--', relative(root, UI),
  ], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
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
  // Untracked files count in full. -z keeps each name as it is: without it git quotes and
  // escapes names with non-ASCII or special characters (`"caf\303\251.css"`).
  const untracked = execFileSync('git', ['ls-files', '-z', '--others', '--exclude-standard', '--', UI], { cwd: PKG, encoding: 'utf8' })
    .split('\0').filter(Boolean).map((f) => join(PKG, f));
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
  // Variables the UI sets at runtime, read only when a UI file is checked: a mock-up has its own.
  /** @type {Set<string> | undefined} */
  let uiVariables;
  const known = () => (uiVariables ??= runtimeProps());

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
    if (!EXTENSIONS.has(extname(file).toLowerCase()) || isExempt(file) || !existsSync(file)) continue;
    const isMockup = !inUi(file);
    const text = readFileSync(file, 'utf8');
    const findings = checkText(system, text, file, {
      // A mock-up's own variables are found by checkText; the UI also sets some at runtime.
      known: isMockup ? undefined : known(),
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
    // What fails first: values not written as the system's tokens. Then heights that match a token, which may be layout.
    for (const [title, pick] of [['Not on the design system', (f) => f.offScale], ['Heights that match a token (use it if this is a control, badge or row)', (f) => !f.offScale]]) {
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
    if (named.n) console.log(`design-check: ${named.n} height${named.n === 1 ? '' : 's'} matching a token, to use if it's a control, badge or row (${named.text}).`);
    if (off.n) {
      console.log(`design-check: ${off.n} value${off.n === 1 ? '' : 's'} not on the design system (${off.text}).`);
      console.log('Each one names the token to use. A value no token has is either a mistake (use the nearest) or a new rule. For a new rule, in the same PR:');
      console.log('  1. add the token to src/ui/styles/00-theme.css (colours: a value for both themes) or the component to src/ui/components/ds/');
      console.log('  2. describe its job in DESIGN.md');
      console.log('  3. show it on the reference page (ui/design-system.html)');
    }
  }
  // Only values off the system fail: a number that is on the scale is allowed in code today.
  process.exit(off.n && !noFail ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
