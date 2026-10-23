import { describe, expect, it, vi } from 'vitest';
import { invoke_program, invoke_tool, map, pipe, reduce } from '../src/program.js';

describe('guest-only Program API', () => {
  it.each([
    ['tool invocation', () => invoke_tool('urn:tool', {})],
    ['child invocation', () => invoke_program('urn:program', [])],
  ])('refuses %s outside a compiled Program', (_label, call) => {
    expect(call).toThrow(/available inside compiled Graph Computer Programs/);
  });

  it('refuses host-side pipelines without running user callbacks', () => {
    const callback = vi.fn();
    expect(() => pipe([], callback)).toThrow(/available inside compiled Graph Computer Programs/);
    expect(() => map(callback)).toThrow(/available inside compiled Graph Computer Programs/);
    expect(() => reduce(callback, 0)).toThrow(/available inside compiled Graph Computer Programs/);
    expect(callback).not.toHaveBeenCalled();
  });
});
