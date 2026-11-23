import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, it } from 'vitest';
import { OxigraphStore } from '../src/adapters/oxigraph.js';
import { KILL_POINTS, expectKillOutcome, expectSomeWriteInterrupted, killWriterAt, type KillOutcome } from './helpers/read-graph-kill-at-commit.js';

describe('a writer killed while a maintained write commits (embedded Oxigraph, persistent)', () => {
  const outcomes: KillOutcome[] = [];
  afterAll(() => { console.log(`kill-at-commit outcomes (embedded oxigraph): ${JSON.stringify(outcomes)}`); });

  it.each(KILL_POINTS)('leaves the store just before or just after write $write, killed $delayMs ms after its $after', async (point) => {
    const dir = await mkdtemp(join(tmpdir(), 'read-graph-kill-'));
    const path = join(dir, 'store.nq');
    const contextGraphId = `kill-${randomUUID().slice(0, 8)}`;
    try {
      const killed = await killWriterAt({ DKG_KILL_BACKEND: 'oxigraph', DKG_KILL_PATH: path, DKG_KILL_CG: contextGraphId, DKG_KILL_BATCH: '500' }, point);
      // The store reopens from its last complete dump, whatever the kill interrupted.
      const reopened = new OxigraphStore(path, { readOnly: true });
      try {
        outcomes.push(await expectKillOutcome(reopened, contextGraphId, killed, 500));
      } finally { await reopened.close(); }
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 120_000);

  it('kills at least one write before the writer sees it return', ({ skip }) => expectSomeWriteInterrupted(outcomes, skip));
});
