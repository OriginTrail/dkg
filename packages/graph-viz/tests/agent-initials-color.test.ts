import { describe, expect, it } from 'vitest';
import { agentInitialsColor } from '../src/agent-initials/index.js';

const channel = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const hslToHex = (h: number, s: number, l: number) => {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round((l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
};

describe('agentInitialsColor', () => {
  it('clears 4.5:1 on every agent hue', () => {
    for (let hue = 0; hue < 360; hue++) {
      const fill = hslToHex(hue, 0.55, 0.58);
      expect(contrast(fill, agentInitialsColor(fill)!), fill).toBeGreaterThanOrEqual(4.5);
      // The hsl form skips hex rounding, so at the crossover it may pick the other colour; either clears 4.5:1 there.
      expect(contrast(fill, agentInitialsColor(`hsl(${hue}, 55%, 58%)`)!), `hsl ${hue}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('picks dark text on light fills and white on dark ones', () => {
    expect(agentInitialsColor('#ffe680')).toBe('#000000');
    expect(agentInitialsColor('#123')).toBe('#ffffff');
  });

  it('leaves a fill it can\'t read to the caller', () => {
    expect(agentInitialsColor('var(--identity-fallback)')).toBeUndefined();
  });
});
