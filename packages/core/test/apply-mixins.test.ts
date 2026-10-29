import { describe, expect, it } from 'vitest';
import { applyMixins } from '../src/apply-mixins.js';

describe('applyMixins', () => {
  it('copies every holder member, accessors included, but never constructor', () => {
    class Target {}
    class First {
      alpha(): string {
        return 'first';
      }
    }
    class Second {
      get beta(): string {
        return 'second';
      }
    }

    applyMixins(Target, [First, Second]);

    const target = new Target() as Target & { alpha(): string; readonly beta: string };
    expect(target.alpha()).toBe('first');
    expect(target.beta).toBe('second');
    expect(Object.getOwnPropertyDescriptor(Target.prototype, 'beta')?.get)
      .toBe(Object.getOwnPropertyDescriptor(Second.prototype, 'beta')?.get);
    expect(Target.prototype.constructor).toBe(Target);
  });

  it('throws naming both holders when two define the same member', () => {
    class Target {}
    class EarlierHolder {
      shared(): string {
        return 'earlier';
      }
    }
    class LaterHolder {
      shared(): string {
        return 'later';
      }
    }

    expect(() => applyMixins(Target, [EarlierHolder, LaterHolder])).toThrow(
      "Target mixin collision: 'shared' is defined by both EarlierHolder and LaterHolder",
    );
  });
});
