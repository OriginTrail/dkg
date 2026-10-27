import { expect, it } from 'vitest';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkpointAgentFixture } from '../../agent/test/helpers/public-checkpoint-agent-fixture.js';
import { checkDaemonCheckpointEligibility } from '../src/daemon/public-checkpoint-config.js';
import { openDaemonCheckpointAgent } from '../src/daemon/public-checkpoint-agent.js';

it('normal daemon composition prepares once, owns native startup, and reopens the same journal', async () => {
  const f = await checkpointAgentFixture();
  const runtime = { java: process.env.DKG_PUBLIC_CHECKPOINT_JAVA!, jar: process.env.DKG_PUBLIC_CHECKPOINT_JAR!,
    jarSha256: process.env.DKG_PUBLIC_CHECKPOINT_JAR_SHA256! };
  const spec = { version: 1 as const, runtime, source: f.sync };
  await mkdir(f.config.dataDir);
  let session: Awaited<ReturnType<typeof openDaemonCheckpointAgent>> | undefined;
  try {
    expect(await checkDaemonCheckpointEligibility(f.config.dataDir, { nodeRole: 'edge', publicSnapshotBootstrap: spec })).toBe('fresh');
    session = await openDaemonCheckpointAgent(f.config, spec, 'fresh', new AbortController().signal);
    await session.agent.start();
    expect(await session.complete()).toMatchObject({ current: true, assets: 3, committed: 3, alreadyPresent: 3 });
    session.dispose(); await session.agent.stop(); session = undefined;
    const marker = join(f.config.dataDir, 'public-checkpoint-edge/checkpoint-store/BOOTSTRAP-COMPLETE.json');
    const original = await readFile(marker, 'utf8');
    expect(await checkDaemonCheckpointEligibility(f.config.dataDir, { nodeRole: 'edge', publicSnapshotBootstrap: spec })).toBe('resume');
    session = await openDaemonCheckpointAgent(f.config, spec, 'resume', new AbortController().signal);
    await session.agent.start();
    expect(await session.complete()).toMatchObject({ current: true, assets: 3, committed: 3, alreadyPresent: 3 });
    expect(await readFile(marker, 'utf8')).toBe(original);
  } finally { session?.dispose(); await session?.agent.stop(); await f.core.stop(); }
}, 30_000);
