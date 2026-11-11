import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { OxigraphStore } from '../src/adapters/oxigraph.js';
import { KILL_POINTS, expectReadGraphEqualsMembers, killWriterAt } from './helpers/read-graph-kill-at-commit.js';

describe('a writer killed while a maintained write commits (embedded Oxigraph, persistent)', () => {
  it.each(KILL_POINTS)('leaves the read graph equal to its members after a kill at write $write, $delayMs ms in', async ({ write, delayMs }) => {
    const dir = await mkdtemp(join(tmpdir(), 'read-graph-kill-'));
    const path = join(dir, 'store.nq');
    const contextGraphId = `kill-${randomUUID().slice(0, 8)}`;
    try {
      await killWriterAt({ DKG_KILL_BACKEND: 'oxigraph', DKG_KILL_PATH: path, DKG_KILL_CG: contextGraphId, DKG_KILL_BATCH: '500' }, write, delayMs);
      // The store reopens from the last complete dump, whatever the kill interrupted.
      const reopened = new OxigraphStore(path, { readOnly: true });
      try { await expectReadGraphEqualsMembers(reopened, contextGraphId, `a kill at write ${write}`); } finally { await reopened.close(); }
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 120_000);
});
