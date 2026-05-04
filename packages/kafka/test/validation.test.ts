import { describe, expect, it } from 'vitest';
import { validateContextGraphSelection } from '../src/validation.js';

describe('validateContextGraphSelection', () => {
  it('accepts a non-empty contextGraphId alone and resolves to shared scope', () => {
    expect(
      validateContextGraphSelection({ contextGraphId: 'devnet-test' }),
    ).toEqual({ kind: 'shared', contextGraphId: 'devnet-test' });
  });

  it('accepts useLocalCg: true alone and resolves to local scope', () => {
    expect(validateContextGraphSelection({ useLocalCg: true })).toEqual({
      kind: 'local',
    });
  });

  it('rejects neither field with an error mentioning both options', () => {
    expect(() => validateContextGraphSelection({})).toThrow(
      /contextGraphId.*useLocalCg|useLocalCg.*contextGraphId/,
    );
  });

  it('rejects both fields with an error mentioning both options', () => {
    expect(() =>
      validateContextGraphSelection({
        contextGraphId: 'devnet-test',
        useLocalCg: true,
      }),
    ).toThrow(/contextGraphId.*useLocalCg|useLocalCg.*contextGraphId/);
  });

  it('rejects useLocalCg: false alone (treated as neither field set)', () => {
    expect(() =>
      validateContextGraphSelection({ useLocalCg: false }),
    ).toThrow(/contextGraphId.*useLocalCg|useLocalCg.*contextGraphId/);
  });

  it('rejects an empty-string contextGraphId', () => {
    expect(() =>
      validateContextGraphSelection({ contextGraphId: '' }),
    ).toThrow(/contextGraphId/);
  });

  it('rejects a whitespace-only contextGraphId', () => {
    expect(() =>
      validateContextGraphSelection({ contextGraphId: '   ' }),
    ).toThrow(/contextGraphId/);
  });

  it('rejects a non-string contextGraphId', () => {
    expect(() =>
      validateContextGraphSelection({ contextGraphId: 42 as unknown as string }),
    ).toThrow(/contextGraphId/);
  });

  it('rejects a non-boolean useLocalCg', () => {
    expect(() =>
      validateContextGraphSelection({ useLocalCg: 'yes' as unknown as boolean }),
    ).toThrow(/useLocalCg/);
  });
});
