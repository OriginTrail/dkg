// One format per kind of value (see DESIGN.md · Data display).
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bpsToPercent, formatBps, formatDateTime, formatNumber, truncateAddress } from '../src/ui/lib/format.js';

const UI = join(__dirname, '../src/ui');
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (
  e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]
));
const code = walk(UI).filter((f) => /\.tsx?$/.test(f) && !f.endsWith(join('lib', 'format.ts')));
const matches = (pattern: RegExp, list = code) => list.flatMap((file) => (
  [...readFileSync(file, 'utf8').matchAll(pattern)].map(([m]) => `${relative(UI, file)}: ${m.slice(0, 70)}`)
));

describe('shared formats', () => {
  it('shortens only what it can shorten', () => {
    expect(truncateAddress('0x3489abcdef0123456789E47D')).toBe('0x3489…E47D');
    expect(truncateAddress('0x1234')).toBe('0x1234');
    expect(truncateAddress('abcdefghijklmnopqrst', 8, 6)).toBe('abcdefgh…opqrst');
  });

  it('formats dates, and hands back what it cannot read', () => {
    expect(formatDateTime('2026-11-05T14:03:00Z')).toContain('2026');
    expect(formatDateTime('"2026-11-05T14:03:00Z"')).toContain('2026');
    expect(formatDateTime('not a date')).toBe('not a date');
  });

  it('formats counts and basis points', () => {
    expect(formatNumber(1234)).toBe((1234).toLocaleString());
    expect(bpsToPercent(2500)).toBe('25');
    expect(formatBps(1250)).toBe('12.5%');
  });
});

describe('formats come from one place', () => {
  it('leaves no default locale calls outside lib/format.ts', () => {
    expect(matches(/\.toLocaleString\(\)/g)).toEqual([]);
  });

  it('leaves no hand-built percentages from basis points', () => {
    expect(matches(/% 1 === 0|% 100 === 0 \? 0 : 1/g)).toEqual([]);
  });

  it('leaves no hand-built shortened addresses', () => {
    expect(matches(/…\$\{[\w.]+\.slice\(-\d+\)\}|\+ '…' \+ [\w.]+\.slice\(-\d+\)/g)).toEqual([]);
  });

  it('keeps every data table in a scroll wrapper', () => {
    expect(matches(/(?<!ds-table-scroll[^<]*"?>)<table(?! className="v10-md-table")/g, code.filter((f) => f.endsWith('.tsx')))).toEqual([]);
  });
});
