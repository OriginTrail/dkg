import { describe, expect, it } from 'vitest';
import { resolveContextGraphAccessPolicyDeclarations } from '../src/context-graph-access-policy.js';

describe('context graph access-policy resolution', () => {
  it('accepts duplicate equivalent literal declarations', () => {
    expect(resolveContextGraphAccessPolicyDeclarations('public-cg', [
      '"public"',
      '"  PuBlIc  "',
    ])).toBe('public');
    expect(resolveContextGraphAccessPolicyDeclarations('private-cg', [
      '"private"',
      '"private"^^<http://www.w3.org/2001/XMLSchema#string>',
    ])).toBe('private');
  });

  it.each([
    ['missing declarations', []],
    ['non-literal declaration', ['did:dkg:policy:public']],
    ['unknown literal declaration', ['"ownerOnly"']],
    ['conflicting declarations', ['"public"', '"private"']],
  ])('rejects %s', (_name, declarations) => {
    expect(() => resolveContextGraphAccessPolicyDeclarations('unsafe-cg', declarations))
      .toThrow(/refusing registration/);
  });
});
