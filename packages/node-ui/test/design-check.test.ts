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
import { buildSystem, checkDeclaration, checkText, parseColour, readTokens, runtimeProps } from '../scripts/design-core.mjs';
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
    const gaps = (css: string) => checkText(system, `<style>${css}</style>`, 'mock.html', { known: new Set(['--gap']), mockup: true })
      .filter((f: { offScale?: boolean; prop: string }) => f.offScale && f.prop === 'gap')
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

  it('fails an opaque colour off the system, and passes one on it', () => {
    const off = (prop: string, value: string) => checkDeclaration(system, prop, value, { known: new Set() })
      .filter((f: { kind: string }) => f.kind === 'colour').map((f: { offScale?: boolean }) => Boolean(f.offScale));
    expect(off('color', '#ffffff')).toEqual([false]);
    expect(off('background', '#ff00ff')).toEqual([true]);
    expect(off('background', '#7a1f55')).toEqual([true]);
  });

  it("passes every token's own colour, whatever the property's job", () => {
    const tokenColours = system.colours.filter((t: { alpha: number; text: string }) => t.alpha === 1 && !/var\(/.test(t.text));
    expect(tokenColours.length).toBeGreaterThan(10);
    const off = tokenColours.flatMap((t: { name: string; text: string }) => ['color', 'background', 'border-color'].flatMap((prop) => (
      checkDeclaration(system, prop, t.text, { known: new Set() })
        .filter((f: { kind: string; offScale?: boolean }) => f.kind === 'colour' && f.offScale)
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
      .filter((f: { offScale?: boolean; prop?: string }) => f.offScale && f.prop === 'padding')
      .map((f: { value: string }) => f.value);
    // --pad is computed at :root, with :root's --gap, before .a's --gap applies.
    expect(pads(':root { --gap: 10px; --pad: var(--gap); } .a { --gap: 8px; padding: var(--pad); }')).toEqual(['10px']);
    expect(pads(':root { --gap: 8px; --pad: var(--gap); } .a { --gap: 10px; padding: var(--pad); }')).toEqual([]);
    // A loop between variables stops, and leaves the value as written.
    expect(() => pads(':root { --a: var(--b); --b: var(--a); } .x { padding: var(--a); }')).not.toThrow();
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
      const run = (css: string) => {
        const file = join(dir, 'mock.html');
        writeFileSync(file, `<style>${css}</style>`);
        return spawnSync(process.execPath, [SCRIPT, '--json', file], { encoding: 'utf8' }).status;
      };
      expect(run('.a { padding: 10px; }')).toBe(1);
      expect(run('.a { color: #ff00ff; }')).toBe(1); // an opaque colour off the system
      expect(run('.a { color: magenta; }')).toBe(1);
      expect(run('.a { padding: var(--space-12); }')).toBe(0);
      expect(run('.a { padding: 16px; }')).toBe(0); // on the scale, written as a number: a suggestion, not a failure
      expect(run('.a { content: "#ff00ff"; }')).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --changed against a git repository of its own: a tracked stylesheet with a value off
  // the system on an old line and on a new one, and an untracked stylesheet.
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
      git('add', '-A');
      git('commit', '-q', '-m', 'base');
      git('checkout', '-q', '-b', 'feature');
      writeFileSync(join(styles, 'a.css'), '.old { padding: 10px; }\n.new { gap: 10px; }\n');
      git('commit', '-q', '-am', 'feature');
      writeFileSync(join(styles, 'b.css'), '.u {\n  padding:\n    10px;\n}\n');

      const run = spawnSync(process.execPath, [SCRIPT, '--changed', 'main', '--json'], { cwd: pkg, encoding: 'utf8', env: { ...process.env, DESIGN_CHECK_PKG: pkg } });
      const results = JSON.parse(run.stdout) as { file: string; findings: { line: number; prop: string; offScale?: boolean }[] }[];
      const found = results.flatMap((r) => r.findings.filter((f) => f.offScale).map((f) => `${r.file}:${f.line} ${f.prop}`));
      expect(found.sort()).toEqual(['src/ui/styles/a.css:2 gap', 'src/ui/styles/b.css:2 padding']);
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
