// One format per kind of value (see DESIGN.md · Data display).
import { describe, expect, it, vi } from 'vitest';
import { bpsToPercent, formatBps, formatDateTime, formatNumber, truncateAddress } from '../src/ui/lib/format.js';
import { classText, jsxElements, parseTsx, tagName, uiJsxElements } from './helpers/jsx.js';
import { codeFiles, findAll, where } from './helpers/source.js';

// The shared formats themselves live in lib/format.ts.
const code = codeFiles.filter((f) => where(f) !== 'lib/format.ts');
const matches = (pattern: RegExp) => findAll(code, pattern);

describe('shared formats', () => {
  it('shortens only what it can shorten', () => {
    expect(truncateAddress('0x3489abcdef0123456789E47D')).toBe('0x3489…E47D');
    expect(truncateAddress('0x1234')).toBe('0x1234');
    expect(truncateAddress('abcdefghijklmnopqrst', 8, 6)).toBe('abcdefgh…opqrst');
  });

  describe('dates', () => {
    // What the reader sees is exactly this Intl format in their locale and time zone,
    // never the raw ISO string.
    const ISO = '2026-11-05T14:03:07Z';
    const QUOTED = '"' + ISO + '"';
    const base = { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' } as const;
    const expected = (opts: Intl.DateTimeFormatOptions) => new Date(ISO).toLocaleString(undefined, opts);

    it('formats to the reader\'s date and time, not the raw value', () => {
      const out = formatDateTime(ISO);
      expect(out).toBe(expected(base));
      expect(out).not.toContain('T14');
      expect(out).not.toBe(ISO);
    });

    it('reads a quoted timestamp the same as an unquoted one', () => {
      expect(formatDateTime(QUOTED)).toBe(formatDateTime(ISO));
      expect(formatDateTime(QUOTED)).not.toBe(QUOTED);
    });

    it('takes epoch milliseconds and Date objects the same way', () => {
      expect(formatDateTime(Date.parse(ISO))).toBe(expected(base));
      expect(formatDateTime(new Date(ISO))).toBe(expected(base));
    });

    it('adds seconds only when asked, as operation timestamps do', () => {
      const withSeconds = formatDateTime(ISO, { seconds: true });
      expect(withSeconds).toBe(expected({ ...base, second: '2-digit' }));
      expect(withSeconds).toContain('07');
      expect(withSeconds).not.toBe(formatDateTime(ISO));
    });

    it('reads exactly, with the locale and time zone fixed to en-US and UTC', () => {
      const real = Date.prototype.toLocaleString;
      const spy = vi.spyOn(Date.prototype, 'toLocaleString').mockImplementation(function (this: Date, _locale, options) {
        return real.call(this, 'en-US', { ...options, timeZone: 'UTC' });
      });
      try {
        expect(formatDateTime(ISO)).toBe('Nov 5, 2026, 2:03 PM');
        expect(formatDateTime(QUOTED)).toBe('Nov 5, 2026, 2:03 PM');
        expect(formatDateTime(ISO, { seconds: true })).toBe('Nov 5, 2026, 2:03:07 PM');
      } finally {
        spy.mockRestore();
      }
    });

    it('hands back what it cannot read', () => {
      expect(formatDateTime('not a date')).toBe('not a date');
    });
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

  // A table is wrapped when an element around it, in the same JSX, has ds-table-scroll.
  // Markdown tables (v10-md-table) scroll with their message instead.
  const unwrappedTables = (elements: Iterable<{ node: Parameters<typeof tagName>[0]; ancestors: Parameters<typeof tagName>[0][]; where: string }>) => [...elements]
    .filter(({ node }) => tagName(node) === 'table' && !/\bv10-md-table\b/.test(classText(node)))
    .filter(({ ancestors }) => !ancestors.some((a) => /\bds-table-scroll\b/.test(classText(a))))
    .map(({ where }) => where);

  it('keeps every data table in a scroll wrapper', () => {
    expect(unwrappedTables(uiJsxElements())).toEqual([]);
  });

  it('reads the wrapper from the element tree, however the source is laid out', () => {
    const check = (source: string) => unwrappedTables(jsxElements(parseTsx(source)));
    expect(check('const A = () => <div className="ds-table-scroll"><table><tbody /></table></div>;')).toEqual([]);
    expect(check(`const A = () => (
      <div className="ds-table-scroll">
        <table>
          <tbody />
        </table>
      </div>
    );`)).toEqual([]);
    // The wrapper can carry other classes, and sit further up.
    expect(check('const A = () => <div className={`ds-table-scroll ${x}`}><section><table /></section></div>;')).toEqual([]);
    expect(check('const A = () => <table className="v10-md-table" />;')).toEqual([]);
    expect(check('const A = () => <div className="card"><table><tbody /></table></div>;')).toHaveLength(1);
    expect(check('const A = () => <table />;')).toHaveLength(1);
  });
});
