// @ts-check
// The design check itself, without its command line (scripts/design-check.mjs): the
// system read from 00-theme.css, and the checks of one declaration, of markup and of a
// whole file. Typed end to end with the rule, suggestion, CSS and JSX modules, and
// checked by tsc (tsconfig.type-tests.json), so a change on one side of a contract
// shows up on the other.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NAMED_COLOURS, parseColour } from './colour.mjs';
import { CssReadError, cssDeclarations } from './css.mjs';
import { classify, declarations, lineIndex, resolveVars } from './design-rules.mjs';
import { literalWords, parseValue, varRefs, walkValue } from './css-value.mjs';
import { readHtml } from './html.mjs';
import { ADD, suggest } from './design-suggest.mjs';
import { attrText, attrsOf, classNames, customPropertyNames, opening, parseTsx, tagName, walkJsx } from './jsx.mjs';

export { declarations, parseColour };

/** @typedef {import('./design-suggest.mjs').Scales} Scales */
/** @typedef {import('./design-suggest.mjs').Finding} Finding */
/** @typedef {import('./design-suggest.mjs').Step} Step */

/**
 * The tokens in 00-theme.css.
 * @typedef {object} TokenInventory
 * @property {Map<string, string>} byName        each token's first value (the dark one, where a theme redefines it)
 * @property {Array<[string, string]>} allValues every definition in every theme, in file order
 */
/** A colour token, in each theme it has a value for. @typedef {{ name: string, rgb: [number, number, number], alpha: number, text: string }} ColourToken */
/**
 * Everything a check compares against: the scales suggestions pick from, plus the tokens
 * by name, every value each has in any theme, the shadow tokens and the colour tokens.
 * @typedef {Scales & { tokens: Map<string, string>, themeValues: Map<string, Set<string>>, shadows: string[], colours: ColourToken[] }} DesignSystem
 */
/**
 * @typedef {object} CheckOptions
 * @property {Set<string>} [known] variables that are fine to read though they aren't tokens (set at runtime, or a mock-up's own)
 * @property {boolean} [mockup]    a design not yet built: its own variables and components are checked too
 */
/** @typedef {CheckOptions & { keepLine?: (line: number) => boolean }} TextOptions only lines `keepLine` keeps are checked (--changed) */
/** A finding where it is in a file. `written` is the value as written, when a variable was put in. @typedef {Finding & { line: number, prop?: string, written?: string }} Reported */

// DESIGN_CHECK_PKG points the check at another copy of the package: the tests use it
// to run --changed against a git repository of their own.
export const PKG = process.env.DESIGN_CHECK_PKG ? resolve(process.env.DESIGN_CHECK_PKG) : resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const UI = join(PKG, 'src/ui');
export const THEME = join(UI, 'styles/00-theme.css');

/**
 * The package's own files the rules don't apply to: the tokens themselves (00-theme.css),
 * canvas palettes under src/ui (graph-viz can't read CSS variables) and the reference
 * page (src/ui/design-system*.tsx and .html). Matched by where they are, so a mock-up
 * elsewhere that happens to share a name is still checked.
 * @param {string} file
 * @returns {boolean}
 */
export function isExempt(file) {
  const path = uiPath(file);
  if (path === null) return false;
  return path === 'styles/00-theme.css' || /(^|\/)[\w-]+-colors\.ts$/.test(path) || /^design-system[\w-]*\.(tsx|html)$/.test(path);
}

/**
 * Where a file is inside src/ui, with forward slashes, or null when it isn't in it.
 * A directory boundary counts, so src/ui-mockups is outside src/ui.
 * @param {string} file
 * @returns {string | null}
 */
function uiPath(file) {
  const rel = relative(UI, resolve(file));
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.replace(/\\/g, '/');
}

/** Whether a file is shipped node UI code (under src/ui); anything else is a mock-up. @param {string} file @returns {boolean} */
export const inUi = (file) => uiPath(file) !== null;

// ── The system ──────────────────────────────────────────────────────────────

/** Tokens from 00-theme.css, read with the CSS parser. @param {string} [css] @returns {TokenInventory} */
export function readTokens(css = readFileSync(THEME, 'utf8')) {
  /** @type {Map<string, string>} */
  const byName = new Map();
  /** @type {Array<[string, string]>} */
  const allValues = [];
  for (const d of cssDeclarations(css)) {
    if (!d.prop.startsWith('--')) continue;
    const value = d.value.trim();
    if (!byName.has(d.prop)) byName.set(d.prop, value);
    allValues.push([d.prop, value]);
  }
  return { byName, allValues };
}

/** The system the rules check against. @param {TokenInventory} inventory @returns {DesignSystem} */
export function buildSystem(inventory) {
  const { byName, allValues } = inventory ?? {};
  if (!(byName instanceof Map) || !Array.isArray(allValues)) throw new TypeError('buildSystem takes the { byName, allValues } that readTokens returns');
  const tokens = byName;
  /** @param {string} prefix @param {(v: string) => number} read @param {(v: string) => boolean} [ok] @returns {Step[]} */
  const scale = (prefix, read, ok = () => true) => [...tokens].filter(([n, v]) => n.startsWith(prefix) && ok(v)).map(([name, v]) => ({ name, value: read(v) }));
  /** @param {string} prefix */
  const px = (prefix) => scale(prefix, (v) => parseInt(v, 10), (v) => /^\d+px$/.test(v));
  /** @type {Map<string, Set<string>>} */
  const themeValues = new Map();
  /** @type {ColourToken[]} */
  const colours = [];
  for (const [name, v] of allValues) {
    if (!themeValues.has(name)) themeValues.set(name, new Set());
    themeValues.get(name)?.add(v);
    // Colours match against every theme's value, so a colour can match its dark or its light one.
    const c = parseColour(v);
    if (c && !/^--(data|log)-/.test(name)) colours.push({ name, rgb: c.rgb, alpha: c.alpha, text: v });
  }
  return {
    tokens,
    themeValues,
    radius: px('--radius-').filter((t) => t.name !== '--radius-pill'),
    space: px('--space-'),
    fontSize: px('--fs-'),
    height: [...px('--h-'), ...px('--header-h'), ...px('--tab-h')],
    lineHeight: scale('--lh-', Number),
    z: scale('--z-', Number),
    motion: scale('--motion-', (v) => parseFloat(v) * 1000),
    shadows: [...tokens.keys()].filter((n) => n.startsWith('--shadow-')),
    colours,
  };
}

/** Every file under a directory, outside node_modules, dist and dot folders. @param {string} dir @returns {string[]} */
export function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) return [];
    return e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)];
  });
}

/**
 * Custom properties the UI defines, which are fine to read though they aren't tokens:
 * those its stylesheets declare (read by css.mjs) and those its code sets at runtime
 * (--cg-color and the like, read by jsx.mjs), whatever their values.
 * @param {string} [ui] @returns {Set<string>}
 */
export function runtimeProps(ui = UI) {
  /** @type {Set<string>} */
  const names = new Set();
  for (const file of walk(ui)) {
    if (file.endsWith('.css')) {
      // A stylesheet that can't be read is reported where it's checked itself (checkText),
      // with its line; it doesn't stop every other check from running.
      let decls;
      try {
        decls = cssDeclarations(readFileSync(file, 'utf8'));
      } catch (error) {
        if (error instanceof CssReadError) continue;
        throw error;
      }
      for (const d of decls) if (d.prop.startsWith('--')) names.add(d.prop);
    } else if (/\.tsx?$/.test(file) && !file.endsWith('.d.ts')) {
      for (const name of customPropertyNames(readFileSync(file, 'utf8'), file)) names.add(name);
    }
  }
  return names;
}

// ── Colours ─────────────────────────────────────────────────────────────────

/** Properties a named colour can be in. Elsewhere a word like `tan` or `red` is a name, not a colour. */
const COLOUR_PROPS = /^(--.+|color|background(-color|-image)?|border(-(top|right|bottom|left|block|inline)(-(start|end))?)?(-color)?|outline(-color)?|box-shadow|text-shadow|fill|stroke|caret-color|accent-color|text-decoration(-color)?|text-emphasis(-color)?|column-rule(-color)?|stop-color|flood-color|lighting-color|scrollbar-color)$/;

/** Colour functions (CSS Color 4): what's inside one is the colour, not more colours. */
const COLOUR_FUNCTIONS = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'device-cmyk']);

/**
 * The colours in a value, as written, wherever they are: on their own, in a gradient,
 * a shadow, a color-mix() or a var() fallback. Strings and url() are text, so
 * `content: "#ff00ff"` and `url(#mask)` aren't colours.
 * @param {string} prop
 * @param {string} value
 * @param {import('./css-value.mjs').ValueNode[]} [nodes] the value already read by parseValue
 * @returns {string[]}
 */
export function colourTokens(prop, value, nodes = parseValue(value)) {
  const named = COLOUR_PROPS.test(prop.toLowerCase());
  /** @type {string[]} */
  const found = [];
  walkValue(nodes, (n) => {
    if (n.type === 'function') {
      if (n.value === 'url') return false;
      if (COLOUR_FUNCTIONS.has(n.value)) { found.push(value.slice(n.start, n.end)); return false; }
      return true;
    }
    if (n.type !== 'word') return true;
    if (/^#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})$/i.test(n.value)) found.push(n.value);
    else if (named && NAMED_COLOURS.has(n.value.toLowerCase())) found.push(n.value);
    return true;
  });
  return found;
}

/** CIE76 distance in Lab: under ~2 reads as the same colour, under ~10 as a close one. @param {number[]} a @param {number[]} b @returns {number} */
export function colourDistance(a, b) {
  /** @param {number[]} rgb */
  const lab = (rgb) => {
    const [r, g, bl] = rgb.map((c) => { const v = c / 255; return v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92; });
    const x = (r * 0.4124 + g * 0.3576 + bl * 0.1805) / 0.95047;
    const y = r * 0.2126 + g * 0.7152 + bl * 0.0722;
    const z = (r * 0.0193 + g * 0.1192 + bl * 0.9505) / 1.08883;
    /** @param {number} t */
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
  };
  const [p, q] = [lab(a), lab(b)];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/** @typedef {'fill' | 'text' | 'border'} Role */
/** @type {Record<Role, RegExp>} */
const ROLES = {
  fill: /^--(bg-|surface|tint-)|-bg(-strong)?$/,
  text: /^--text-|-text$/,
  border: /border/,
};

/** What a colour is for, from the property or, for a mock-up's own variable, from its name. @param {string} prop @returns {Role | null} */
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

/** @param {DesignSystem} system @param {string} prop @param {string} text @returns {Finding | null} */
function checkColour(system, prop, text) {
  const c = parseColour(text);
  // A colour in a format this can't read (lab(), oklch(), color(display-p3 …)) can't be
  // compared with the tokens, so it can't pass as one.
  if (!c) return { kind: 'colour', value: text, use: `this colour format can't be compared with the tokens: use a token (var(--…)), or write it as hex, rgb(), hsl() or hwb() to see the nearest, ${ADD}`, offScale: true };
  // Opacity counts: a 10% white wash isn't an opaque white token.
  /** @param {ColourToken} t */
  const score = (t) => colourDistance(c.rgb, t.rgb) + Math.abs(c.alpha - t.alpha) * 100;
  /** @param {ColourToken[]} list @returns {{ t: ColourToken, d: number } | null} */
  const pick = (list) => {
    /** @type {{ t: ColourToken, d: number } | null} */
    let best = null;
    for (const t of list) { const d = score(t); if (!best || d < best.d) best = { t, d }; }
    return best;
  };
  // A colour that is a token's value is on the system, whatever the token's job; among
  // exact matches, the one with the same job (a fill for a fill, text for text) is named.
  // Only for a colour that isn't one does the job decide which close token to suggest.
  const role = colourRole(prop);
  const inRole = role ? pick(system.colours.filter((t) => ROLES[role].test(t.name))) : null;
  const anywhere = pick(system.colours);
  /** @param {{ d: number } | null} m */
  const isExact = (m) => m !== null && m.d < 2;
  const best = isExact(inRole) ? inRole : isExact(anywhere) ? anywhere : inRole && inRole.d < 10 ? inRole : anywhere;
  const exact = isExact(best);
  let use;
  if (best && exact && inRole && best !== inRole && inRole.d < 10) {
    // On the system, but as another job's token: name it, and the one meant for this job.
    use = `var(${best.t.name}) has this value; for this job, var(${inRole.t.name}) (${inRole.t.text}) is the token meant for it`;
  } else if (best && exact) use = `var(${best.t.name})`;
  else if (best && best.d < 10) use = `nearest is var(${best.t.name}) (${best.t.text}), ${ADD}`;
  else if (c.alpha < 1) {
    // A wash: keep the opacity on a token of the same colour, if there is one.
    const base = pick(system.colours.filter((t) => t.alpha === 1).map((t) => ({ ...t, alpha: c.alpha })));
    const pct = Math.round(c.alpha * 100);
    use = base && base.d < 2
      ? `a ${pct}% wash of var(${base.t.name}): use a tint token (--tint-*, --*-bg) if one fits, or color-mix(in srgb, var(${base.t.name}) ${pct}%, transparent)`
      : `no token is close. For a wash, use a tint token (--tint-*, --*-bg) or color-mix() on a token, ${ADD}`;
  } else use = 'no token is close. If the colour has a job of its own, add a token with a value for both themes; if it only needs to stand out, use contrast and weight (DESIGN.md · Principles 2)';
  return { kind: 'colour', value: text, use, offScale: !exact };
}

// ── One declaration ─────────────────────────────────────────────────────────
// Colours and unknown tokens are checked here; literal values go through classify()
// (design-rules.mjs) and suggest() (design-suggest.mjs).

/**
 * What the system says about one declaration.
 * @param {DesignSystem} system
 * @param {string} prop
 * @param {string} value
 * @param {CheckOptions} [options]
 * @returns {Finding[]}
 */
export function checkDeclaration(system, prop, value, { known, mockup = false } = {}) {
  /** @type {Finding[]} */
  const out = [];
  const p = prop.toLowerCase();
  const v = value.replace(/!important/, '').trim();
  // The value is read once (css-value.mjs); every check below walks the same tree.
  const nodes = parseValue(v);

  // Colour, wherever it appears, custom-property definitions included: a mock-up's own
  // `--surface: #141414` says which node UI token it stands for, and the UI's own
  // `--card-bg: magenta` fails like `background: magenta`. A token's definition is the
  // system itself (00-theme.css isn't checked); a redefinition of one anywhere else is
  // reported by checkText.
  if (!p.startsWith('--') || !system.tokens.has(p)) {
    for (const text of colourTokens(p, v, nodes)) {
      const f = checkColour(system, p, text);
      if (f) out.push(f);
    }
  }
  // Tokens that don't exist (a mock-up's own variables, or a typo).
  // A var() in a string or url() is text, so it reads nothing (css-value.mjs · varRefs).
  for (const { name } of varRefs(nodes)) {
    if (!system.tokens.has(name) && !known?.has(name)) {
      out.push({ kind: 'token', value: name, use: 'not a node UI token: use one from 00-theme.css (see the reference page), or add it there and to DESIGN.md', offScale: true });
    }
  }
  // Literal values. A token in the same declaration doesn't excuse the literals beside it.
  for (const hit of classify(p, v, nodes)) {
    const finding = suggest(system, hit);
    if (finding) out.push(finding);
  }
  if (p === 'box-shadow' && mockup && literalWords(nodes).some((w) => /\d+px$/i.test(w)) && !/^inset\b/.test(v)) {
    out.push({ kind: 'shadow', value: v.slice(0, 40), use: `one shadow per kind of surface: ${system.shadows.map((s) => `var(${s})`).join(', ')}`, offScale: true });
  }
  return out;
}

// ── Markup ──────────────────────────────────────────────────────────────────
// Components a mock-up rebuilds that the system already has. Each rule reads the whole
// opening tag, so a tag that already has the shared class passes.

/**
 * An element as the component rules see it, from HTML or from JSX: its tag name, where
 * it starts, its classes and its attributes (a string, '' when bare, null when set at
 * runtime). `source` is how it's written, for the report.
 * @typedef {{ name: string, source: string, index: number, classes: string[], attrs: Map<string, string | null> }} Tag
 */

/** A class named for the thing (card, stat-card), not one that only starts with it (card-body). @param {string[]} classes @param {string} words */
const endsWith = (classes, words) => classes.some((c) => new RegExp(`(${words})$`).test(c));

// The base class each shared component renders. Only that class makes an element the
// component: another ds-* class (ds-btn on a tag) or a part of one (ds-card-header) doesn't.
/** The card classes (DESIGN.md · Card padding). */
const CARD_BASES = new Set(['ds-card', 'ds-card-nested']);
/** <Badge> and <LayerBadge>, <Count> and <ContextGraphChip> (components/ds/Badge.tsx, ContextGraphChip.tsx). */
const LABEL_BASES = new Set(['ds-badge', 'ds-count', 'ds-entity-chip']);

/** @type {{ flags: (t: Tag) => boolean, use: string }[]} */
const COMPONENT_RULES = [
  {
    flags: (t) => t.name === 'button' && !t.classes.some((c) => /^ds-(btn|tab|seg-item|filter)$/.test(c)),
    use: '<Button> (or class="ds-btn"), see DESIGN.md · Button',
  },
  {
    flags: (t) => /^(input|select|textarea)$/.test(t.name) && !/^(checkbox|radio|hidden|file|range)$/i.test(t.attrs.get('type') ?? '') && !t.classes.includes('ds-input'),
    use: 'class="ds-input" (ds-sm in dense rows), see DESIGN.md · Inputs',
  },
  {
    flags: (t) => endsWith(t.classes, 'card') && !t.classes.some((c) => CARD_BASES.has(c)),
    use: 'class="ds-card" (ds-card-nested inside a card), see DESIGN.md · Card padding',
  },
  {
    flags: (t) => endsWith(t.classes, 'badge|pill|chip|tag') && !t.classes.some((c) => LABEL_BASES.has(c)),
    use: '<Badge>, <LayerBadge>, <Count> or <ContextGraphChip>, see DESIGN.md · Labels',
  },
  {
    flags: (t) => /^(div|section)$/.test(t.name) && (t.attrs.get('role') === 'dialog' || t.classes.some((c) => /(modal|dialog)(-box)?$/.test(c))) && !t.classes.includes('ds-overlay'),
    use: 'class="ds-overlay", see DESIGN.md · Layout and overlays',
  },
];

/** HTML opening tags, from the same reader the declaration check uses (scripts/html.mjs). @param {string} html @returns {Tag[]} */
function htmlTags(html) {
  return readHtml(html).tags.map((t) => {
    /** @type {Map<string, string | null>} */
    const attrs = new Map([...t.attrs].map(([k, a]) => [k, a.value]));
    return { name: t.name, source: t.source, index: t.index, classes: (attrs.get('class') ?? '').split(/\s+/).filter(Boolean), attrs };
  });
}

/** JSX elements, read with the shared parser (scripts/jsx.mjs). A capitalised component (<Button>) is a system part already. @param {string} text @param {string} ext @returns {Tag[]} */
function jsxTags(text, ext) {
  const tree = parseTsx(text, `inline${ext}`);
  /** @type {Tag[]} */
  const out = [];
  walkJsx(tree, (node) => {
    const name = tagName(node);
    if (!/^[a-z]/.test(name)) return;
    /** @type {Map<string, string | null>} */
    const attrs = new Map();
    for (const [key, attr] of attrsOf(node)) attrs.set(key, attrText(attr));
    const index = node.getStart(tree);
    out.push({ name, source: opening(node).getText(tree), index, classes: classNames(node), attrs });
  });
  return out;
}

/** @param {string} text @param {string} ext @param {(line: number) => boolean} keepLine @returns {Reported[]} */
function checkMarkup(text, ext, keepLine) {
  const lineOf = lineIndex(text);
  /** @type {Reported[]} */
  const out = [];
  const tags = ext === '.tsx' || ext === '.jsx' ? jsxTags(text, ext) : htmlTags(text);
  for (const tag of tags) {
    for (const rule of COMPONENT_RULES) {
      if (!rule.flags(tag)) continue;
      const line = lineOf(tag.index);
      if (keepLine(line)) out.push({ line, kind: 'component', value: tag.source.slice(0, 60), use: rule.use, offScale: true });
    }
  }
  return out;
}

// ── A file ──────────────────────────────────────────────────────────────────

/**
 * Everything off the design system in one file, with its line.
 * @param {DesignSystem} system
 * @param {string} text
 * @param {string} file its name, for its extension
 * @param {TextOptions} [options]
 * @returns {Reported[]}
 */
export function checkText(system, text, file, { known, mockup = false, keepLine = () => true } = {}) {
  const ext = extname(file).toLowerCase();
  /** @type {Reported[]} */
  const findings = [];
  let decls;
  try {
    decls = declarations(text, ext);
  } catch (error) {
    if (!(error instanceof CssReadError)) throw error;
    // CSS the parser can't read can't be checked: say where, so it gets fixed first. The
    // parser may point at an unchanged line (an unclosed block is reported where it opens),
    // so with --changed any edit to the file reports it.
    const line = lineIndex(text)(error.index);
    const lines = text.split('\n').length;
    let edited = false;
    for (let l = 1; l <= lines && !edited; l++) edited = keepLine(l);
    return edited ? [{ line, kind: 'css', value: error.reason, use: `${error.message}. Fix it so the design can be checked`, offScale: true }] : [];
  }
  // A mock-up's own variables (`--gap: 10px`) are checked where they're used, against the
  // scale of the property that uses them: `gap: var(--gap)` is a gap of 10px. Every
  // definition is kept with its scope, so a rule's own definition applies inside it. A
  // mock-up that redefines a node UI token is checked with its own value too, and a
  // redefinition anywhere is reported below.
  // A mock-up may read the variables it defines; their definitions are what get checked.
  // Names the caller passes in are for variables defined somewhere else (at runtime).
  const knownHere = mockup ? new Set([...(known ?? []), ...decls.filter((d) => d.prop.startsWith('--')).map((d) => d.prop)]) : known;
  /** @type {Map<string, { value: string, scope: number }[]>} */
  const defs = new Map();
  if (mockup) {
    for (const d of decls) {
      if (!d.prop.startsWith('--')) continue;
      // A copy of a token at its own value changes nothing: keep reading it as the token.
      if (system.themeValues.get(d.prop)?.has(d.value.trim())) continue;
      const list = defs.get(d.prop) ?? [];
      list.push({ value: d.value, scope: d.scope });
      defs.set(d.prop, list);
    }
  }
  for (const d of decls) {
    // A declaration counts as changed when any line it spans is: `padding:\n  10px;` with only the value edited.
    let changed = false;
    for (let l = d.line; l <= d.endLine && !changed; l++) changed = keepLine(l);
    if (!changed) continue;
    // A token set to a value it doesn't have in 00-theme.css, in a mock-up or in the UI's own
    // stylesheets: `.x { --bg-surface: magenta }` changes the system outside the system.
    // (00-theme.css itself is never checked.)
    const themed = system.themeValues.get(d.prop);
    if (themed && !themed.has(d.value.trim())) {
      findings.push({
        line: d.line, prop: d.prop, kind: 'token', value: d.value, offScale: true,
        use: `redefines var(${d.prop}), which is ${[...themed].join(' or ')} in 00-theme.css: use the token as it is, or change it in 00-theme.css and DESIGN.md`,
      });
    }
    // With several possible definitions, each value it could have is checked, once per finding.
    const values = defs.size && !d.prop.startsWith('--') ? resolveVars(d.value, defs, d.scope) : [d.value];
    /** @type {Set<string>} */
    const seen = new Set();
    for (const resolved of values) {
      for (const f of checkDeclaration(system, d.prop, resolved, { known: knownHere, mockup })) {
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
  if (mockup && ext !== '.css') findings.push(...checkMarkup(text, ext, keepLine));
  return findings.sort((a, b) => a.line - b.line);
}
