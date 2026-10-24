import { describe, expect, it } from 'vitest';
import {
  ROOTLESS_UPDATE_ERROR_CODES,
  RootlessUpdateError,
  isRootlessUpdateError,
} from '../src/rootless-update-error.js';

describe('rootless update error contract', () => {
  it.each(ROOTLESS_UPDATE_ERROR_CODES)('recognizes the declared code %s', (code) => {
    const error = new RootlessUpdateError(code, 'rejected');
    expect(isRootlessUpdateError(error)).toBe(true);
    expect(error.code).toBe(code);
  });

  it('does not classify an unknown ROOTLESS-prefixed failure as caller input', () => {
    expect(isRootlessUpdateError(Object.assign(
      new Error('internal storage failure'),
      { code: 'ROOTLESS_STORAGE_CORRUPTION' },
    ))).toBe(false);
  });
});
