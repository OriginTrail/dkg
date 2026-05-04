import { describe, expect, it } from 'vitest';
import { join, parse } from 'node:path';
import { canonicalPathForCompare } from '../src/state-dir-path.js';

describe('state-dir path helpers', () => {
  it('preserves the first character of a missing root-level path segment', () => {
    const segment = `dkg-missing-root-${Date.now()}`;
    const rootLevelPath = join(parse(process.cwd()).root, segment);

    expect(canonicalPathForCompare(rootLevelPath).toLowerCase()).toBe(
      rootLevelPath.toLowerCase(),
    );
  });
});
