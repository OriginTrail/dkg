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

  // `useLocalCg: false` is treated as equivalent to omission, which matches
  // typical JSON-default serialization patterns where a client emits every
  // field with its default. Non-boolean values like `0` / `'true'` / `1` are
  // still rejected as type errors at the API boundary — coercing them would
  // silently mask caller bugs. These tests lock that behavior in.
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

  // Bug 1 regression: a client that auto-emits boolean defaults (e.g. JSON
  // serializing `useLocalCg: false`) alongside a real `contextGraphId` must
  // be accepted as a shared selection, not rejected as "mutually exclusive".
  it('accepts contextGraphId paired with useLocalCg: false as shared (trimmed)', () => {
    expect(
      validateContextGraphSelection({
        contextGraphId: '  devnet-test  ',
        useLocalCg: false,
      }),
    ).toEqual({ kind: 'shared', contextGraphId: 'devnet-test' });
  });

  // Bug 2 regression: the `kafka-local` namespace is reserved at the package
  // level for node-local free CGs (see local-cg.ts). The reservation covers
  // both the bare id and any `kafka-local-{peerId}` prefix form — the prefix
  // space is owned by the local-CG ensurer.
  it('rejects contextGraphId: "kafka-local" with a hint to use useLocalCg: true', () => {
    expect(() =>
      validateContextGraphSelection({ contextGraphId: 'kafka-local' }),
    ).toThrow(/"useLocalCg":\s*true/);
  });

  it('rejects whitespace-padded "kafka-local" (trim happens before the reserved-id check)', () => {
    expect(() =>
      validateContextGraphSelection({ contextGraphId: '  kafka-local  ' }),
    ).toThrow(/kafka-local/);
  });

  it('rejects the per-node prefixed form "kafka-local-{peerId}" with the same hint', () => {
    expect(() =>
      validateContextGraphSelection({
        contextGraphId: 'kafka-local-12D3KooWAbcDEFghiJKLmnoPQRstuVWxyZ',
      }),
    ).toThrow(/"useLocalCg":\s*true/);
  });

  // Boundary: only the literal `kafka-local-` prefix is reserved. Ids that
  // happen to start with the substring `kafkalocal` (no dash) are perfectly
  // valid shared ids and must NOT be swept up by the prefix check.
  it('accepts a shared id that merely contains "kafkalocal" without the reserved prefix', () => {
    expect(
      validateContextGraphSelection({ contextGraphId: 'kafkalocal' }),
    ).toEqual({ kind: 'shared', contextGraphId: 'kafkalocal' });
  });
});
