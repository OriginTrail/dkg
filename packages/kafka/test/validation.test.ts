import { describe, expect, it } from 'vitest';
import { validateContextGraphSelection } from '../src/validation.js';

describe('validateContextGraphSelection', () => {
  it('accepts a non-empty contextGraphId alone and resolves to shared scope', () => {
    expect(
      validateContextGraphSelection({ contextGraphId: 'devnet-test' }),
    ).toEqual({ kind: 'shared', contextGraphId: 'devnet-test' });
  });

  it('normalizes a whitespace-padded contextGraphId by trimming it', () => {
    expect(
      validateContextGraphSelection({ contextGraphId: '  devnet-test  ' }),
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

  // Strict-typing decision: `useLocalCg: false` collapses to "no CG selected"
  // (the actionable "missing selection" message), while `useLocalCg: 0` (and
  // any other non-boolean) is a type error at the API boundary. We keep this
  // asymmetry on purpose: callers should pass a real boolean. Coercing
  // truthy/falsy values to booleans here would mask the type bug at the
  // boundary and make wrong-type usage feel valid. These two tests document
  // and lock in that behavior.
  it('treats useLocalCg: false as "missing selection" (boolean false collapses)', () => {
    expect(() =>
      validateContextGraphSelection({ useLocalCg: false }),
    ).toThrow(/Missing context-graph selection/);
  });

  it('treats useLocalCg: 0 as a type error ("must be a boolean")', () => {
    expect(() =>
      validateContextGraphSelection({ useLocalCg: 0 as unknown as boolean }),
    ).toThrow(/"useLocalCg" must be a boolean/);
  });
});
