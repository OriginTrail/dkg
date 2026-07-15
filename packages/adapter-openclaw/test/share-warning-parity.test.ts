import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  SHARE_NOT_PUBLISH_READY_WARNING,
  SHARE_SUBSET_NOT_PUBLISH_READY_WARNING,
  SHARE_INCOMPLETE_PROMOTE_WARNING,
  classifyShareWarning,
} from '../src/DkgNodePlugin.js';

// #1116 — the three share-outcome warnings are duplicated byte-identical across
// the MCP, OpenClaw, and Hermes adapters (no shared runtime module — OpenClaw
// cannot import dkg-mcp and a new package is out of scope). This GOLDEN test makes
// drift a test failure, not a stale comment: each adapter asserts its constants
// equal the single canonical fixture at tests/fixtures/share-seal-warnings.json.
const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(resolve(here, '../../../tests/fixtures/share-seal-warnings.json'), 'utf-8'),
) as Record<string, string>;

describe('#1116 share-warning parity (OpenClaw vs canonical fixture)', () => {
  it('SHARE_NOT_PUBLISH_READY_WARNING matches the fixture byte-for-byte', () => {
    expect(SHARE_NOT_PUBLISH_READY_WARNING).toBe(fixture.SHARE_NOT_PUBLISH_READY_WARNING);
    expect(SHARE_NOT_PUBLISH_READY_WARNING).toContain('Keep the Working Memory draft');
    expect(SHARE_NOT_PUBLISH_READY_WARNING).not.toMatch(/pull(?:-|\s)from|pull the asset/i);
  });

  it('SHARE_SUBSET_NOT_PUBLISH_READY_WARNING matches the fixture byte-for-byte', () => {
    expect(SHARE_SUBSET_NOT_PUBLISH_READY_WARNING).toBe(fixture.SHARE_SUBSET_NOT_PUBLISH_READY_WARNING);
  });

  it('SHARE_INCOMPLETE_PROMOTE_WARNING matches the fixture byte-for-byte', () => {
    expect(SHARE_INCOMPLETE_PROMOTE_WARNING).toBe(fixture.SHARE_INCOMPLETE_PROMOTE_WARNING);
  });

  it('classifyShareWarning picks the right warning per outcome', () => {
    expect(classifyShareWarning({ sealed: true, publishReady: true, isSubset: false })).toBeUndefined();
    expect(classifyShareWarning({ publishReady: undefined, isSubset: true })).toBeUndefined();
    expect(classifyShareWarning({ sealed: true, publishReady: false, isSubset: true })).toBe(
      SHARE_INCOMPLETE_PROMOTE_WARNING,
    );
    expect(classifyShareWarning({ sealed: false, publishReady: false, isSubset: true })).toBe(
      SHARE_SUBSET_NOT_PUBLISH_READY_WARNING,
    );
    expect(classifyShareWarning({ sealed: false, publishReady: false, isSubset: false })).toBe(
      SHARE_NOT_PUBLISH_READY_WARNING,
    );
  });
});
