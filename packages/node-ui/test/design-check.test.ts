// The design check (DESIGN.md · Checking a new design: scripts/design-core.mjs, with its
// command line in scripts/design-check.mjs) reads the scale from 00-theme.css and says,
// for each value that isn't on it, which token to use or that the system needs a new
// one. These tests keep its suggestions right, and run it over the UI so a value off the
// system fails here with that suggestion attached.
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSystem, checkDeclaration, checkText, inUi, isExempt, parseColour, readTokens, runtimeProps } from '../scripts/design-core.mjs';
import { classify } from '../scripts/design-rules.mjs';
import { parseValue, varRefs } from '../scripts/css-value.mjs';
import { customPropertyNames } from '../scripts/jsx.mjs';
import { cssFiles, read, where } from './helpers/source.js';

const SCRIPT = join(__dirname, '../scripts/design-check.mjs');
const system = buildSystem(readTokens());
const use = (prop: string, value: string, mockup = false) => checkDeclaration(system, prop, value, { known: new Set(), mockup })
  .map((f: { use: string }) => f.use);

describe('design check', () => {
  it('names the token for a value on the scale', () => {
    expect(use('padding', '16px')).toEqual(['var(--space-16)']);
    expect(use('border-radius', '6px')).toEqual(['var(--radius-control)']);
    expect(use('font-size', '13px')).toEqual(['var(--fs-control)']);
    expect(use('color', '#ffffff')[0]).toMatch(/^var\(--text-/);
  });

  it('points a value off the scale at the nearest token, or at adding one', () => {
    const [gap] = use('gap', '10px');
    expect(gap).toMatch(/nearest is var\(--space-8\)/); // gaps and margins round down
    expect(gap).toMatch(/add a token/);
    expect(use('padding', '10px')[0]).toMatch(/nearest is var\(--space-12\)/); // padding rounds up
    expect(use('font-size', '15px')[0]).toMatch(/nearest is var\(--fs-(body|title)\)/);
    expect(use('background', '#ff00ff')[0]).toMatch(/no token is close/);
  });

  it('matches a colour to a token with the same job', () => {
    expect(use('background', '#111111')[0]).toMatch(/var\(--bg-/);
    expect(use('--surface', '#141414', true)[0]).toMatch(/var\(--bg-/);
    expect(use('--border', '#2a2a2a', true)[0]).toMatch(/var\(--border-/);
  });

  it('flags variables that are not node UI tokens', () => {
    expect(use('color', 'var(--muted)')[0]).toMatch(/not a node UI token/);
    expect(use('color', 'var(--text-primary)')).toEqual([]);
  });

  it('hints at components only in mock-ups', () => {
    const html = '<button class="btn">Save</button><span class="tag">VM</span><input type="text">';
    const kinds = (mockup: boolean) => checkText(system, html, 'mock.html', { known: new Set(), mockup })
      .map((f: { use: string }) => f.use.split(' ')[0]);
    expect(kinds(true).sort()).toEqual(['<Badge>,', '<Button>', 'class="ds-input"']);
    expect(kinds(false)).toEqual([]);
  });

  it('lets markup that already uses the shared class through', () => {
    const hints = (html: string) => checkText(system, html, 'mock.html', { known: new Set(), mockup: true }).length;
    expect(hints('<div class="ds-card">Content</div>')).toBe(0);
    expect(hints('<div class="stat ds-card wide">Content</div>')).toBe(0);
    expect(hints('<div class="card-body">Content</div>')).toBe(0); // part of a card, not one
    expect(hints('<div class="stat-card">Content</div>')).toBe(1);
    expect(hints('<span class="ds-badge tag">VM</span>')).toBe(0);
    expect(hints('<span class="tag">VM</span>')).toBe(1);
    expect(hints('<div class="modal ds-overlay"></div>')).toBe(0);
    expect(hints('<div role="dialog"></div>')).toBe(1);
  });

  it('keeps the opacity of a colour', () => {
    for (const wash of ['rgba(255, 255, 255, 0.1)', '#ffffff1a', 'rgb(255 255 255 / 10%)']) {
      const [f] = checkDeclaration(system, 'background', wash, { known: new Set() });
      expect(f.offScale, wash).toBe(true);
      expect(f.use, wash).toMatch(/10% wash|tint token/);
    }
    expect(use('background', 'rgba(255, 255, 255, 1)')[0]).not.toMatch(/wash/);
  });

  it('reads hues in every CSS angle unit, negative ones too', () => {
    const blue = parseColour('hsl(240 100% 50%)').rgb;
    expect(blue).toEqual([0, 0, 255]);
    for (const hue of ['-120', '240deg', '-120deg', '0.6666667turn', `${(4 * Math.PI) / 3}rad`, '266.6667grad', '600']) {
      expect(parseColour(`hsl(${hue} 100% 50%)`).rgb, hue).toEqual(blue);
    }
    expect(parseColour('hsl(0.5turn 100% 50%)').rgb).toEqual([0, 255, 255]);
    expect(parseColour('hsl(10vw 100% 50%)')).toBeNull();
  });

  it('checks the literals beside a token', () => {
    expect(use('padding', 'var(--space-4) 10px')[0]).toMatch(/nearest is var\(--space-12\)/);
    expect(use('transition', 'opacity var(--motion-fast), color 1s')[0]).toMatch(/nearest is var\(--motion-/);
    expect(use('margin', 'calc(-1 * var(--space-4))')).toEqual([]);
  });

  it('reads tokens from every theme, and looks them up by their first value', () => {
    const inventory = readTokens(':root { --bg-test: #101010; --space-test: 5px; } :root.light { --bg-test: #fafafa; }');
    expect(inventory.byName.get('--bg-test')).toBe('#101010');
    expect(inventory.allValues.filter(([n]: [string]) => n === '--bg-test')).toHaveLength(2);
    const two = buildSystem(inventory);
    expect(two.colours.filter((c: { name: string }) => c.name === '--bg-test')).toHaveLength(2);
    expect(checkDeclaration(two, 'background', '#fafafa', { known: new Set() })[0].use).toBe('var(--bg-test)');
    expect(() => buildSystem(new Map())).toThrow(TypeError);
  });

  // Each kind of file, with a value off the system on a known line, must be found there.
  it('finds values off the system in CSS, HTML and TSX', () => {
    const found = (text: string, file: string, mockup = false) => checkText(system, text, file, { known: new Set(), mockup })
      .filter((f: { offScale?: boolean }) => f.offScale)
      .map((f: { line: number; prop: string; value: string }) => `${f.line} ${f.prop} ${f.value}`);
    expect(found('.a {\n  color: var(--missing);\n  padding: 10px;\n}', 'x.css')).toEqual(['2 color --missing', '3 padding 10px']);
    expect(found('<style>\n.a { gap: 10px; }\n</style>', 'mock.html', true)).toEqual(['2 gap 10px']);
    expect(found('<div style="\n  padding: 10px;"></div>', 'mock.html', true)).toEqual(['2 padding 10px']);
    expect(found('<div style={{\n  fontSize: 15,\n}} />', 'x.tsx')).toEqual(['2 font-size 15px']);
    expect(found("<div style={{\n  padding: '10px',\n}} />", 'x.tsx')).toEqual(['2 padding 10px']);
  });

  it('keeps a changed line in a multi-line style when only that line is checked', () => {
    const text = '<div style={{\n  color: "var(--text-primary)",\n  fontSize: 15,\n}} />';
    expect(checkText(system, text, 'x.tsx', { known: new Set(), keepLine: (l: number) => l === 3 })).toHaveLength(1);
  });

  it('counts a declaration as changed when only its value line changed', () => {
    const only3 = { known: new Set(), keepLine: (l: number) => l === 3 };
    expect(checkText(system, '.a {\n  padding:\n    10px;\n}', 'x.css', only3)).toHaveLength(1);
    expect(checkText(system, '<div style={{\n  padding:\n    10,\n}} />', 'x.tsx', only3)).toHaveLength(1);
    expect(checkText(system, '.a {\n  padding: 10px;\n  color: var(--text-primary);\n}', 'x.css', only3)).toEqual([]);
  });

  it("checks a mock-up's own variables where they're used", () => {
    const found = (html: string) => checkText(system, html, 'mock.html', { known: new Set(['--gap', '--round', '--pad', '--inner']), mockup: true })
      .filter((f: { offScale?: boolean }) => f.offScale)
      .map((f: { prop: string; value: string; written?: string }) => `${f.prop} ${f.value} ${f.written}`);
    expect(found('<style>:root { --gap: 10px; --round: 7px; } .x { gap: var(--gap); border-radius: var(--round); }</style>'))
      .toEqual(['gap 10px var(--gap)', 'border-radius 7px var(--round)']);
    // Through a variable that refers to another, and beside a node UI token.
    expect(found('<style>:root { --inner: 10px; --pad: var(--inner); } .x { padding: var(--space-4) var(--pad); }</style>'))
      .toEqual(['padding 10px var(--space-4) var(--pad)']);
    expect(found('<style>:root { --gap: var(--space-8); } .x { gap: var(--gap); }</style>')).toEqual([]);
  });

  it('keeps a variable defined in a rule to that rule', () => {
    // Off the scale only, so which definition applied is what's tested (on-scale numbers fail too, as their token).
    const gaps = (css: string) => checkText(system, `<style>${css}</style>`, 'mock.html', { known: new Set(['--gap']), mockup: true })
      .filter((f: { offScale?: boolean; prop: string; use: string }) => f.offScale && f.prop === 'gap' && f.use.startsWith('nearest'))
      .map((f: { value: string }) => f.value);
    // .a reads the 10px from :root; .b defines its own 8px, which is on the scale.
    expect(gaps(':root { --gap: 10px; } .a { gap: var(--gap); } .b { --gap: 8px; gap: var(--gap); }')).toEqual(['10px']);
    // Whichever definition applies, a use with no definition of its own is checked against each.
    expect(gaps(':root { --gap: 8px; } .b { --gap: 10px; } .a { gap: var(--gap); }')).toEqual(['10px']);
    expect(gaps(':root { --gap: 8px; } .b { --gap: 12px; } .a { gap: var(--gap); }')).toEqual([]);
  });

  it('leaves commented-out HTML alone, and keeps lines after it', () => {
    const found = (html: string) => checkText(system, html, 'mock.html', { known: new Set(), mockup: true })
      .filter((f: { offScale?: boolean }) => f.offScale)
      .map((f: { line: number; kind: string }) => `${f.line} ${f.kind}`);
    expect(found('<!-- <button>Old button</button> -->')).toEqual([]);
    expect(found('<!--\n<div style="padding: 10px"></div>\n<style>.a { gap: 10px; }</style>\n-->')).toEqual([]);
    expect(found('<!-- old\n-->\n<button>New</button>\n<div style="padding: 10px"></div>')).toEqual(['3 component', '4 spacing']);
  });

  it('reads `<!--` in a script, a style or an attribute as text, not as a comment', () => {
    const found = (html: string) => checkText(system, html, 'mock.html', { known: new Set(), mockup: true })
      .filter((f: { offScale?: boolean }) => f.offScale)
      .map((f: { line: number; kind: string }) => `${f.line} ${f.kind}`);
    expect(found('<script>const marker = "<!--";</script>\n<button>Real</button>\n<!-- end -->')).toEqual(['2 component']);
    expect(found('<style>.a::before { content: "<!--"; } .a { gap: 10px; } .a::after { content: "-->"; }</style>')).toEqual(['1 spacing']);
    expect(found('<div title="<!--"></div>\n<div style="padding: 10px"></div>\n<p title="-->"></p>')).toEqual(['2 spacing']);
    // A real comment after them is still skipped.
    expect(found('<script>"<!--"</script>\n<!-- <button>Old</button> -->\n<div style="padding: 10px"></div>')).toEqual(['3 spacing']);
  });

  it('fails every colour written as a literal, a token\'s own value too', () => {
    const off = (prop: string, value: string) => checkDeclaration(system, prop, value, { known: new Set() })
      .filter((f: { kind: string }) => f.kind === 'colour').map((f: { offScale?: boolean }) => Boolean(f.offScale));
    expect(off('color', '#ffffff')).toEqual([true]);
    expect(off('color', 'var(--text-primary)')).toEqual([]);
    expect(off('background', '#ff00ff')).toEqual([true]);
    expect(off('background', '#7a1f55')).toEqual([true]);
  });

  it("names a token for every token's own colour, whatever the property's job", () => {
    const tokenColours = system.colours.filter((t: { alpha: number; text: string }) => t.alpha === 1 && !/var\(/.test(t.text));
    expect(tokenColours.length).toBeGreaterThan(10);
    // Written as a literal it fails, but the fix is a token with exactly that value, never "nearest".
    const off = tokenColours.flatMap((t: { name: string; text: string }) => ['color', 'background', 'border-color'].flatMap((prop) => (
      checkDeclaration(system, prop, t.text, { known: new Set() })
        .filter((f: { kind: string; use: string }) => f.kind === 'colour' && !f.use.startsWith('var('))
        .map(() => `${prop}: ${t.text} (${t.name})`)
    )));
    expect(off).toEqual([]);
  });

  it('fails a colour in a format it cannot compare, instead of passing it', () => {
    const colour = (value: string) => checkDeclaration(system, 'color', value, { known: new Set() })
      .filter((f: { kind: string }) => f.kind === 'colour')
      .map((f: { offScale?: boolean; use: string }) => ({ offScale: f.offScale, cannot: /can't be compared/.test(f.use) }));
    expect(parseColour('hwb(300 0% 0%)').rgb).toEqual([255, 0, 255]);
    expect(colour('hwb(300 0% 0%)')).toEqual(colour('#ff00ff'));
    for (const unread of ['oklch(0.7 0.3 330)', 'lab(60 90 -60)', 'color(display-p3 1 0 1)']) {
      expect(colour(unread), unread).toEqual([{ offScale: true, cannot: true }]);
    }
  });

  it('reads colours in every CSS syntax, and leaves text and URLs alone', () => {
    const colours = (prop: string, value: string) => checkDeclaration(system, prop, value, { known: new Set() })
      .filter((f: { kind: string; offScale?: boolean }) => f.kind === 'colour' && f.offScale).map((f: { value: string }) => f.value);
    for (const magenta of ['#ff00ff', 'rgb(255 0 255)', 'hsl(300 100% 50%)', 'color(srgb 1 0 1)', 'magenta', 'Fuchsia']) {
      expect(colours('color', magenta), magenta).toEqual([magenta]);
    }
    expect(colours('background', 'linear-gradient(red, color-mix(in srgb, #ff00ff 40%, transparent))')).toEqual(['red', '#ff00ff']);
    expect(colours('box-shadow', '0 0 4px rgba(255, 0, 255, 0.5)')).toHaveLength(1);
    expect(colours('content', '"#ff00ff"')).toEqual([]);
    expect(colours('mask', 'url(#ff00ff)')).toEqual([]);
    expect(colours('background', 'url("img/red.png") no-repeat')).toEqual([]);
    expect(colours('grid-area', 'tan')).toEqual([]); // a name, not a colour
    expect(colours('font-family', 'Tan, sans-serif')).toEqual([]);
    expect(colours('color', 'transparent')).toEqual([]);
    expect(colours('color', 'currentColor')).toEqual([]);
  });

  it("knows a mock-up's own variables without being told", () => {
    const tokens = (css: string) => checkText(system, `<style>${css}</style>`, 'mock.html', { mockup: true })
      .filter((f: { kind: string }) => f.kind === 'token').map((f: { value: string }) => f.value);
    expect(tokens(':root { --gap: 8px; --pad: var(--gap); } .x { padding: var(--pad); }')).toEqual([]);
    expect(tokens('.x { padding: var(--nope); }')).toEqual(['--nope']);
  });

  it('reads JSX mock-ups with the TypeScript parser', () => {
    const hints = (tsx: string) => checkText(system, tsx, 'mock.tsx', { known: new Set(), mockup: true })
      .filter((f: { kind: string }) => f.kind === 'component').map((f: { line: number }) => f.line);
    expect(hints('<button onClick={() => save()} className="ds-btn">Save</button>')).toEqual([]);
    expect(hints('<button onClick={() => save()} className={cx("ds-btn", on && "is-on")}>Save</button>')).toEqual([]);
    expect(hints('const a = 1;\n<button onClick={() => save()} className="btn">Save</button>')).toEqual([2]);
    expect(hints('<Button onClick={() => save()}>Save</Button>')).toEqual([]);
    expect(hints('<input type="checkbox" /><input type={"text"} className="ds-input" />')).toEqual([]);
    expect(hints('<div role="dialog" className="ds-overlay" />')).toEqual([]);
  });

  it('keeps a JSX custom property number unitless, as React does', () => {
    const found = (tsx: string) => checkText(system, tsx, 'mock.tsx', { mockup: true })
      .filter((f: { offScale?: boolean }) => f.offScale)
      .map((f: { kind: string; prop?: string; value: string }) => `${f.kind} ${f.prop} ${f.value}`);
    expect(found("<div style={{ '--layer': 50, zIndex: 'var(--layer)' }} />")).toEqual(['layer z-index 50']);
    expect(found("<div style={{ '--layer': 5, zIndex: 'var(--layer)', padding: 10 }} />")).toEqual(['spacing padding 10px']);
  });

  it('reads tags and style attributes in one pass over the HTML', () => {
    const found = (html: string) => checkText(system, html, 'mock.html', { known: new Set(), mockup: true })
      .filter((f: { offScale?: boolean }) => f.offScale)
      .map((f: { line: number; kind: string }) => `${f.line} ${f.kind}`);
    expect(found('<button class="btn" style="padding: 10px">Save</button>')).toEqual(['1 spacing', '1 component']);
    expect(found('<div\n  title="a > b"\n  style="padding: 10px"></div>')).toEqual(['3 spacing']);
    expect(found('<div title="style=&quot;x&quot;" data-style="padding: 10px"></div>')).toEqual([]);
    expect(found('<style media="screen">\n.a { gap: 10px; }\n</style >')).toEqual(['2 spacing']);
  });

  it('needs the component\'s own shared class, not any ds- class', () => {
    const hints = (html: string) => checkText(system, html, 'mock.html', { known: new Set(), mockup: true })
      .filter((f: { kind: string }) => f.kind === 'component').length;
    expect(hints('<span class="tag ds-btn">VM</span>')).toBe(1); // a button class on a label
    expect(hints('<span class="tag ds-badge-dot">VM</span>')).toBe(1); // a part of a badge, not one
    expect(hints('<div class="stat-card ds-card-header">Content</div>')).toBe(1);
    expect(hints('<span class="tag ds-badge">VM</span>')).toBe(0);
    expect(hints('<span class="ds-count">3</span><span class="cg-chip ds-entity-chip">x</span>')).toBe(0);
    expect(hints('<div class="stat-card ds-card-nested">Content</div>')).toBe(0);
  });

  it('reads tag-shaped text in scripts, styles and text fields as text', () => {
    const found = (html: string) => checkText(system, html, 'mock.html', { known: new Set(), mockup: true })
      .filter((f: { offScale?: boolean }) => f.offScale)
      .map((f: { line: number; kind: string }) => `${f.line} ${f.kind}`);
    expect(found('<textarea class="ds-input"><button>Example</button></textarea>')).toEqual([]);
    expect(found('<script>const html = "<button class=\\"btn\\">x</button>";</script>')).toEqual([]);
    expect(found('<title><div class="card"></title>')).toEqual([]);
    // A style block's CSS is still read, and markup after it is still checked, at its own line.
    expect(found('<style>.x::before { content: "<button>"; gap: 10px; }</style>\n<button>Real</button>'))
      .toEqual(['1 spacing', '2 component']);
    expect(found('<script>"<div style=\'padding: 10px\'>"</script>\n<div style="padding: 10px"></div>')).toEqual(['2 spacing']);
  });

  it('decodes character references in attributes, as the browser does', () => {
    const found = (html: string) => checkText(system, html, 'mock.html', { known: new Set(), mockup: true })
      .filter((f: { offScale?: boolean }) => f.offScale)
      .map((f: { line: number; kind: string; value: string }) => `${f.line} ${f.kind} ${f.value}`);
    expect(found('<button class="ds&#45;btn">Save</button>')).toEqual([]);
    expect(found('<button class="ds&#x2D;btn">Save</button>')).toEqual(found('<button class="ds-btn">Save</button>'));
    expect(found('<div style="font-family: &quot;JetBrains Mono&quot;; padding: var(--space-8)"></div>')).toEqual([]);
    // Encoded and literal versions give the same findings, on the same lines.
    expect(found('<div style="padding:&#32;10px; color: &#35;ff00ff"></div>')).toEqual(found('<div style="padding: 10px; color: #ff00ff"></div>'));
    expect(found('<div style="font-family: &quot;A&quot;;\n  padding: 10px"></div>')).toEqual(['2 spacing 10px']);
    expect(found('<div title="&copy=x" class="tag"></div>')).toEqual(['1 component <div title="&copy=x" class="tag">']);
  });

  it("resolves a variable's own references where it is defined, as CSS does", () => {
    const pads = (css: string) => checkText(system, `<style>${css}</style>`, 'mock.html', { mockup: true })
      .filter((f: { offScale?: boolean; prop?: string; use: string }) => f.offScale && f.prop === 'padding' && f.use.startsWith('nearest'))
      .map((f: { value: string }) => f.value);
    // --pad is computed at :root, with :root's --gap, before .a's --gap applies.
    expect(pads(':root { --gap: 10px; --pad: var(--gap); } .a { --gap: 8px; padding: var(--pad); }')).toEqual(['10px']);
    expect(pads(':root { --gap: 8px; --pad: var(--gap); } .a { --gap: 10px; padding: var(--pad); }')).toEqual([]);
    // A loop between variables stops, and leaves the value as written.
    expect(() => pads(':root { --a: var(--b); --b: var(--a); } .x { padding: var(--a); }')).not.toThrow();
  });

  it('checks the colour a custom property is defined with, in the UI too', () => {
    const colours = (css: string) => checkText(system, css, 'x.css', { known: new Set(['--card-bg']) })
      .filter((f: { kind: string; offScale?: boolean }) => f.kind === 'colour' && f.offScale)
      .map((f: { prop?: string; value: string }) => `${f.prop} ${f.value}`);
    // Where it's defined, and where it's used (resolved as in a mock-up).
    expect(colours('.x { --card-bg: magenta; background: var(--card-bg); }')).toEqual(['--card-bg magenta', 'background magenta']);
    expect(colours('.x { --card-bg: var(--bg-surface); background: var(--card-bg); }')).toEqual([]);
    expect(colours('.x { --card-bg: #ffffff; }')).toEqual(['--card-bg #ffffff']); // a token's value, as a literal
  });

  it('fails lengths in other units, which the px scales cannot check', () => {
    const off = (css: string) => checkText(system, `<style>.a { ${css} }</style>`, 'mock.html', { known: new Set(), mockup: true })
      .filter((f: { offScale?: boolean }) => f.offScale).map((f: { kind: string; value: string }) => `${f.kind} ${f.value}`);
    const failing: [string, string[]][] = [
      ['padding: 0.625rem', ['spacing 0.625rem']],
      ['gap: 1em', ['spacing 1em']],
      ['margin: 0 2vw', ['spacing 2vw']],
      ['border-radius: 0.4375rem', ['corner 0.4375rem']],
      ['border-top-left-radius: 1ch', ['corner 1ch']],
      ['font-size: 2vw', ['type size 2vw']],
      ['font-size: 0.875rem', ['type size 0.875rem']],
      ['font-size: 120%', ['type size 120%']],
      ['font: 600 1.25rem/1.4 sans-serif', ['type size 1.25rem', 'line height 1.4']], // and its line height, off the scale
    ];
    for (const [css, expected] of failing) expect(off(css), css).toEqual(expected);
    // Documented exceptions: zero, % corners (circles) and spaces (layout), negative margins, 1em type, tokens.
    for (const css of ['padding: 0rem', 'border-radius: 50%', 'padding-top: 56.25%', 'margin: -0.5em', 'font-size: 1em', 'border-radius: var(--radius-card)', 'gap: var(--space-8)']) {
      expect(off(css), css).toEqual([]);
    }
  });

  it("fails a token redefined in the UI's own stylesheets, as in a mock-up", () => {
    const tokens = (css: string) => checkText(system, css, 'x.css', { known: new Set() })
      .filter((f: { kind: string; offScale?: boolean }) => f.kind === 'token' && f.offScale)
      .map((f: { prop?: string; value: string }) => `${f.prop} ${f.value}`);
    expect(tokens('.x { --bg-surface: magenta; background: var(--bg-surface); }')).toEqual(['--bg-surface magenta']);
    expect(tokens('.x { --space-8: 10px; }')).toEqual(['--space-8 10px']);
    expect(tokens('.x { background: var(--bg-surface); gap: var(--space-8); }')).toEqual([]);
  });

  it('checks the weight and line height in a font shorthand, as their own properties', () => {
    const kinds = (value: string) => classify('font', value).map((h: { kind: string; value: string }) => `${h.kind} ${h.value}`);
    expect(kinds('900 var(--fs-control)/1.9 var(--font-sans)')).toEqual(['weight 900', 'line height 1.9']);
    expect(kinds('600 var(--fs-control)/var(--lh-body) var(--font-sans)')).toEqual([]);
    expect(kinds('500 var(--fs-micro) var(--font-mono)')).toEqual([]);
    // A px line height isn't the size: swapping the size for its token leaves nothing to flag.
    expect(kinds('500 13px/20px var(--font-sans)')).toEqual(['type size 13px']);
    expect(kinds('500 var(--fs-control)/20px var(--font-sans)')).toEqual([]);
    expect(kinds('500 15px/20px var(--font-sans)')).toEqual(['type size 15px']);
    // A size written as a function is checked as font-size checks it.
    expect(kinds('600 calc(15px) sans-serif')).toEqual(['type size 15px']);
    expect(kinds('600 clamp(13px, 2vw, 15px)/1.9 sans-serif')).toEqual(['type size 13px', 'type size 15px', 'type size 2vw', 'line height 1.9']);
    expect(kinds('600 clamp(13px, 2vw, 15px) sans-serif')).toEqual(classify('font-size', 'clamp(13px, 2vw, 15px)').map((h: { kind: string; value: string }) => `${h.kind} ${h.value}`));
    expect(kinds('600 calc(var(--fs-control)) sans-serif')).toEqual([]);
    // Through a stylesheet, an off-scale functional size fails.
    const off = (css: string) => checkText(system, css, 'x.css').filter((f: { offScale?: boolean }) => f.offScale).map((f: { kind: string; value: string }) => `${f.kind} ${f.value}`);
    expect(off('.a { font: 600 calc(15px) sans-serif; }')).toEqual(['type size 15px']);
    expect(off('.a { font: 600 var(--fs-control)/var(--lh-body) sans-serif; }')).toEqual([]);
    expect(kinds('italic 300 13px/1 sans-serif')).toEqual(['type size 13px', 'weight 300']);
    expect(kinds('inherit')).toEqual([]);
  });

  it('treats a folder beside src/ui as mock-ups, not as the UI', () => {
    const ui = join(__dirname, '../src/ui');
    expect(inUi(join(ui, 'styles/27-ds-components.css'))).toBe(true);
    expect(inUi(join(ui, '../ui-mockups/mock.html'))).toBe(false);
    expect(inUi(join(tmpdir(), 'mock.html'))).toBe(false);
    // Through the CLI: a button drawn by hand in src/ui-mockups is a mock-up's component finding.
    const pkg = mkdtempSync(join(tmpdir(), 'design-check-pkg-'));
    try {
      mkdirSync(join(pkg, 'src/ui/styles'), { recursive: true });
      mkdirSync(join(pkg, 'src/ui-mockups'), { recursive: true });
      copyFileSync(join(ui, 'styles/00-theme.css'), join(pkg, 'src/ui/styles/00-theme.css'));
      const mock = join(pkg, 'src/ui-mockups/mock.html');
      writeFileSync(mock, '<button>Save</button>');
      const run = spawnSync(process.execPath, [SCRIPT, '--json', mock], { cwd: pkg, encoding: 'utf8', env: { ...process.env, DESIGN_CHECK_PKG: pkg } });
      expect(JSON.parse(run.stdout)[0].findings.map((f: { kind: string }) => f.kind)).toEqual(['component']);
      expect(run.status).toBe(1);
    } finally {
      rmSync(pkg, { recursive: true, force: true });
    }
  });

  it('still checks a var() fallback when the variable resolves', () => {
    const off = (css: string, file = 'src/ui/styles/x.css') => checkText(system, css, file, { known: new Set() })
      .filter((f: { offScale?: boolean }) => f.offScale).map((f: { kind: string; value: string }) => `${f.kind} ${f.value}`);
    expect(off('.x { --local: var(--text-primary); color: var(--local, #ff00ff); }')).toEqual(['colour #ff00ff']);
    expect(off('.x { --local: var(--space-8); gap: var(--local, var(--not-a-token)); }')).toEqual(['token --not-a-token']);
    // In a mock-up too.
    expect(off('<style>.x { --local: var(--text-primary); color: var(--local, #ff00ff); }</style>', 'mock.html')).toEqual(['colour #ff00ff']);
  });

  it('checks the uses of a changed variable definition, reported at the change', () => {
    const found = (css: string, changed: number[]) => checkText(system, css, 'src/ui/styles/x.css', { known: new Set(), keepLine: (l) => changed.includes(l) })
      .filter((f: { offScale?: boolean }) => f.offScale)
      .map((f: { line: number; prop?: string; value: string; usedAt?: number }) => `${f.line} ${f.prop} ${f.value} used ${f.usedAt}`);
    // Only --gap (line 2) changed; the gap on line 3 reads it.
    expect(found('.x {\n  --gap: 10px;\n  gap: var(--gap);\n}', [2])).toEqual(['2 gap 10px used 3']);
    // Through an alias: --pad reads --gap, padding reads --pad.
    expect(found('.x {\n  --gap: 10px;\n  --pad: var(--gap);\n  padding: var(--pad);\n}', [2])).toEqual(['2 padding 10px used 4']);
    // An on-system change, or no change, reports nothing.
    expect(found('.x {\n  --gap: var(--space-8);\n  gap: var(--gap);\n}', [2])).toEqual([]);
    expect(found('.x {\n  --gap: 10px;\n  gap: var(--gap);\n}', [])).toEqual([]);
  });

  it('checks a UI stylesheet\'s own variables where they are used', () => {
    const off = (css: string) => checkText(system, css, 'src/ui/styles/x.css', { known: new Set(['--gap', '--set-at-runtime']) })
      .filter((f: { offScale?: boolean }) => f.offScale).map((f: { kind: string; value: string }) => `${f.kind} ${f.value}`);
    // A size moved into a variable is still that size.
    expect(off('.x { --gap: 10px; gap: var(--gap); }')).toEqual(['spacing 10px']);
    // An alias of a token is the token; a variable set at runtime has nothing to check.
    expect(off('.x { --gap: var(--space-8); gap: var(--gap); }')).toEqual([]);
    expect(off('.x { gap: var(--set-at-runtime); }')).toEqual([]);
  });

  it('keeps checking when a UI stylesheet cannot be read, and reports that sheet itself', () => {
    const pkg = mkdtempSync(join(tmpdir(), 'design-check-broken-'));
    try {
      const styles = join(pkg, 'src/ui/styles');
      mkdirSync(styles, { recursive: true });
      copyFileSync(join(__dirname, '../src/ui/styles/00-theme.css'), join(styles, '00-theme.css'));
      writeFileSync(join(styles, 'broken.css'), '.ok { gap: var(--space-8); }\n.x { gap 10px; }\n');
      const mock = join(pkg, 'mock.html');
      writeFileSync(mock, '<style>.a { gap: var(--space-8); }</style>');
      const run = (target: string) => spawnSync(process.execPath, [SCRIPT, '--json', target], { cwd: pkg, encoding: 'utf8', env: { ...process.env, DESIGN_CHECK_PKG: pkg } });
      // An unrelated mock-up: a JSON report, and a pass.
      const clean = run(mock);
      expect(JSON.parse(clean.stdout)).toEqual([]);
      expect(clean.status).toBe(0);
      // The broken sheet itself, in the UI: a located CSS finding, and a fail.
      const broken = run(join(styles, 'broken.css'));
      expect(JSON.parse(broken.stdout)[0].findings.map((f: { line: number; kind: string }) => `${f.line} ${f.kind}`)).toEqual(['2 css']);
      expect(broken.status).toBe(1);
      expect(() => runtimeProps(join(pkg, 'src/ui'))).not.toThrow();
    } finally {
      rmSync(pkg, { recursive: true, force: true });
    }
  });

  it('classifies the words of a value read once, beside its tokens', () => {
    const kinds = (prop: string, value: string) => classify(prop, value, parseValue(value)).map((h: { kind: string; value: string }) => `${h.kind} ${h.value}`);
    expect(kinds('gap', 'var(--space-4) 10px')).toEqual(['spacing 10px']);
    expect(kinds('margin', 'calc(-1 * var(--space-4)) 12px')).toEqual(['spacing 12px']);
    expect(kinds('transition', 'opacity var(--motion-fast), color 1s')).toEqual(['motion 1s']);
    expect(kinds('border-radius', '999px')).toEqual(['corner 999px']);
    expect(kinds('font', '600 15px/1.4 "Inter 10px", sans-serif')).toEqual(['type size 15px', 'line height 1.4']); // text in quotes isn't a size
    expect(classify('gap', 'var(--space-4) 10px')).toEqual(classify('gap', 'var(--space-4) 10px', parseValue('var(--space-4) 10px')));
  });

  it("skips only the package's own theme, palettes and reference page", () => {
    const ui = join(__dirname, '../src/ui');
    expect(isExempt(join(ui, 'styles/00-theme.css'))).toBe(true);
    expect(isExempt(join(ui, 'layer-colors.ts'))).toBe(true);
    expect(isExempt(join(ui, 'views/schema-type-colors.ts'))).toBe(true);
    expect(isExempt(join(ui, 'design-system.html'))).toBe(true);
    expect(isExempt(join(ui, 'design-system-states.tsx'))).toBe(true);
    expect(isExempt(join(ui, 'styles/27-ds-components.css'))).toBe(false);
    expect(isExempt(join(tmpdir(), 'design-system.html'))).toBe(false);
    expect(isExempt(join(tmpdir(), 'styles/00-theme.css'))).toBe(false);
    expect(isExempt(join(ui, 'views/design-system.html'))).toBe(false); // only the page at src/ui
  });

  it('finds the variables code sets at runtime from its syntax tree', () => {
    const names = (source: string, file = 'x.tsx') => [...customPropertyNames(source, file)].sort();
    expect(names("<div style={{ '--cg-color': color, ['--agent' as string]: c } as CSSProperties} />")).toEqual(['--agent', '--cg-color']);
    expect(names("el.style.setProperty('--w', `${w}px`);", 'x.ts')).toEqual(['--w']);
    expect(names("// e.g. { '--example': red }\nconst s = \"'--also-text': 1\";")).toEqual([]);
    expect(runtimeProps().has('--cg-color')).toBe(true);
  });

  it('reads a value once, into words, strings and functions', () => {
    const tree = parseValue('var(--a, var(--b)) "x(y)" url(a b.png) calc(-1 * 4px)');
    expect(tree.filter((n: { type: string }) => n.type !== 'space').map((n: { type: string; value: string }) => `${n.type}:${n.value}`))
      .toEqual(['function:var', 'string:"x(y)"', 'function:url', 'function:calc']);
    expect(varRefs(tree).map((r: { name: string }) => r.name)).toEqual(['--a', '--b']);
    expect(varRefs(parseValue('"var(--a)" url(var(--b))'))).toEqual([]);
  });

  it('reads no variable inside quoted text or a URL', () => {
    const tokens = (prop: string, value: string) => checkDeclaration(system, prop, value, { known: new Set() })
      .filter((f: { kind: string }) => f.kind === 'token').map((f: { value: string }) => f.value);
    expect(tokens('content', '"var(--example)"')).toEqual([]);
    expect(tokens('content', "'see var(--x)'")).toEqual([]);
    expect(tokens('background', 'url("var(--x).png")')).toEqual([]);
    expect(tokens('color', 'var(--missing)')).toEqual(['--missing']);
    expect(tokens('content', '"x" var(--missing)')).toEqual(['--missing']);
  });

  it('reads HTML attributes with > inside their quotes', () => {
    const hints = (html: string) => checkText(system, html, 'mock.html', { known: new Set(), mockup: true })
      .filter((f: { kind: string }) => f.kind === 'component').length;
    expect(hints('<button data-x="a > b" class="ds-btn">Save</button>')).toBe(0);
    expect(hints('<button data-x="a > b" class="btn">Save</button>')).toBe(1);
  });

  it('reads style attributes with spaces around the =', () => {
    const found = (html: string) => checkText(system, html, 'mock.html', { known: new Set(), mockup: true })
      .map((f: { line: number; prop?: string; value: string }) => `${f.line} ${f.prop} ${f.value}`);
    const plain = found('<div style="padding: 10px"></div>');
    expect(plain).toEqual(['1 padding 10px']);
    expect(found('<div style = "padding: 10px"></div>')).toEqual(plain);
    expect(found("<div style\n  =\n  'padding: 10px'></div>")).toEqual(['3 padding 10px']);
    expect(found('<div data-style="padding: 10px"></div>')).toEqual([]); // another attribute
  });

  it("checks a mock-up's redefinition of a node UI token", () => {
    const found = (css: string) => checkText(system, `<style>${css}</style>`, 'mock.html', { known: new Set(), mockup: true })
      .filter((f: { offScale?: boolean }) => f.offScale)
      .map((f: { prop?: string; kind: string; value: string }) => `${f.prop} ${f.kind} ${f.value}`);
    expect(found(':root { --space-8: 10px; } .x { gap: var(--space-8); }')).toEqual(['--space-8 token 10px', 'gap spacing 10px']);
    // A copy of the token at its own value, and a plain use of a token, are fine.
    expect(found(':root { --space-8: 8px; } .x { gap: var(--space-8); }')).toEqual([]);
    expect(found('.x { gap: var(--space-8); }')).toEqual([]);
  });

  it('says where CSS it cannot read is, instead of passing it', () => {
    const [f] = checkText(system, '.a {\n  gap 10px;\n}', 'x.css', { known: new Set() });
    expect(f).toMatchObject({ line: 2, kind: 'css', offScale: true });
  });

  it('reads an unspaced * in calc() as multiplication, like a spaced one', () => {
    const kinds = (prop: string, value: string) => classify(prop, value).map((h: { kind: string; value: string }) => `${h.kind} ${h.value}`);
    for (const [prop, spaced, unspaced, expected] of [
      ['gap', 'calc(2 * 10px)', 'calc(2*10px)', ['spacing 10px']],
      ['font-size', 'calc(15px * 1)', 'calc(15px*1)', ['type size 15px']],
      ['border-radius', 'calc(10px * 2)', 'calc(10px*2)', ['corner 10px']],
    ] as const) {
      expect(kinds(prop, unspaced), unspaced).toEqual(expected);
      expect(kinds(prop, unspaced)).toEqual(kinds(prop, spaced));
    }
    // A negative number and a custom property's name are still one word each.
    expect(kinds('margin', 'calc(-2*var(--space-8))')).toEqual([]);
    expect(kinds('gap', 'calc(var(--space-8)*2)')).toEqual([]);
  });

  it('reads CSS values with delimiters in quotes, and comments in values', () => {
    const found = (css: string) => checkText(system, css, 'x.css', { known: new Set() })
      .filter((f: { offScale?: boolean }) => f.offScale).map((f: { prop?: string; value: string }) => `${f.prop} ${f.value}`);
    expect(found('.a { content: "a; b }"; gap: 10px; }')).toEqual(['gap 10px']);
    expect(found('.a { gap: /* was 12px */ 10px; }')).toEqual(['gap 10px']);
  });

  it('reads style attributes in either quote', () => {
    const found = (html: string) => checkText(system, html, 'mock.html', { known: new Set(), mockup: true })
      .map((f: { prop: string; value: string }) => `${f.prop} ${f.value}`);
    const double = found('<div style="padding: 10px; color: #ff00ff"></div>');
    expect(double).toEqual(['padding 10px', 'color #ff00ff']);
    expect(found("<div style='padding: 10px; color: #ff00ff'></div>")).toEqual(double);
  });

  it('reads JSX style objects through casts, for any property', () => {
    const found = (tsx: string) => checkText(system, tsx, 'x.tsx', { known: new Set() })
      .map((f: { line: number; prop: string; value: string }) => `${f.line} ${f.prop} ${f.value}`);
    const plain = found('<div style={{ paddingTop: 10, zIndex: 50 }} />');
    expect(plain).toEqual(['1 padding-top 10px', '1 z-index 50']);
    expect(found('<div style={{ paddingTop: 10, zIndex: 50 } as React.CSSProperties} />')).toEqual(plain);
    expect(found('<div style={({ paddingTop: 10, zIndex: 50 }) satisfies Style} />')).toEqual(plain);
    expect(found('<div style={{ padding: gap, width: `${w}px` }} />')).toEqual([]); // worked out at runtime
  });

  it('exits 1 on a design off the system, and 0 on one on it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'design-check-'));
    try {
      const run = (css: string, name = 'mock.html') => {
        const file = join(dir, name);
        writeFileSync(file, name.endsWith('.css') ? css : `<style>${css}</style>`);
        return spawnSync(process.execPath, [SCRIPT, '--json', file], { encoding: 'utf8' }).status;
      };
      expect(run('.a { padding: 10px; }')).toBe(1);
      // A mock-up named like one of the package's own exempt files is still checked.
      expect(run('.a { padding: 10px; }', 'design-system.html')).toBe(1);
      expect(run('.a { padding: 10px; }', '00-theme.css')).toBe(1);
      expect(run('.a { color: #ff00ff; }')).toBe(1); // an opaque colour off the system
      expect(run('.a { color: magenta; }')).toBe(1);
      expect(run('.a { padding: var(--space-12); }')).toBe(0);
      expect(run('.a { padding: 16px; }')).toBe(1); // on the scale, but written as a number: use var(--space-16)
      expect(run('.a { color: #ffffff; }')).toBe(1); // a token's value, written as a literal
      expect(run('.a { border-radius: 999px; }')).toBe(1); // a pill written as a number: var(--radius-pill)
      expect(run('.a { height: 32px; }')).toBe(0); // a height may be layout: a suggestion, not a failure
      expect(run('.a { content: "#ff00ff"; }')).toBe(0);
      expect(run('.a { padding: 0.625rem; }')).toBe(1); // another unit
      expect(run('.a { font-size: 2vw; }')).toBe(1);
      expect(run('.a { border-radius: 50%; padding: 0rem; }')).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --changed against a git repository of its own: a tracked stylesheet with a value off
  // the system on an old line and on a new one, and an untracked stylesheet.
  it('reports CSS it cannot read when any line of it changed, wherever the parser points', () => {
    // The closing brace replaced by a new line: PostCSS reports the unclosed block on line 1.
    const css = '.a {\n  gap: var(--space-8);\n  padding: 10px;\n';
    const kinds = (keep: (line: number) => boolean) => checkText(system, css, 'x.css', { keepLine: keep }).map((f: { line: number; kind: string }) => `${f.line} ${f.kind}`);
    expect(kinds((l) => l === 3)).toEqual(['1 css']);
    expect(kinds(() => false)).toEqual([]);
  });

  it('checks only added lines and untracked files with --changed', () => {
    const repo = mkdtempSync(join(tmpdir(), 'design-check-git-'));
    try {
      const pkg = join(repo, 'packages/node-ui');
      const styles = join(pkg, 'src/ui/styles');
      mkdirSync(styles, { recursive: true });
      copyFileSync(join(__dirname, '../src/ui/styles/00-theme.css'), join(styles, '00-theme.css'));
      const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=design-check', '-c', 'user.email=design-check@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, stdio: 'pipe' });
      git('init', '-q', '-b', 'main');
      // Settings that change diff headers must not hide changed files from the check.
      git('config', 'diff.noprefix', 'true');
      git('config', 'diff.mnemonicPrefix', 'true');
      git('config', 'diff.relative', 'true');
      writeFileSync(join(styles, 'a.css'), '.old { padding: 10px; }\n');
      writeFileSync(join(styles, 'c.css'), '.c {\n  --gap: var(--space-8);\n  gap: var(--gap);\n}\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'base');
      git('checkout', '-q', '-b', 'feature');
      writeFileSync(join(styles, 'a.css'), '.old { padding: 10px; }\n.new { gap: 10px; }\n');
      // Only the definition changes: the unchanged gap that reads it is reported at line 2.
      writeFileSync(join(styles, 'c.css'), '.c {\n  --gap: 10px;\n  gap: var(--gap);\n}\n');
      git('commit', '-q', '-am', 'feature');
      writeFileSync(join(styles, 'b.css'), '.u {\n  padding:\n    10px;\n}\n');
      // A name git would quote and escape without -z (core.quotePath is on by default).
      git('config', 'core.quotePath', 'true');
      writeFileSync(join(styles, 'café.css'), '.c { padding: 10px; }\n');

      const run = spawnSync(process.execPath, [SCRIPT, '--changed', 'main', '--json'], { cwd: pkg, encoding: 'utf8', env: { ...process.env, DESIGN_CHECK_PKG: pkg } });
      const results = JSON.parse(run.stdout) as { file: string; findings: { line: number; prop: string; offScale?: boolean }[] }[];
      const found = results.flatMap((r) => r.findings.filter((f) => f.offScale).map((f) => `${r.file}:${f.line} ${f.prop}`));
      expect(found.sort()).toEqual(['src/ui/styles/a.css:2 gap', 'src/ui/styles/b.css:2 padding', 'src/ui/styles/c.css:2 gap', 'src/ui/styles/café.css:1 padding']);
      expect(run.status).toBe(1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // The suites in design-tokens and layout-tokens hold the rules; this one adds the
  // suggestion, so a failure here says what to write instead.
  it('finds nothing off the system in the UI stylesheets', () => {
    const known = runtimeProps();
    const off = cssFiles.filter((f) => !f.endsWith('00-theme.css')).flatMap((f) => (
      checkText(system, read(f), f, { known })
        .filter((x: { offScale?: boolean }) => x.offScale)
        .map((x: { line: number; prop: string; value: string; use: string }) => `${where(f)}:${x.line} ${x.prop}: ${x.value} → ${x.use}`)
    ));
    expect(off).toEqual([]);
  });
});
