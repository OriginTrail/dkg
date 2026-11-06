// Graph colours come from an explicit theme, as plain records (review:
// "make theme resolution explicit instead of hiding it behind record getters").
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { graphPalette, dataSlotHex } from '../src/ui/graph-palette.js';
import { ENTITY_TYPE_KINDS, kindColorForType, kindSlot } from '../src/ui/entity-kind-colors.js';
import {
  buildLayerGraphOptions,
  codeClassColors,
  codePredicateColors,
  trustColors,
  graphClassAppearance,
  CODE,
} from '../src/ui/views/project/helpers.js';
import { VIZ_ANCHOR_TYPE, VIZ_PRED_ANCHORED_IN } from '../src/ui/hooks/useVerifiableMemoryAnchors.js';

const theme = readFileSync(new URL('../src/ui/styles/00-theme.css', import.meta.url), 'utf8');
/** Token values from the first :root (dark) block and the light block. */
function tokens(which: 'dark' | 'light'): Record<string, string> {
  const block = which === 'dark'
    ? theme.slice(theme.indexOf(':root {'), theme.indexOf('}', theme.indexOf(':root {')))
    : theme.slice(theme.indexOf(':root.light, body.light {'), theme.indexOf('}', theme.indexOf(':root.light, body.light {')));
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{3,8})\b/g)) out[m[1]] = m[2].toLowerCase();
  return out;
}

/** Every own property is a plain value (no getters doing work on read). */
function isPlain(record: object): boolean {
  return Object.values(Object.getOwnPropertyDescriptors(record)).every(d => 'value' in d && !d.get);
}

describe('graph palette', () => {
  for (const t of ['dark', 'light'] as const) {
    it(`matches the ${t} tokens in 00-theme.css`, () => {
      const css = tokens(t);
      const p = graphPalette(t);
      expect(p.layer).toEqual({ working: css['--layer-working'], shared: css['--layer-shared'], verified: css['--layer-verified'] });
      expect(p.data).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map(n => css[`--data-${n}`]));
    });
  }

  it('uses the --text-tertiary grey as the neutral node, so DOM fallbacks (the token) and canvas fallbacks (the palette) match', () => {
    for (const t of ['dark', 'light'] as const) expect(graphPalette(t).neutral.node, t).toBe(tokens(t)['--text-tertiary']);
  });

  it('gives DOM badges and canvas nodes the same palette slot for every code type, from one registry', () => {
    const codeTypes = Object.entries(ENTITY_TYPE_KINDS).filter(([iri]) => iri.startsWith(CODE));
    expect(codeTypes.length).toBeGreaterThanOrEqual(7);
    for (const t of ['dark', 'light'] as const) {
      const p = graphPalette(t);
      const canvas = codeClassColors(p);
      for (const [iri, kind] of codeTypes) {
        expect(kindColorForType(iri), iri).toBe(`var(--data-${kindSlot(kind)})`);
        expect(canvas[iri], iri).toBe(dataSlotHex(p, kindSlot(kind)));
      }
    }
  });

  it('is resolved without the DOM, and stable per theme', () => {
    expect(typeof (globalThis as { document?: unknown }).document).toBe('undefined');
    expect(graphPalette('dark')).toBe(graphPalette('dark'));
    expect(graphPalette('light')).not.toBe(graphPalette('dark'));
    expect(Object.isFrozen(graphPalette('dark'))).toBe(true);
    expect(dataSlotHex(graphPalette('dark'), 9)).toBe(graphPalette('dark').data[0]);
  });
});

describe('graph option builders take the palette explicitly', () => {
  const dark = graphPalette('dark');
  const light = graphPalette('light');

  it('return plain records whose values follow the theme passed in', () => {
    for (const p of [dark, light]) {
      const classes = codeClassColors(p);
      const preds = codePredicateColors(p);
      expect(isPlain(classes) && isPlain(preds) && isPlain(trustColors(p))).toBe(true);
      expect(classes[VIZ_ANCHOR_TYPE]).toBe(p.anchor.fill);
      expect(classes[CODE + 'ExternalModule']).toBe(p.neutral.node);
      expect(preds[VIZ_PRED_ANCHORED_IN]).toBe(p.layer.verified);
      expect(graphClassAppearance(p)[VIZ_ANCHOR_TYPE]).toMatchObject({ border: { color: p.anchor.ring }, fill: 'flat' });
      expect(trustColors(p)).toEqual({ verified: p.layer.verified, shared: p.layer.shared, working: p.layer.working });
    }
    expect(codeClassColors(dark)).not.toEqual(codeClassColors(light));
  });

  it('layer graph options use the palette for defaults, classes and edges', () => {
    const vmDark = buildLayerGraphOptions('vm', dark).style;
    const vmLight = buildLayerGraphOptions('vm', light).style;
    expect(vmDark.defaultNodeColor).toBe(dark.layer.verified);
    expect(vmLight.defaultNodeColor).toBe(light.layer.verified);
    expect(vmDark.defaultEdgeColor).toBe(dark.layer.verified);
    expect(buildLayerGraphOptions('swm', dark).style.defaultEdgeColor).toBe(dark.neutral.edge);
    expect(isPlain(vmDark.classColors)).toBe(true);
    // A snapshot and the original are the same thing now.
    expect({ ...vmDark.classColors }).toEqual(vmDark.classColors);
  });
});
