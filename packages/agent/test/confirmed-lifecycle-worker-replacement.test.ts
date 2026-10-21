// SPDX-License-Identifier: Apache-2.0
import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { confirmedLifecycleRecoveryFixture } from './_helpers/confirmed-lifecycle-recovery-fixture.js';

it('retains repair evidence when a real worker dies after acknowledging lifecycle writes, then reapplies durably', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dkg-lifecycle-worker-loss-'));
  const path = join(dir, 'store.nq'), flag = join(dir, 'block-snapshot');
  const { input } = confirmedLifecycleRecoveryFixture();
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [
      '--import', fileURLToPath(new URL('./fixtures/confirmed-lifecycle-snapshot-fault.mjs', import.meta.url)),
      fileURLToPath(new URL('./fixtures/confirmed-lifecycle-worker-replacement.mjs', import.meta.url)),
      JSON.stringify({ ...input, packedKaId: input.packedKaId.toString() }),
    ], { timeout: 60_000, env: { ...process.env,
      DKG_TEST_SNAPSHOT_PATH: path, DKG_TEST_SNAPSHOT_FAULT: flag, DKG_TEST_REPAIR_DIR: join(dir, 'repair'),
    } });
    expect(JSON.parse(stdout.split('\n').find(line => line.startsWith('{'))!)).toEqual({
      acknowledgedThenLost: true, retainedUntilReapplied: true, durableReopen: true, staleBarriersRejected: 2,
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 60_000);

it.each([false, true])('recovers a real named asset after worker loss with newer draft=%s, then reopens and edits it', async newerDraft => {
  const dir = await mkdtemp(join(tmpdir(), 'dkg-lifecycle-payload-loss-'));
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [
      '--import', fileURLToPath(new URL('./fixtures/confirmed-lifecycle-snapshot-fault.mjs', import.meta.url)),
      fileURLToPath(new URL('./fixtures/confirmed-lifecycle-payload-loss.mjs', import.meta.url)),
      newerDraft ? 'newer-draft' : 'lost-named-records',
    ], { timeout: 60_000, env: { ...process.env, DKG_TEST_SNAPSHOT_PATH: join(dir, 'store.nq'),
      DKG_TEST_SNAPSHOT_FAULT: join(dir, 'block'), DKG_TEST_REPAIR_DIR: join(dir, 'repair') } });
    expect(JSON.parse(stdout.split('\n').find(line => line.startsWith('{'))!)).toEqual({
      recoveredOriginalPayload: true, durableBeforeClose: true, unrelatedPreserved: true, namedReopenedAndEdited: true, newerDraftPreserved: newerDraft,
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 60_000);
