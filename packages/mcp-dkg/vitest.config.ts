import { defineConfig } from 'vitest/config';

/**
 * Local test config for @origintrail-official/dkg-mcp.
 *
 * Wave-3 (#23) re-introduces unit-test fixtures for the post-wave-2 tool
 * surface (assertion CRUD quintet, memory-search trust ranking, query
 * schema migration, and the 9 wave-2 P0/P1/P2 adds). The four V9-era
 * test files that wave-2's drop deleted were pinning now-removed
 * surfaces (`dkg_annotate_turn` / `dkg_search` strings, the helpers in
 * the dropped `tools/annotations.ts`); fixtures are shaped against the
 * canonical V10 SKILL.md surface instead.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
