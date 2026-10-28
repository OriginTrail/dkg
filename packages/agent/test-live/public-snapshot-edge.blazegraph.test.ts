import { expect, it } from 'vitest';
import { buildNativeSnapshotCheckpoint, nativeCheckpointShaFile } from '../src/snapshot-native-build.js';
import { createFreshPublicCheckpointEdge } from '../src/snapshot-fresh-edge.js';
import { resumePublicCheckpointEdge } from '../src/snapshot-resume-edge.js';
import { checkpointAgentFixture } from '../test/helpers/public-checkpoint-agent-fixture.js';
import { cg } from '../test/helpers/bulk-graph-fixture.js';
import type { DKGAgent } from '../src/dkg-agent.js';

const runtime = { java: process.env.DKG_PUBLIC_CHECKPOINT_JAVA ?? '', jar: process.env.DKG_PUBLIC_CHECKPOINT_JAR ?? '',
  jarSha256: process.env.DKG_PUBLIC_CHECKPOINT_JAR_SHA256 ?? '' };
it('activates a real Edge, imports an inventory addition on restart, and rejects removal before returning an Edge', async () => {
  const f = await checkpointAgentFixture(); let agent: DKGAgent | undefined;
  try {
    f.setInventory(2);
    // Prepare exactly the initial inventory, while the supplier already holds the later addition.
    const prepared = await f.run();
    const signal = AbortSignal.timeout(prepared.manifest.deadline - Date.now());
    const native = await buildNativeSnapshotCheckpoint(prepared, { ...runtime, signal, assertInventoryCurrent: async () => {} });
    const original = await nativeCheckpointShaFile(native.journal);
    const fresh = await createFreshPublicCheckpointEdge({ config: f.config, sync: f.sync, runtime, native, prepared, signal });
    agent = fresh.agent;
    expect(fresh.result).toMatchObject({ current: true, assets: 2, committed: 2, alreadyPresent: 2 });
    await agent.stop(); agent = undefined;
    f.setInventory(3);
    const resumed = await resumePublicCheckpointEdge({ config: f.config, sync: f.sync, runtime, signal }); agent = resumed.agent;
    expect(resumed.result).toMatchObject({ current: true, assets: 3, committed: 3, alreadyPresent: 2 });
    expect(await agent.store.query(`ASK { GRAPH ?g { <urn:entity:3:0> <urn:payload> ?value } }`,
      { signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]) })).toMatchObject({ type: 'boolean', value: true });
    expect(agent.getSubscribedContextGraphs().get(cg)?.subscribed).toBe(true);
    await agent.stop(); agent = undefined;
    f.setInventory(2);
    await expect(resumePublicCheckpointEdge({ config: f.config, sync: f.sync, runtime, signal })).rejects.toThrow('removed');
    expect(await nativeCheckpointShaFile(native.journal)).toBe(original);
  } finally { await agent?.stop(); await f.core.stop(); }
}, 30_000);
